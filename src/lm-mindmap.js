#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { Command } = require('commander');

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
}

class MindMapper {
  constructor(requirementsFolder, outputFolder, warn = message => console.warn(`Warning: ${message}`)) {
    this.warn = warn;
    this.requirements = this.#loadRequirements(requirementsFolder);
    this.outputFolder = outputFolder;
  }

  createMindmap(filename) {
    const definition = readJson(filename);
    const resolved = this.#resolveMapping(definition, filename);
    if (!resolved) return;
    const { model, mapping, resource } = resolved;
    const markdown = this.#renderMindmap(definition, mapping, resource);
    fs.mkdirSync(this.outputFolder, { recursive: true });
    fs.writeFileSync(path.join(this.outputFolder, `lm-mindmap-${model}.md`), markdown);
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
    const lines = ['```mermaid', 'mindmap'];
    function render(node, depth) {
      const languages = new Set();
      for (const item of node.mappings) {
        const statement = statements.get(item.map);
        if (!statement) warn(`No Requirements statement with key "${item.map}" for ${node.element.path}`);
        const origin = statement?.label?.match(/^(NL|EU)/)?.[1];
        if (origin) languages.add(origin);
      }
      const label = [node.element.path.split('.').at(-1), ...[...languages].map(language => `(${language})`)].join(' ');
      // Quoted labels keep punctuation in paths and language suffixes out of Mermaid syntax.
      const escaped = label.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\r\n]/g, ' ');
      const id = node.element.path.split('.').at(-1).replace(/[^a-zA-Z0-9]/g, '');
      lines.push(`${'  '.repeat(depth + 1)}${id}["${escaped}"]`);
      for (const child of node.children) render(child, depth + 1);
    }
    render(root, 0);
    return [...lines, '```', ''].join('\n');
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

function main() {
  const program = new Command()
    .name('lm-mindmap')
    .description('Create Mermaid mindmaps of logical model mappings to Requirements statements.')
    .argument('<structures...>', 'FHIR StructureDefinition JSON files')
    .requiredOption('--requirements <directory>', 'Folder containing Requirements JSON resources (searched recursively)')
    .requiredOption('--output-folder <directory>', 'Folder for generated Markdown files')
    .parse();
  const options = program.opts();
  const mapper = new MindMapper(options.requirements, options.outputFolder);
  for (const filename of program.args) {
    mapper.createMindmap(filename);
  }
}

if (require.main === module) {
  main();
}

module.exports = { MindMapper };
