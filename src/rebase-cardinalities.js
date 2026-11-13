#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { homedir } = require('node:os');
const { isDeepStrictEqual } = require('node:util');
const commander= require('commander');

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

class ProfileCardinalityRebaser {
  constructor(input, fhirPackage) {
    this.input = input;
    this.package = fhirPackage;
  }

  rebase() {
    if (this.input.resourceType !== 'StructureDefinition') {
      return { skipped: 'not a StructureDefinition' };
    }
    const extensions = (this.input.extension || []).filter(extension => PROFILE_EXTENSIONS.has(extension.url));
    if (!extensions.length) {
      return { skipped: 'no imposeProfile or compliesWithProfile extension' };
    }
    if (extensions.some(extension => typeof extension.valueCanonical !== 'string' || !extension.valueCanonical)) {
      throw new Error('Profile extension requires a nonempty valueCanonical');
    }
    const canonicals = [...new Set(extensions.map(extension => extension.valueCanonical))];
    if (canonicals.length !== 1) throw new Error(`Multiple distinct referenced profiles: ${canonicals.join(', ')}`);
    const referenced = this.package.resolve(canonicals[0]);
    return this.#createDifferential(referenced);
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
   * Match snapshot extension and modifierExtension slices to reference slices.
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
  #extensionContexts(sourceElements, referenceElements) {
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

  /**
   * Build a differential for this.input against the referenced profile snapshot.
   * Copies metadata preceding snapshot, removes imposeProfile/compliesWithProfile
   * extensions, and replaces the original snapshot and differential.
   *
   * Ordinary elements match by ID. New slices and their children fall back to
   * their unsliced input element when a corresponding reference base exists.
   * Extension slices instead match by canonical URL, slice name, and parent;
   * missing extension elements use the extension definition snapshot resolved
   * from the selected package or its cached dependencies. Inline extensions
   * without a type profile use the core Extension definition.
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
    const input = this.input;
    const sourceElements = this.#snapshotIndex(input);
    const referenceElements = this.#snapshotIndex(referenced);
    const extensionContexts = this.#extensionContexts(sourceElements, referenceElements);
    const extensionRoots = [...extensionContexts.keys()].sort((a, b) => b.length - a.length);
    const extensionBases = new Map();
    const definitions = new Map();
    for (const root of extensionRoots) {
      const referenceRoot = extensionContexts.get(root);
      const needsBase = !referenceRoot || [...sourceElements.keys()].some(id =>
        id.startsWith(`${root}.`) && !referenceElements.has(referenceRoot.id + id.slice(root.length)));
      if (!needsBase) continue;
      const element = sourceElements.get(root);
      const canonical = element.type?.find(type => type.code === 'Extension')?.profile?.[0] ||
        'http://hl7.org/fhir/StructureDefinition/Extension';
      if (!definitions.has(canonical)) {
        definitions.set(canonical, this.#snapshotIndex(this.package.resolve(canonical)));
      }
      extensionBases.set(root, definitions.get(canonical));
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

    // Walk the snapshot elements of the input file to compare them with the compliesWith profile.    
    const unmatched = [];
    const changes = new Map();
    for (const [id, element] of sourceElements) {
      const extensionRoot = extensionRoots.find(root => id === root || id.startsWith(`${root}.`));
      const referenceRoot = extensionContexts.get(extensionRoot);
      const extensionBaseline = referenceRoot && referenceElements.get(referenceRoot.id + id.slice(extensionRoot.length));
      const baseElements = extensionBases.get(extensionRoot);
      const baseRoot = baseElements?.keys().next().value;
      const baseId = baseRoot && baseRoot + id.slice(extensionRoot.length);
      const definitionBaseline = baseElements && (baseElements.get(baseId) || this.#sliceBaseline(baseId, baseElements, baseElements));
      const isNew = extensionRoot !== undefined ? !extensionBaseline : !referenceElements.has(id);
      const baseline = extensionRoot !== undefined ? (extensionBaseline || definitionBaseline)
        : referenceElements.get(id) || this.#sliceBaseline(id, sourceElements, referenceElements);
      if (!baseline) {
        unmatched.push(id);
        continue;
      }
      if (isNew) this.#addSlicing(element, sourceElements, referenceElements, changes);

      const change = changes.get(id) || { id, path: element.path };
      for (const key of ['min', 'max']) {
        if (element[key] === undefined || baseline[key] === undefined) {
          throw new Error(`${id}: ${key} is missing from an input or referenced snapshot`);
        }
        if (element[key] !== baseline[key]) change[key] = element[key];
      }

      const binding = {};
      for (const key of ['valueSet', 'strength']) {
        const value = element.binding?.[key];
        const baselineValue = baseline.binding?.[key];
        let matches = value === baselineValue;
        if (key === 'valueSet') {
          matches = this.#valueSetsMatch(value, baselineValue);
        }
        if (value !== undefined && !matches) binding[key] = value;
      }

      const additionalBindings = this.#additionalBindings(element.binding, baseline.binding);
      if (additionalBindings.length) binding.extension = additionalBindings;
      if (Object.keys(binding).length) change.binding = binding;
      if (element.comment !== undefined && element.comment !== baseline.comment) {
        change.comment = element.comment;
      }

      const sliceConstraints = Object.keys(element).filter(key =>
        (id.includes(':') && /^(fixed|pattern)[A-Z]/.test(key)) || /^value(?:[A-Z]|\[x\])/.test(key));
      for (const key of sliceConstraints) {
        if (!isDeepStrictEqual(element[key], baseline[key])) {
          change[key] = structuredClone(element[key]);
        }
      }
      if (id.includes(':') && element.type !== undefined && !this.#typesMatch(element.type, baseline.type)) {
        change.type = this.#typeProperties(element.type);
      }
      if (id === extensionRoot) {
        // Extension slice roots always identify their extension, even when inherited unchanged.
        const url = sourceElements.get(`${id}.url`);
        const profiles = element.type?.find(type => type.code === 'Extension')?.profile;
        const canonical = url?.fixedUri || url?.fixedUrl || url?.patternUri || url?.patternUrl;
        if (!profiles?.length && !canonical) throw new Error(`Missing extension canonical for ${id}`);
        change.type = [{ code: 'Extension', profile: profiles?.length ? [...profiles] : [canonical] }];
      }
      if ('min' in change || 'max' in change || 'binding' in change || 'comment' in change ||
          'slicing' in change || 'type' in change || sliceConstraints.some(key => key in change) ||
          (isNew && element.sliceName !== undefined)) {
        if (element.sliceName !== undefined) change.sliceName = element.sliceName;
        changes.set(id, change);
      }
    }
    output.differential.element = [...sourceElements.keys()].filter(id => changes.has(id)).map(id => changes.get(id));
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
  const destination = path.resolve(options.output);
  const fhirPackage = new FhirPackage(options.ig, options.cache);
  let written = 0;
  const destinations = new Set();
  for (const filename of inputFiles(inputs)) {
    try {
      const input = readJson(filename);
      const result = new ProfileCardinalityRebaser(input, fhirPackage).rebase();
      if (result.skipped) {
        console.log(`- Skipped ${path.basename(filename)}: ${result.skipped}`);
        continue;
      }
      const { output, unmatched, referencedProfileName } = result;
      const target = path.join(destination, path.basename(filename));
      if (target === filename) throw new Error('Output would overwrite the input profile');
      if (destinations.has(target)) throw new Error(`Duplicate output filename: ${target}`);
      destinations.add(target);
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(target, JSON.stringify(output, null, 2) + '\n');
      written++;

      const skipped = unmatched.length
        ? `; skipped ${unmatched.length} elements not present in ${referencedProfileName}:\n${unmatched.map(id => `  - ${id}`).join('\n')}`
        : '';
      console.log(`- Rebased ${path.basename(target)} (${output.differential.element.length} changed elements)${skipped}`);
    } catch (error) {
      console.error(`- Skipped ${path.basename(filename)}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`Wrote ${written} profile(s).`);
}

if (require.main === module) {
  commander.program
    .name('rebase-cardinalities')
    .description('Create JSON differentials containing cardinality and binding changes against referenced package profiles.')
    .argument('<profiles...>', 'JSON files or directories containing JSON profiles (nonrecursive)')
    .requiredOption('--ig <package-id#version>', 'Installed FHIR package containing the referenced profiles', value => {
      if (!/^[^#\\/]+#[^#\\/]+$/.test(value) || value.includes('..')) {
        throw new commander.InvalidArgumentError('Expected <package-id>#<version>, e.g. hl7.fhir.eu.eps#1.0.0-ballot');
      }
      return value;
    })
    .option('--cache <directory>', 'FHIR package cache', path.join(homedir(), '.fhir', 'packages'))
    .requiredOption('--output <directory>', 'Output directory')
    .action(run);
  commander.program.parse();
}

module.exports = { ProfileCardinalityRebaser, FhirPackage };
