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
      if (resource.resourceType !== 'StructureDefinition' || !resource.url) continue;
      const matches = profiles.get(resource.url) || [];
      matches.push(resource);
      profiles.set(resource.url, matches);
    }
    return profiles;
  }

  resolve(canonical) {
    this.profiles ??= this.#load();
    const profiles = this.profiles;
    const [url, version, ...extra] = canonical.split('|');
    if (!url || extra.length || (version !== undefined && !version)) {
      throw new Error(`Invalid profile canonical: ${canonical}`);
    }
    const matches = (profiles.get(url) || []).filter(profile =>
      version === undefined || profile.version === version);
    if (matches.length !== 1) {
      throw new Error(`Expected one profile for ${canonical} in the selected package; found ${matches.length}`);
    }
    return matches[0];
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

  #createDifferential(referenced) {
    const input = this.input;
    const sourceElements = this.#snapshotIndex(input);
    const referenceElements = this.#snapshotIndex(referenced);

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
      const isNew = !referenceElements.has(id);
      const baseline = referenceElements.get(id) || this.#sliceBaseline(id, sourceElements, referenceElements);
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
        id.includes(':') && /^(fixed|pattern)[A-Z]/.test(key));
      for (const key of sliceConstraints) {
        if (!isDeepStrictEqual(element[key], baseline[key])) {
          change[key] = structuredClone(element[key]);
        }
      }
      if ('min' in change || 'max' in change || 'binding' in change || 'comment' in change ||
          'slicing' in change || sliceConstraints.some(key => key in change) ||
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
