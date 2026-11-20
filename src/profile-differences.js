#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { homedir } = require('node:os');
const { isDeepStrictEqual } = require('node:util');
const commander= require('commander');
const { parsePo, translationFor } = require('./po');

const catalogs = new Map([['en', new Map()]]);
function catalog(language) {
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(language)) throw new Error(`Invalid language code: ${language}`);
  if (!catalogs.has(language)) {
    const filename = path.join(__dirname, 'translations', `${language}.po`);
    if (!fs.existsSync(filename)) throw new Error(`Unsupported report language: ${language}`);
    catalogs.set(language, new Map(parsePo(fs.readFileSync(filename, 'utf8'))
      .filter(entry => entry.msgid && !entry.msgctxt && !entry.comments.some(comment => /^#,.*\bfuzzy\b/.test(comment)))
      .map(entry => [entry.msgid, translationFor(entry) || entry.msgid])));
  }
  return catalogs.get(language);
}
function translator(language) {
  const entries = catalog(language);
  return value => entries.get(value) ?? value;
}

const PROFILE_EXTENSIONS = new Set([
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-imposeProfile',
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-compliesWithProfile',
]);
const ADDITIONAL_BINDING_URL = 'http://hl7.org/fhir/tools/StructureDefinition/additional-binding';
const ADDITIONAL_BINDING_FIELDS = new Set([
  'key', 'purpose', 'valueSet', 'documentation', 'shortDoco', 'usage', 'any',
]);

function readJson(filename) {
  return JSON.parse((fs.readFileSync(filename, 'utf8')).replace(/^\uFEFF/, ''));
}

/**
 * A profile comparison CSV report. Elements contain Difference instances with
 * a key and source/target values, serialized using property-specific Markdown bullets.
 *
 * The first two CSV records each contain one Markdown profile link. The third
 * is a grouping row with profile names and Differential, followed by
 * Element,Differences,Element,Notes. Each subsequent record represents one
 * element, with a multiline Markdown bullet list and a Markdown note.
 */
class ProfileComparisonReport {
  static Difference = class Difference {
    static #labels = new Map([
      ['cardinality', 'Cardinality'],
      ['valueSet', 'ValueSet'],
      ['bindingStrength', 'Binding strength'],
      ['new extension', 'New extension'],
    ]);

    constructor(key, source, target) {
      if (!Difference.#labels.has(key)) throw new Error(`Unsupported report difference: ${key}`);
      if (typeof source !== 'string' || typeof target !== 'string') {
        throw new Error('Difference source and target must be strings');
      }
      if (key === 'cardinality' && ![source, target].every(value => /^\d+\.\.(?:\d+|\*)$/.test(value))) {
        throw new Error('Cardinality differences must use min..max values');
      }
      if (key === 'new extension' && (source !== '' || !target)) {
        throw new Error('New extension differences require an empty source and a sliceName target');
      }
      this.key = key;
      this.source = source;
      this.target = target;
    }

    toMarkdown(language = 'en') {
      const t = translator(language);
      if (this.key === 'new extension') return `* ${t('New extension')}: ${this.target}`;
      return `* ${t(Difference.#labels.get(this.key))}: ${this.source} ${t('versus')} ${this.target}`;
    }

    static fromMarkdown(markdown, language = 'en') {
      const t = translator(language);
      const prefix = `* ${t('New extension')}: `;
      if (markdown.startsWith(prefix)) {
        return new Difference('new extension', '', markdown.slice(prefix.length));
      }
      const parts = /^\* ([^:]+): (.*)$/.exec(markdown);
      const separator = ` ${t('versus')} `;
      const position = parts ? parts[2].indexOf(separator) : -1;
      const match = position < 0 ? null : [markdown, parts[1], parts[2].slice(0, position), parts[2].slice(position + separator.length)];
      const key = match && [...Difference.#labels].find(([, label]) => t(label) === match[1])?.[0];
      if (!key) throw new Error(`Unsupported report difference: ${markdown}`);
      return new Difference(key, match[2], match[3]);
    }
  };

  static ReportElement = class ReportElement {
    constructor(sourcePath, differences = [], note = '', targetPath = sourcePath) {
      if (typeof sourcePath !== 'string' || typeof targetPath !== 'string' || typeof note !== 'string' || !Array.isArray(differences)) {
        throw new Error('Report elements require a string path, an array of differences, and a string note');
      }
      this.sourcePath = sourcePath;
      this.targetPath = targetPath;
      this.differences = [];
      this.note = note;
      for (const difference of differences) {
        if (!(difference instanceof ProfileComparisonReport.Difference)) {
          throw new Error('Report element differences must be Difference instances');
        }
        this.addDifference(difference.key, difference.source, difference.target);
      }
    }

    addDifference(key, source, target) {
      const difference = new ProfileComparisonReport.Difference(key, source, target);
      const existing = this.differences.find(item => item.key === key &&
        (key !== 'new extension' || item.target === target));
      if (existing) {
        if (!isDeepStrictEqual(existing, difference)) {
          throw new Error(`${this.sourcePath}: existing ${key} difference does not match ${source} versus ${target}`);
        }
        return;
      }
      this.differences.push(difference);
    }
  };

  constructor(language = 'en') {
    catalog(language);
    this.language = language;
    this.filePath = null;
    this.profileName = null;
    this.profileCanonical = null;
    this.referencedProfileName = null;
    this.referencedProfileCanonical = null;
    this.elements = [];
  }

  static fromFileIfExists(filePath, language = 'en') {
    const report = new this(language);
    report.filePath = filePath;
    if (fs.existsSync(filePath)) {
      report.load(filePath);
    }
    return report;
  }

  /** Write a UTF-8 CSV file synchronously, replacing any existing file. */
  save(filePath = null) {
    const target = filePath || this.filePath;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, this.toCsv(), 'utf8');
  }

  load(filePath) {
    this.filePath = filePath;
    const csv = fs.readFileSync(filePath, 'utf8');

    const rows = ProfileComparisonReport.#parseCsv(csv.replace(/^\uFEFF/, ''));
    if (rows.length < 4) throw new Error('Report requires two profile links, a grouping row, and a header row');
    [this.profileName, this.profileCanonical] = ProfileComparisonReport.#readLink(rows[0]);
    [this.referencedProfileName, this.referencedProfileCanonical] = ProfileComparisonReport.#readLink(rows[1]);
    if (!isDeepStrictEqual(rows[2], [this.profileName, translator(this.language)('Differential'), this.referencedProfileName, ''])) {
      throw new Error('Expected report grouping header: source profile,Differential,output profile');
    }
    if (!isDeepStrictEqual(rows[3], ['Element', 'Differences', 'Element', 'Notes'].map(translator(this.language)))) {
      throw new Error('Expected report header: Element,Differences,Element,Notes');
    }
    this.elements = rows.slice(4).map((row, index) => {
      if (row.length !== 4) throw new Error(`Report record ${index + 5} must have four columns`);
      const differences = row[1] ? row[1].split(/\r?\n/).map(line => ProfileComparisonReport.Difference.fromMarkdown(line, this.language)) : [];
      return new ProfileComparisonReport.ReportElement(row[0], differences, row[3], row[2]);
    });
  }

  /** Add a property difference once; an existing entry must describe the same values. */
  addDifference(element, property, source, target, targetPath = element) {
    let entry = this.elements.find(item => item.sourcePath === element);
    if (!entry) {
      entry = new ProfileComparisonReport.ReportElement(element, [], '', targetPath);
      entry.addDifference(property, source, target);
      this.elements.push(entry);
      return;
    }
    entry.addDifference(property, source, target);
    entry.targetPath = targetPath;
  }

  toCsv() {
    const rows = [
      [ProfileComparisonReport.#link(this.profileName, this.profileCanonical)],
      [ProfileComparisonReport.#link(this.referencedProfileName, this.referencedProfileCanonical)],
      [this.profileName, translator(this.language)('Differential'), this.referencedProfileName, ''],
      ['Element', 'Differences', 'Element', 'Notes'].map(translator(this.language)),
      ...this.elements.map(({ sourcePath, differences, targetPath, note }) => [
        sourcePath,
        differences.map(difference => difference.toMarkdown(this.language)).join('\n'),
        targetPath,
        note,
      ]),
    ];
    return rows.map(row => row.map(ProfileComparisonReport.#quote).join(',')).join('\r\n') + '\r\n';
  }

  static #link(name, canonical) {
    if (typeof name !== 'string' || typeof canonical !== 'string' || /[\r\n]/.test(name + canonical)) {
      throw new Error('Profile names and canonicals must be single-line strings');
    }
    const escape = value => value.replace(/[\\\[\]()]/g, '\\$&');
    return `[${escape(name)}](${escape(canonical)})`;
  }

  static #readLink(row) {
    const match = row.length === 1 && /^\[((?:\\.|[^\]\\])*)\]\(((?:\\.|[^)\\])*)\)$/.exec(row[0]);
    if (!match) throw new Error('Expected a single Markdown profile link');
    return match.slice(1).map(value => value.replace(/\\([\\\[\]()])/g, '$1'));
  }

  static #quote(value) {
    if (typeof value !== 'string') throw new Error('CSV fields must be strings');
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }

  /** Parse CSV without splitting quoted multiline fields or coercing cell values. */
  static #parseCsv(csv) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let closed = false;
    for (let i = 0; i < csv.length; i++) {
      const char = csv[i];
      if (quoted) {
        if (char !== '"') field += char;
        else if (csv[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else if (char === ',') {
        row.push(field); field = ''; closed = false;
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && csv[i + 1] === '\n') i++;
        row.push(field); rows.push(row);
        row = []; field = ''; closed = false;
      } else if (char === '"' && !field && !closed) {
        quoted = true;
      } else {
        if (closed || char === '"') throw new Error('Invalid quoting in CSV field');
        field += char;
      }
    }
    if (quoted) throw new Error('Unterminated quoted CSV field');
    if (row.length || field || closed) { row.push(field); rows.push(row); }
    return rows;
  }
}

class FhirPackage {
  constructor(ig, cache = path.join(homedir(), '.fhir', 'packages')) {
    this.ig = ig;
    this.cache = cache;
    this.profiles = undefined;
  }

  #load() {
    const { cache, ig } = this;
    const packageDirectory = path.join(cache, ig, 'package');
    const profiles = new Map();
    // Scan the actual resources, so a missing or stale .index.json is harmless.
    for (const entry of fs.readdirSync(packageDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
      const resource = readJson(path.join(packageDirectory, entry.name));
      if (!resource.resourceType || !resource.url) continue;
      const matches = profiles.get(resource.url) || [];
      matches.push(resource);
      profiles.set(resource.url, matches);
    }
    return profiles;
  }

  #find(canonical) {
    const [url, version, ...extra] = canonical.split('|');
    if (!url || extra.length || (version !== undefined && !version)) {
      throw new Error(`Invalid artifact canonical: ${canonical}`);
    }
    const indexFile = path.join(this.cache, this.ig, 'package', '.index.json');
    let candidates;
    if (!this.profiles && fs.existsSync(indexFile)) {
      const index = readJson(indexFile);
      candidates = (index.files || []).filter(file => file.resourceType && file.url === url)
        .map(file => readJson(path.join(this.cache, this.ig, 'package', file.filename)));
    } else {
      this.profiles ??= this.#load();
      candidates = this.profiles.get(url) || [];
    }
    const matches = candidates.filter(profile =>
      version === undefined || profile.version === version);
    return matches;
  }

  /** Resolve a canonical artifact from this package, then cached dependencies in breadth-first order. */
  resolve(canonical) {
    const pending = [this];
    const visited = new Set();
    const missing = [];
    for (let i = 0; i < pending.length; i++) {
      const current = pending[i];
      if (visited.has(current.ig)) continue;
      visited.add(current.ig);
      const directory = path.join(current.cache, current.ig, 'package');
      if (current.profiles || fs.existsSync(directory)) {
        const matches = current.#find(canonical);
        if (matches.length > 1) throw new Error(`Ambiguous artifact ${canonical} in ${current.ig}; found ${matches.length}`);
        if (matches.length === 1) return matches[0];
      }
      const manifest = path.join(current.cache, current.ig, 'package', 'package.json');
      if (!fs.existsSync(manifest)) {
        missing.push(current.ig);
        continue;
      }
      const dependencies = readJson(manifest).dependencies || {};
      for (const [id, version] of Object.entries(dependencies)) {
        pending.push(new FhirPackage(`${id}#${version}`, this.cache));
      }
    }
    throw new Error(`Artifact ${canonical} not found in ${this.ig} or its cached dependencies` +
      (missing.length ? `; missing packages: ${missing.join(', ')}` : ''));
  }
}

class DiffBuilder {
  #definitions = new Map();

  constructor(sourceProfile, fhirPackage, comparisonReport) {
    this.sourceProfile = sourceProfile;
    this.package = fhirPackage;
    this.comparisonReport = comparisonReport;
  }

  rebase() {
    if (this.sourceProfile.resourceType !== 'StructureDefinition') {
      return { skipped: 'not a StructureDefinition' };
    }
    const extensions = (this.sourceProfile.extension || []).filter(extension => PROFILE_EXTENSIONS.has(extension.url));
    if (!extensions.length) {
      return { skipped: 'no imposeProfile or compliesWithProfile extension' };
    }
    if (extensions.some(extension => typeof extension.valueCanonical !== 'string' || !extension.valueCanonical)) {
      throw new Error('Profile extension requires a nonempty valueCanonical');
    }
    const canonicals = [...new Set(extensions.map(extension => extension.valueCanonical))];
    if (canonicals.length !== 1) throw new Error(`Multiple distinct referenced profiles: ${canonicals.join(', ')}`);
    const referenced = this.package.resolve(canonicals[0]);

    if (this.comparisonReport) {
      this.comparisonReport.profileName = this.sourceProfile.name;
      this.comparisonReport.profileCanonical = this.sourceProfile.url;
      this.comparisonReport.referencedProfileName = referenced.name;
      this.comparisonReport.referencedProfileCanonical = referenced.url;
    }

    const result = this.#createDifferential(referenced);
    result.output.baseDefinition = canonicals[0];
    return result;
  }

  #snapshotIndex(profile) {
    if (!Array.isArray(profile.snapshot?.element) || !profile.snapshot.element.length) {
      throw new Error(`${profile.url || profile.id}: missing snapshot.element`);
    }
    const index = new Map();
    for (const element of profile.snapshot.element) {
      if (!element.id || !element.path) {
        throw new Error(`${profile.url || profile.id}: snapshot element requires id and path`);
      }
      if (index.has(element.id)) throw new Error(`Duplicate element id: ${element.id}`);
      index.set(element.id, element);
    }
    return index;
  }

  #sliceBaseId(id) {
    const colon = id.lastIndexOf(':');
    if (colon === -1) return undefined;
    const end = id.indexOf('.', colon);
    const sliceEnd = end === -1 ? id.length : end;
    const slash = id.lastIndexOf('/', sliceEnd - 1);
    const cut = slash > colon ? slash : colon;
    return id.slice(0, cut) + id.slice(sliceEnd);
  }

  #sliceBaseline(id, sourceElements, referenceElements) {
    let baseId = this.#sliceBaseId(id);
    while (baseId) {
      if (referenceElements.has(baseId)) {
        return sourceElements.get(baseId) || referenceElements.get(baseId);
      }
      baseId = this.#sliceBaseId(baseId);
    }
    return undefined;
  }

  /**
   * Add slicing definitions needed by a new slice or an element within it.
   * Walks sliced ID segments and their reslice bases to find the input elements
   * that declare slicing. Each base is compared with the same reference ID,
   * falling back to an unsliced reference ancestor when necessary.
   *
   * Discriminators match when their ordered type/path pairs match. If the input
   * declares discriminators that differ from the reference or are absent there,
   * copy its complete slicing definition into the base element's differential
   * entry. Existing changes are preserved, and sliceName is retained for bases
   * that are themselves slices. Bases without discriminators are left alone.
   *
   * @param {object} element New slice element or one of its descendants.
   * @param {Map<string, object>} sourceElements Input snapshot elements by ID.
   * @param {Map<string, object>} referenceElements Reference snapshot elements by ID.
   * @param {Map<string, object>} changes Differential entries by ID; modified in place.
   * @returns {void}
   */
  #addSlicing(element, sourceElements, referenceElements, changes) {
    const parts = element.id.split('.');
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i].includes(':')) continue;
      let sliceId = parts.slice(0, i + 1).join('.');
      while (sliceId) {
        const baseId = this.#sliceBaseId(sliceId);
        if (!baseId) break;
        const base = sourceElements.get(baseId);
        const reference = referenceElements.get(baseId) ||
          this.#sliceBaseline(baseId, referenceElements, referenceElements);
        const discriminators = base?.slicing?.discriminator;
        const matches = discriminators?.length === reference?.slicing?.discriminator?.length &&
          discriminators?.every((item, index) => {
            const other = reference.slicing.discriminator[index];
            return item.type === other.type && item.path === other.path;
          });
        if (discriminators && !matches) {
          const change = changes.get(baseId) || { id: baseId, path: base.path };
          if (base.sliceName !== undefined) change.sliceName = base.sliceName;
          change.slicing = structuredClone(base.slicing);
          changes.set(baseId, change);
        }
        sliceId = baseId;
      }
    }
  }

  #valueSetsMatch(value, baselineValue) {
    const [url, version] = value?.split('|') || [];
    const [baselineUrl, baselineVersion] = baselineValue?.split('|') || [];
    return url === baselineUrl && (!version || !baselineVersion || version === baselineVersion);
  }

  #additionalBindings(binding, baseline) {
    const extensions = (binding?.extension || []).filter(item => item.url === ADDITIONAL_BINDING_URL);
    const reference = (baseline?.extension || []).filter(item => item.url === ADDITIONAL_BINDING_URL);
    const field = (extension, name) => extension.extension?.find(item => item.url === name);
    return extensions.filter(extension => !reference.some(other =>
      field(extension, 'purpose')?.valueCode === field(other, 'purpose')?.valueCode &&
      this.#valueSetsMatch(field(extension, 'valueSet')?.valueCanonical, field(other, 'valueSet')?.valueCanonical)
    )).map(extension => ({
      url: ADDITIONAL_BINDING_URL,
      extension: structuredClone((extension.extension || []).filter(item => ADDITIONAL_BINDING_FIELDS.has(item.url))),
    }));
  }

  #typeProperties(types) {
    return types?.map(type => {
      const result = { code: type.code };
      for (const key of ['profile', 'targetProfile']) {
        if (type[key]?.length) result[key] = [...type[key]];
      }
      return result;
    });
  }

  #typesMatch(types, baselineTypes) {
    const normalize = list => (this.#typeProperties(list) || []).map(type => {
      for (const key of ['profile', 'targetProfile']) type[key]?.sort();
      return JSON.stringify(type);
    }).sort();
    return isDeepStrictEqual(normalize(types), normalize(baselineTypes));
  }

  /**
   * Match snapshot extension and modifierExtension slices to elements in the
   * referenced profile.
   * This examines element definitions, not their metadata extension arrays.
   *
   * Matches require the same parent, sliceName, and a shared canonical URL,
   * regardless of snapshot order. URLs come from type.profile or a .url child's
   * fixedUri, fixedUrl, patternUri, or patternUrl; canonical versions are ignored.
   * Parents are processed first so nested extensions use the matched reference
   * parent. Children of an unmatched extension are also treated as unmatched.
   *
   * The returned map includes every source extension slice ID. Its value is the
   * matching reference element, or undefined when the extension is new. Callers
   * use these roots to resolve child elements and decide between comparing
   * differences and resolving a separate extension definition as the baseline.
   *
   * @param {Map<string, object>} sourceElements Input snapshot elements by ID.
   * @param {Map<string, object>} referenceElements Reference snapshot elements by ID.
   * @returns {Map<string, object|undefined>} Source slice IDs and their reference matches.
   * @throws {Error} If more than one reference slice matches a source slice.
   */
  #matchingElementsForExtensionElements(sourceElements, referenceElements) {
    const isExtension = element => element.sliceName !== undefined && /\.(modifierExtension|extension)$/.test(element.path);
    const canonical = (element, elements) => {
      const profiles = element.type?.filter(type => type.code === 'Extension').flatMap(type => type.profile || []) || [];
      const url = elements.get(`${element.id}.url`);
      return [...profiles, url?.fixedUri, url?.fixedUrl, url?.patternUri, url?.patternUrl]
        .filter(Boolean).map(value => value.split('|')[0]);
    };
    const roots = [...sourceElements.values()].filter(isExtension).sort((a, b) => a.id.length - b.id.length);
    const referenceRoots = [...referenceElements.values()].filter(isExtension);
    const contexts = new Map();
    for (const root of roots) {
      const ancestor = [...contexts.keys()].reverse().find(id => root.id.startsWith(`${id}.`));
      const parentReference = ancestor ? contexts.get(ancestor) : undefined;
      const baseId = this.#sliceBaseId(root.id);
      const referenceBaseId = ancestor && parentReference
        ? parentReference.id + baseId.slice(ancestor.length) : baseId;
      const urls = canonical(root, sourceElements);
      const matches = ancestor && !parentReference ? [] : referenceRoots.filter(candidate =>
        this.#sliceBaseId(candidate.id) === referenceBaseId && candidate.sliceName === root.sliceName &&
        canonical(candidate, referenceElements).some(url => urls.includes(url)));
      if (matches.length > 1) throw new Error(`Ambiguous extension match for ${root.id}`);
      contexts.set(root.id, matches[0]);
    }
    return contexts;
  }

  /** Lazily resolve a context's definition, sharing enclosing snapshots for local components. */
  #extensionDefinition(context) {
    if (context.definition) return context.definition;
    const profile = context.element.type?.find(type => type.code === 'Extension')?.profile?.[0];
    if (!profile && context.parent) {
      const parent = this.#extensionDefinition(context.parent);
      context.definition = { elements: parent.elements,
        rootId: parent.rootId + context.root.slice(context.parent.root.length) };
    } else {
      const canonical = profile || 'http://hl7.org/fhir/StructureDefinition/Extension';
      if (!this.#definitions.has(canonical)) {
        this.#definitions.set(canonical, this.#snapshotIndex(this.package.resolve(canonical)));
      }
      const elements = this.#definitions.get(canonical);
      context.definition = { elements, rootId: elements.keys().next().value };
    }
    return context.definition;
  }

  /** Prefer the reference snapshot; consult the cached definition only for missing elements. */
  #extensionComparison(context, id, referenceElements) {
    const reference = context.referenceRoot &&
      referenceElements.get(context.referenceRoot.id + id.slice(context.root.length));
    if (reference) return { baseline: reference, reference };
    const { elements, rootId } = this.#extensionDefinition(context);
    const baseId = rootId + id.slice(context.root.length);
    return { baseline: elements.get(baseId) || this.#sliceBaseline(baseId, elements, elements) };
  }

  #elementDifferential(element, referenceElement, { skipType = false, declareSlice = false, reportDifferences = true } = {}) {
    const { id } = element;
    const diffElement = { id, path: element.path };
    for (const key of ['min', 'max']) {
      if (element[key] === undefined || referenceElement[key] === undefined) {
        throw new Error(`${id}: ${key} is missing from an input or referenced snapshot`);
      }
      if (element[key] !== referenceElement[key]) diffElement[key] = element[key];
    }
    if (reportDifferences && ('min' in diffElement || 'max' in diffElement)) {
      this.comparisonReport?.addDifference(id, 'cardinality',
        `${element.min}..${element.max}`, `${referenceElement.min}..${referenceElement.max}`, referenceElement.id || referenceElement.path);
    }

    const binding = {};
    for (const key of ['valueSet', 'strength']) {
      const value = element.binding?.[key];
      const referenceValue = referenceElement.binding?.[key];
      let matches = value === referenceValue;
      if (key === 'valueSet') {
        matches = this.#valueSetsMatch(value, referenceValue);
      }
      if (value !== undefined && !matches) {
        binding[key] = value;
        if (reportDifferences) {
          this.comparisonReport?.addDifference(id, key === 'valueSet' ? 'valueSet' : 'bindingStrength',
            value, referenceValue ?? '', referenceElement.id || referenceElement.path);
        }
      }
    }

    const additionalBindings = this.#additionalBindings(element.binding, referenceElement.binding);
    if (additionalBindings.length) binding.extension = additionalBindings;
    if (Object.keys(binding).length) {
      binding.strength = element.binding?.strength ?? referenceElement.binding?.strength;
      if (binding.strength === undefined) throw new Error(`${id}: binding.strength is required`);
      diffElement.binding = binding;
    }
    if (element.comment !== undefined && element.comment !== referenceElement.comment) {
      diffElement.comment = element.comment;
    }

    const sliceConstraints = Object.keys(element).filter(key =>
      (id.includes(':') && /^(fixed|pattern)[A-Z]/.test(key)) || /^value(?:[A-Z]|\[x\])/.test(key));
    for (const key of sliceConstraints) {
      if (!isDeepStrictEqual(element[key], referenceElement[key])) {
        diffElement[key] = structuredClone(element[key]);
      }
    }
    if (id.includes(':') && element.type !== undefined &&
        !skipType && !this.#typesMatch(element.type, referenceElement.type)) {
      diffElement.type = this.#typeProperties(element.type);
    }
    if ('min' in diffElement || 'max' in diffElement || 'binding' in diffElement || 'comment' in diffElement ||
        'slicing' in diffElement || 'type' in diffElement || sliceConstraints.some(key => key in diffElement) ||
        declareSlice) {
      if (element.sliceName !== undefined) diffElement.sliceName = element.sliceName;
      return diffElement;
    }
    return undefined;
  }

  /** Compare a complete extension before the main snapshot walk. */
  #extensionDifferential(extensionRoot, sourceElements, referenceElements, unmatched, slicingChanges) {
    const contains = id => id === extensionRoot || id.startsWith(`${extensionRoot}.`);
    const extensionElements = new Map([...sourceElements].filter(([id]) => contains(id)));
    const matches = this.#matchingElementsForExtensionElements(extensionElements, referenceElements);
    const contexts = [];
    for (const [root, referenceRoot] of matches) {
      const parent = contexts.findLast(context => root.startsWith(`${context.root}.`));
      contexts.push({ root, referenceRoot, parent, element: extensionElements.get(root) });
    }
    const newExtensions = [];
    for (const context of contexts) {
      if (context.referenceRoot || newExtensions.some(root => context.root.startsWith(`${root}.`))) continue;
      // Local components belong to the enclosing definition even when the reference does not expand them.
      if (context.parent && !context.element.type?.some(type => type.code === 'Extension' && type.profile?.length)) continue;
      newExtensions.push(context.root);
      this.comparisonReport?.addDifference(context.root.slice(0, context.root.lastIndexOf('.')),
        'new extension', '', context.element.sliceName);
    }
    const changes = new Map();
    for (const [id, element] of extensionElements) {
      const owner = contexts.findLast(item => id === item.root || id.startsWith(`${item.root}.`));
      const { baseline, reference } = this.#extensionComparison(owner, id, referenceElements);
      if (!baseline) {
        unmatched.push(id);
        continue;
      }
      const change = this.#elementDifferential(element, baseline, {
        skipType: id === owner.root && !reference,
        reportDifferences: !newExtensions.some(root => id === root || id.startsWith(`${root}.`)),
      });
      if (change) changes.set(id, change);
    }
    // Populate roots only after real changes have been found, working from children to parents.
    for (const owner of [...contexts].reverse()) {
      const root = owner.root;
      if (!contains(root) || ![...changes.keys()].some(id => id === root || id.startsWith(`${root}.`))) continue;
      const element = owner.element;
      const change = changes.get(root) || { id: root, path: element.path };
      change.sliceName = element.sliceName;
      change.type = this.#typeProperties(element.type) || [{ code: 'Extension' }];
      const url = sourceElements.get(`${root}.url`);
      const canonical = url?.fixedUri || url?.fixedUrl || url?.patternUri || url?.patternUrl;
      const type = change.type.find(item => item.code === 'Extension');
      if (type && !type.profile?.length && canonical && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(canonical)) {
        type.profile = [canonical];
      }
      changes.set(root, change);
      if (!owner.referenceRoot) this.#addSlicing(element, sourceElements, referenceElements, changes);
    }
    for (const [id, change] of changes) {
      if (!contains(id)) slicingChanges.set(id, { ...slicingChanges.get(id), ...change });
    }
    return [...sourceElements.keys()].filter(id => contains(id) && changes.has(id)).map(id => changes.get(id));
  }

  /**
   * Build a differential for this.input against the referenced profile snapshot.
   * Copies metadata preceding snapshot, removes imposeProfile/compliesWithProfile
   * extensions, and replaces the original snapshot and differential.
   *
   * Ordinary elements match by ID. New slices and their children fall back to
   * their unsliced input element when a corresponding reference base exists.
   * Extension slices instead match by canonical URL, slice name, and parent;
   * missing extension elements use the extension definition snapshot resolved
   * from the selected package or its cached dependencies. Local components of
   * complex extensions use slices within the enclosing extension definition.
   * Only standalone inline extensions fall back to the core Extension definition.
   * Each extension is retained as a group only if a supported property differs.
   * Nonempty groups include their root path, sliceName, and type; unchanged root
   * declarations alone do not cause a group to be emitted.
   *
   * Compares min, max, comment, binding valueSet/strength, additional bindings,
   * and value-prefixed properties. Within slices, also compares fixed- and
   * pattern-prefixed properties and type
   * code/profile/targetProfile. Includes differing slicing definitions needed
   * for new slices and retains new slice declarations even without other changes.
   * Metadata extensions on elements, such as obligations, are excluded.
   *
   * Results follow input snapshot order. Elements without a reference match or
   * supported slice base are reported as unmatched rather than emitted.
   *
   * @param {object} referenced StructureDefinition containing the reference snapshot.
   * @returns {{output: object, unmatched: string[], referencedProfileName: string|undefined}}
   *   The resulting StructureDefinition, skipped element IDs, and reference name.
   * @throws {Error} For invalid snapshots, ambiguous extension matches, or missing cardinalities.
   */
  #createDifferential(referenced) {
    const input = this.sourceProfile;
    const sourceElements = this.#snapshotIndex(input);
    const referenceElements = this.#snapshotIndex(referenced);

    const unmatched = [];
    const changes = new Map();
    
    // Build differentials for extensions
    const extensionDifferentials = new Map();
    const extensionRoots = [];
    const extensionElements = [...sourceElements.values()]
      .filter(element => element.sliceName !== undefined && /\.(modifierExtension|extension)$/.test(element.path))
      .sort((a, b) => a.id.length - b.id.length);
    for (const element of extensionElements) {
      if (extensionRoots.some(root => element.id.startsWith(`${root}.`))) continue;
      extensionRoots.push(element.id);
    }
    for (const root of extensionRoots) {
      extensionDifferentials.set(root, this.#extensionDifferential(
        root, sourceElements, referenceElements, unmatched, changes));
    }

    // Create new profile based on source metadata, skipping the compliesWith or imposeProfile
    // extensions, and with an empty differential to start with.
    const output = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === 'snapshot') break;
      if (key !== 'differential') output[key] = value;
    }
    if (output.extension) {
      output.extension = output.extension.filter(extension => !PROFILE_EXTENSIONS.has(extension.url));
      if (!output.extension.length) delete output.extension;
    }
    output.differential = { element: [] };

    // Slicing declarations must be known before their base element is emitted.
    for (const [id, element] of sourceElements) {
      if (!referenceElements.has(id) && id.includes(':') &&
          !extensionRoots.some(root => id === root || id.startsWith(`${root}.`))) {
        this.#addSlicing(element, sourceElements, referenceElements, changes);
      }
    }
    // Insert each prebuilt extension once; its remaining snapshot elements are skipped.
    for (const [id, element] of sourceElements) {
      const extension = extensionRoots.find(root => id === root || id.startsWith(`${root}.`));
      if (extension) {
        if (id === extension) output.differential.element.push(...extensionDifferentials.get(id));
        continue;
      }
      const baseline = referenceElements.get(id) || this.#sliceBaseline(id, sourceElements, referenceElements);
      if (!baseline) {
        unmatched.push(id);
        continue;
      }
      const isNew = !referenceElements.has(id);
      const change = this.#elementDifferential(element, baseline, {
        declareSlice: isNew && element.sliceName !== undefined,
      });
      if (change) changes.set(id, { ...changes.get(id), ...change });
      if (changes.has(id)) output.differential.element.push(changes.get(id));
    }
    return { output, unmatched, referencedProfileName: referenced.name || referenced.id || referenced.url };
  }
}

function inputFiles(inputs) {
  const files = new Set();
  for (const input of inputs) {
    const absolute = path.resolve(input);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.json')) files.add(path.join(absolute, entry.name));
      }
    } else {
      files.add(absolute);
    }
  }
  return [...files].sort();
}

function run(inputs, options) {
  const rebasedProfiles = options.rebasedProfiles ? path.resolve(options.rebasedProfiles) : undefined;
  const csvReports = options.csvReports ? path.resolve(options.csvReports) : undefined;
  const languages = [...new Set(options.languages || ['en'])];
  languages.forEach(catalog);
  const fhirPackage = new FhirPackage(options.ig, options.cache);
  let written = 0;
  const destinations = new Set();
  for (const filename of inputFiles(inputs)) {
    try {
      const input = readJson(filename);
      const reports = [];
      let report = null;
      if (csvReports) {
        for (const language of languages) {
          const target = path.join(csvReports, `${path.parse(filename).name}-${language}.csv`);
          const existing = ProfileComparisonReport.fromFileIfExists(target, language);
          const legacy = path.join(csvReports, `${path.parse(filename).name}.csv`);
          if (language === 'en' && !fs.existsSync(target) && fs.existsSync(legacy)) {
            existing.load(legacy);
            existing.filePath = target;
          }
          reports.push(existing);
        }
        report = reports[0];
      }
      const diffBuilder = new DiffBuilder(input, fhirPackage, report);
      const result = diffBuilder.rebase();

      if (result.skipped) {
        console.log(`- Skipped ${path.basename(filename)}: ${result.skipped}`);
        continue;
      }
      const { output, unmatched, referencedProfileName } = result;
      if (rebasedProfiles) {
        const target = path.join(rebasedProfiles, path.basename(filename));
        if (target === filename) throw new Error('Output would overwrite the input profile');
        if (destinations.has(target)) throw new Error(`Duplicate output filename: ${target}`);
        destinations.add(target);
        fs.mkdirSync(rebasedProfiles, { recursive: true });
        fs.writeFileSync(target, JSON.stringify(output, null, 2) + '\n');
        written++;
      }
      if (csvReports) {
        for (const localized of reports) {
          if (localized !== report) new DiffBuilder(input, fhirPackage, localized).rebase();
          localized.save();
        }
      }

      const skipped = unmatched.length
        ? `; skipped ${unmatched.length} elements not present in ${referencedProfileName}:\n${unmatched.map(id => `  - ${id}`).join('\n')}`
        : '';
      console.log(`- Rebased ${path.basename(filename)} (${output.differential.element.length} changed elements)${skipped}`);
    } catch (error) {
      console.error(`- Skipped ${path.basename(filename)}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`Wrote ${written} profile(s).`);
}

if (require.main === module) {
  commander.program
    .name('profile-differences')
    .description('Find differences for profiles and the profiles they claim an imposeProfile or compliesWithProfile relationship to.')
    .argument('<profiles...>', 'JSON files or directories containing JSON profiles (nonrecursive). These must contain a snapshot.')
    .requiredOption('--ig <package-id#version>', 'Installed FHIR package containing the referenced profiles', value => {
      if (!/^[^#\\/]+#[^#\\/]+$/.test(value) || value.includes('..')) {
        throw new commander.InvalidArgumentError('Expected <package-id>#<version>, e.g. hl7.fhir.eu.eps#1.0.0-ballot');
      }
      return value;
    })
    .option('--languages <languages...>', 'Report languages (built in: en, nl)', ['en'])
    .option('--cache <directory>', 'FHIR package cache', path.join(homedir(), '.fhir', 'packages'))
    .option('--rebasedProfiles <directory>', 'When given, create rebased profiles (af if their base definition was the related profile) in the specified directory.')
    .option('--csvReports <directory>', 'When given, create difference reports in CSV format in the specified directory. Existing CSV files will be overwritten, but manually added notes in the "Notes" column are retained.')
    .hook('preAction', command => {
      const options = command.opts();
      if (!options.rebasedProfiles && !options.csvReports) {
        command.error('At least one of --rebasedProfiles or --csvReports is required.');
      }
    })
    .action(run);
  commander.program.parse();
}

module.exports = { DiffBuilder, FhirPackage, ProfileComparisonReport };
