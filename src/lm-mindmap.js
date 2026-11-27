#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { Command } = require('commander');
const { D2 } = require('@d2lang/d2');

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
}

class MindMapper {
  constructor(requirementsFolder, outputFolder, warn = message => console.warn(`Warning: ${message}`)) {
    this.warn = warn;
    this.requirements = this.#loadRequirements(requirementsFolder);
    this.outputFolder = outputFolder;
  }

  async createMindmap(filename, { debug = false } = {}) {
    const definition = readJson(filename);
    const resolved = this.#resolveMapping(definition, filename);
    if (!resolved) return;
    const { model, mapping, resource } = resolved;
    const source = this.#renderMindmap(definition, mapping, resource);
    fs.mkdirSync(this.outputFolder, { recursive: true });
    if (debug) fs.writeFileSync(path.join(this.outputFolder, `lm-mindmap-${model}.d2`), source);
    const renderer = new D2();
    try {
      const compiled = await renderer.compile(source, { layout: 'elk' });
      const svg = await renderer.render(compiled.diagram, compiled.renderOptions);
      fs.writeFileSync(path.join(this.outputFolder, `lm-mindmap-${model}.svg`), svg);
    } finally {
      await renderer.dispose();
    }
  }

  #loadRequirements(directory) {
    const resources = new Map();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        for (const [url, resource] of this.#loadRequirements(filename)) resources.set(url, resource);
      } else if (entry.isFile() && /\.json$/i.test(entry.name)) {
        try {
          const resource = readJson(filename);
          if (resource.resourceType === 'Requirements' && resource.url) resources.set(resource.url, resource);
        } catch (error) {
          this.warn(`${filename}: ${error.message}`);
        }
      }
    }
    return resources;
  }

  #renderMindmap(definition, mapping, requirements, warn = this.warn) {
    const elements = definition.snapshot?.element;
    if (!elements?.length || !elements[0].path) throw new Error('StructureDefinition has no snapshot elements');
    const statements = new Map((requirements.statement || []).map(statement => [statement.key, statement]));
    const root = { element: elements[0], children: [] };
    const stack = [root];
    for (const element of elements.slice(1)) {
      if (!element.path) continue;
      while (stack.length > 1 && !element.path.startsWith(`${stack.at(-1).element.path}.`)) stack.pop();
      const node = { element, children: [] };
      stack.at(-1).children.push(node);
      stack.push(node);
    }
    function select(node) {
      node.mappings = (node.element.mapping || []).filter(item => item.identity === mapping.identity);
      node.children = node.children.filter(select);
      return node.mappings.length > 0 || node.children.length > 0;
    }
    select(root);
    const lines = [
      'direction: right', '',
      'classes: {',
      '  element: {',
      '    shape: rectangle',
      '    icon.near: center-right',
      '    label.near: center-left',
      '    width: 320',
      '    height: 72',
      '    style.fill: "#D9EAF7"',
      '    style.stroke: "#7EA6C4"',
      '    style.border-radius: 10',
      '  }',
      '  container: {',
      '    shape: rectangle',
      '    icon.near: center-right',
      '    label.near: center-left',
      '    style.fill: "#D9EAF7"',
      '    style.stroke: "#356A96"',
      '    style.stroke-width: 2',
      '    style.bold: true',
      '  }',
      '}', ''
    ];
    const connections = [];
    const usedIds = new Set();
    const markdownEscape = value => value.replace(/[\\`*_{}\[\]<>|]/g, '\\$&').replace(/[\r\n]/g, ' ');
    function render(node, parentId, left = false) {
      const languages = new Set();
      for (const item of node.mappings) {
        const statement = statements.get(item.map);
        if (!statement) warn(`No Requirements statement with key "${item.map}" for ${node.element.path}`);
        const origin = statement?.label?.match(/^(NL|EU)/)?.[1];
        if (origin) languages.add(origin);
      }
      const name = node.element.path.split('.').at(-1);
      const baseId = name.replace(/[^a-zA-Z0-9]/g, '') || 'element';
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) id = `${baseId}_${suffix++}`;
      usedIds.add(id);
      const types = [...new Set((node.element.type || [])
        .map(type => type.code)
        .filter(Boolean)
        .filter(code => code.toLowerCase() !== 'base')
        .map(code => URL.canParse(code) ? 'Reference' : code))];
      lines.push(`${id}: |md`, `**${markdownEscape(name)}**${types.length ? '  ' : ''}`);
      if (types.length) lines.push(types.map(type => `\`${type.replace(/`/g, '')}\``).join(', '));
      lines.push('| {', `  class: ${types.length ? 'element' : 'container'}`);
      if (!parentId) lines.push('  shape: circle');
      if (languages.size) {
        const icon = languages.size > 1 ? 'eu-nl' : [...languages][0].toLowerCase();
        lines.push(`  icon: ./assets/images/${icon}.png`);
      }
      lines.push('}', '');
      if (parentId) connections.push(left ? `${id} -- ${parentId}` : `${parentId} -- ${id}`);
      for (const [index, child] of node.children.entries()) {
        render(child, id, parentId ? left : index < Math.floor(node.children.length / 2));
      }
    }
    render(root);
    return [...lines, ...connections, ''].join('\n');
  }

  #resolveMapping(definition, filename) {
    if (definition.resourceType !== 'StructureDefinition' || !definition.name?.startsWith('LogicalModel')) return;
    const model = definition.name.slice('LogicalModel'.length);
    if (!model || /[<>:"/\\|?*\x00-\x1f]/.test(model)) throw new Error('Invalid model name for output filename');
    const mapping = definition.mapping?.find(item => item.identity?.startsWith(`requirements-${model}`));
    if (!mapping) return;
    const resource = this.requirements.get(mapping.uri);
    if (!resource) {
      this.warn(`${filename}: Requirements resource not found for ${mapping.uri}`);
      return;
    }
    return { model, mapping, resource };
  }
}

async function main() {
  const program = new Command()
    .name('lm-mindmap')
    .description('Create D2 mindmaps and render SVGs for logical model mappings to Requirements statements.')
    .argument('<structures...>', 'FHIR StructureDefinition JSON files')
    .requiredOption('--requirements <directory>', 'Folder containing Requirements JSON resources (searched recursively)')
    .requiredOption('--output-folder <directory>', 'Folder for generated SVG files')
    .option('--debug', 'Also save the D2 source alongside the SVG')
    .parse();
  const options = program.opts();
  const mapper = new MindMapper(options.requirements, options.outputFolder);
  for (const filename of program.args) {
    await mapper.createMindmap(filename, { debug: options.debug });
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { MindMapper };
