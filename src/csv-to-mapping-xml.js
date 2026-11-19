#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { Command } = require('commander');
const { parseSushiYaml } = require('./ig-config');

// Read logical CSV records, including quoted newlines and escaped quotes.
class CsvParser {
  static parse(text) {
    const records = [];
    let row = [], cell = '', quoted = false, closed = false;
    text = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') { quoted = false; closed = true; }
        else cell += ch;
      } else if (ch === ',' || ch === '\n' || ch === '\r') {
        row.push(cell); cell = ''; closed = false;
        if (ch !== ',') {
          if (ch === '\r' && text[i + 1] === '\n') i++;
          records.push(row); row = [];
        }
      } else if (ch === '"' && cell === '' && !closed) quoted = true;
      else {
        if (closed || ch === '"') throw new Error('Invalid CSV quoting');
        cell += ch;
      }
    }
    if (quoted) throw new Error('Unterminated quoted CSV field');
    if (cell !== '' || row.length || closed) records.push([...row, cell]);
    return records;
  }
}

function escapeXml(value) {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(value)) {
    throw new Error('Input contains characters forbidden in XML');
  }
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

class MappingArtifact {
  constructor(row, label, canonicalBase) {
    const match = row?.[0]?.trim().match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (!match || row.slice(1).some(value => value.trim())) {
      throw new Error(`${label} record must contain one Markdown artifact link`);
    }
    const [, name, url] = match;
    if (/[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) {
      throw new Error(`${label} artifact name cannot be used in a filename: ${name}`);
    }
    this.name = name;
    this.url = url;
    this.canonicalBase = canonicalBase;
  }

  get href() {
    if (this.canonicalBase && this.url.startsWith(this.canonicalBase)) {
      const id = this.url.split('#')[0].split('/').pop();
      return `StructureDefinition-${id}.html`;
    } else {
      return this.url;
    }
  }

}

class MappingXML {
  constructor(source, target, headers, rows) {
    if (!headers?.length || headers.some(header => !header.trim())) throw new Error('Missing column headers');
    rows.forEach((row, index) => {
      if (row.length !== headers.length) throw new Error(`Data record ${index + 1}: expected ${headers.length} columns, got ${row.length}`);
    });
    this.source = source;
    this.target = target;
    this.headers = headers;
    this.rows = rows;
  }

  static fromCsv(text, canonicalBase = parseSushiYaml().canonicalBase) {
    const records = CsvParser.parse(text);
    return new MappingXML(
      new MappingArtifact(records[0], 'Source', canonicalBase),
      new MappingArtifact(records[1], 'Target', canonicalBase),
      records[2],
      records.slice(3).filter(row => row.some(value => value.trim()))
    );
  }

  get filename() {
    return `map-${this.source.name}-${this.target.name}.xml`;
  }

  renderCell(value) {
    const lines = value.replace(/\r\n?/g, '\n').split('\n');
    const result = [];
    let inList = false;
    for (const line of lines) {
      const bullet = line.match(/^\s*[*-]\s+(.*)$/);
      if (bullet) {
        if (!inList) result.push('<ul>');
        result.push(`<li>${escapeXml(bullet[1])}</li>`);
        inList = true;
      } else {
        if (inList) result.push('</ul>');
        else if (result.length) result.push('<br />');
        inList = false;
        result.push(escapeXml(line));
      }
    }
    if (inList) result.push('</ul>');
    return result.join('');
  }

  #renderCellContent(value, column) {
    if (this.headers[column].trim() === 'Element' && value.trim()) {
      const href = this.source.href.split('#')[0] + '#' + encodeURI(value.trim());
      return `<a href="${escapeXml(href)}">${escapeXml(value)}</a>`;
    } else {
      return this.renderCell(value);
    }
  }

  toXml() {
    const { source, target, headers, rows } = this;
    const title = escapeXml(`${source.name} → ${target.name}`);
    const body = rows.map(row => {
      return '          <tr>' + row.map((value, column) => `<td>${this.#renderCellContent(value, column)}</td>`).join('') + '</tr>';
    }).join('\n');
    return `<?xml version="1.0" encoding="utf-8"?>
<div xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta http-equiv="Content-Type" content="application/xhtml+xml; charset=UTF-8" />
    <title>${title}</title>
  </head>
  <body>
    <h3>${title}</h3>
    <div class="table-wrap">
      <strong>Mapping Context</strong>
      <ul>
        <li><strong>Source artifact:</strong> <a href="${escapeXml(source.href)}">${escapeXml(source.name)}</a></li>
        <li><strong>Target artifact:</strong> <a href="${escapeXml(target.href)}">${escapeXml(target.name)}</a></li>
      </ul>
    </div>
    <div class="table-wrap">
      <table summary="${title}">
        <caption>${title}</caption>
        <thead><tr>${headers.map(header => `<th>${escapeXml(header)}</th>`).join('')}</tr></thead>
        <tbody>
${body}
        </tbody>
      </table>
    </div>
  </body>
</div>
`;
  }
}

class MappingGenerator {
  constructor(inputFolder, outputFolder) {
    this.inputFolder = inputFolder;
    this.outputFolder = outputFolder;
  }

  generate() {
    const { inputFolder, outputFolder } = this;
    const { canonicalBase } = parseSushiYaml();
    const files = fs.readdirSync(inputFolder, { withFileTypes: true })
      .filter(entry => entry.isFile() && /\.csv$/i.test(entry.name)).map(entry => entry.name).sort();
    // Validate all files and output names before writing anything.
    const outputs = new Map();
    for (const file of files) {
      try {
        const mapping = MappingXML.fromCsv(fs.readFileSync(path.join(inputFolder, file), 'utf8'), canonicalBase);
        const key = mapping.filename.toLowerCase();
        if (outputs.has(key)) throw new Error(`Duplicate output ${mapping.filename} (also produced by ${outputs.get(key).file})`);
        outputs.set(key, { filename: mapping.filename, xml: mapping.toXml(), file });
      } catch (error) { throw new Error(`${file}: ${error.message}`); }
    }
    fs.mkdirSync(outputFolder, { recursive: true });
    for (const mapping of outputs.values()) fs.writeFileSync(path.join(outputFolder, mapping.filename), mapping.xml, 'utf8');
    return outputs.size;
  }
}

if (require.main === module) {
  new Command().name('csv-to-mapping-xml').description('Create XHTML mapping tables from CSV files.')
    .argument('<inputFolder>', 'Folder containing CSV files (nonrecursive)')
    .argument('<outputFolder>', 'Destination for mapping XML files')
    .action((inputFolder, outputFolder) => {
      try { console.log(`Created ${new MappingGenerator(inputFolder, outputFolder).generate()} mapping file(s).`); }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    }).parse();
}

module.exports = { CsvParser, MappingArtifact, MappingTable: MappingXML, MappingGenerator };
