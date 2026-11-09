#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const commander = require("commander");
const { parseSushiYaml } = require("./ig-config");
const { getLogicalModelReferences } = require("./excel-to-artifacts");

const translationExtensionUrl = "http://hl7.org/fhir/StructureDefinition/translation";
const additionalBindingExtensionUrl = "http://hl7.org/fhir/tools/StructureDefinition/additional-binding";

function normalizeLanguageCode(languageCode) {
  return typeof languageCode === "string" ? languageCode.slice(0, 2) : languageCode;
}

function normalizeResourceLanguages(resource) {
  if (!resource || typeof resource !== "object") return resource;

  if (typeof resource.language === "string") {
    resource.language = normalizeLanguageCode(resource.language);
  }

  normalizeTranslationExtensionLanguages(resource);
  return resource;
}

function normalizeTranslationExtensionLanguages(value) {
  if (Array.isArray(value)) {
    value.forEach(item => normalizeTranslationExtensionLanguages(item));
    return;
  }

  if (!value || typeof value !== "object") return;

  if (value.url === translationExtensionUrl) {
    for (const extension of value.extension ?? []) {
      if (extension?.url === "lang" && typeof extension.valueCode === "string") {
        extension.valueCode = normalizeLanguageCode(extension.valueCode);
      }
    }
  }

  for (const nestedValue of Object.values(value)) {
    normalizeTranslationExtensionLanguages(nestedValue);
  }
}

class ArtDecorDownloader {
  static normalizeCanonical(canonical) {
    return typeof canonical === "string" ? canonical.split("|")[0].trim() : "";
  }

  static resourceFolders = Object.freeze({
    ActorDefinition: "resources",
    ValueSet: "vocabulary",
    StructureDefinition: "logicalmodels"
  });

  #completedRequests = new Set();
  #pendingRequests = new Set();

  constructor(adProject, outputFolder, serverSourceUrl = "https://decor.nictiz.nl") {
    if (!adProject) throw new Error("No ART-DECOR project defined for downloading FHIR artifacts");
    if (!outputFolder) throw new Error("No output folder defined for downloading FHIR artifacts");
    this.adProject = adProject;
    this.outputFolder = outputFolder;
    this.serverSourceUrl = serverSourceUrl;
  }
  
  async getActorDefinitions() {
    await this.#search("ActorDefinition", { publisher: this.adProject });
  }

  async getValueSet(canonical) {
    const url = new URL(ArtDecorDownloader.normalizeCanonical(canonical));
    return this.#search("ValueSet", { url: url.toString() });
  }

  async getLogicalModel(adId) {
    const parts = adId.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      console.warn(`Skipping logical model: invalid ART-DECOR ID "${adId}"`);
      return [];
    }
    const date = parts[1].replace(/[-:T]/g, "");
    const id = `${parts[0]}--${date}`;
    const url = new URL(`${this.serverSourceUrl}/fhir/4.0/${this.adProject}/StructureDefinition/${encodeURIComponent(id)}`);
    url.searchParams.set("language", "en-US");
    url.searchParams.set("_format", "json");
    return this.#request("StructureDefinition", url, false);
  }

  /**
   * Searches the configured ART-DECOR project's FHIR endpoint and writes matching
   * resources from a single Bundle response as JSON. Included resources and
   * OperationOutcome entries are ignored; pagination links are not followed.
   *
   * Destinations come from resourceFolders, relative to this.outputFolder.
   * Resource languages are normalized before writing. Filenames default to
   * <resourceType>-<name or id>.json, with suffixes for duplicate names.
   *
   * Identical searches (regardless of parameter order) are skipped
   * while pending and after success. Errors during fetching, response processing,
   * or writing are logged and return an empty array; failed searches can be retried.
   *
   * @param {string} resourceType FHIR resource type present in resourceFolders.
   * @param {Object.<string, string>} [parameters={}] FHIR search parameters;
   *   _format is always set to json.
   * @returns {Promise<Array<Object>>} Written resources, or an empty array for
   *   no matches, a skipped search, or a handled error.
   */
  async #search(resourceType, parameters = {}) {
    const searchUrl = new URL(`${this.serverSourceUrl}/fhir/4.0/${this.adProject}/${resourceType}`);
    searchUrl.search = new URLSearchParams(parameters).toString();
    searchUrl.searchParams.set("_format", "json");
    searchUrl.searchParams.sort();
    return this.#request(resourceType, searchUrl, true);
  }

  async #request(resourceType, url, isSearch) {
    const requestKey = url.toString();
    if (this.#completedRequests.has(requestKey) || this.#pendingRequests.has(requestKey)) return [];
    this.#pendingRequests.add(requestKey);
    try {
      const outputFolder = path.join(this.outputFolder, ArtDecorDownloader.resourceFolders[resourceType]);
      const response = await fetch(requestKey, {
        headers: { "Accept": "application/fhir+json, application/json; fhirVersion=4.0" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const body = await response.json();
      const expectedType = isSearch ? "Bundle" : resourceType;
      if (body.resourceType !== expectedType) {
        throw new Error(`Expected ${expectedType}, got ${body.resourceType ?? "unknown resource"}`);
      }
      const usedFileNames = new Set();
      const resources = [];
      for (const entry of isSearch ? body.entry ?? [] : [{ resource: body }]) {
        const resource = entry.resource;
        if (entry.search?.mode === "outcome" || entry.search?.mode === "include" ||
          resource?.resourceType !== resourceType) continue;
        const outputFile = path.join(outputFolder, this.#constructFileName(resource, usedFileNames));
        normalizeResourceLanguages(resource);
        fs.mkdirSync(outputFolder, { recursive: true });
        fs.writeFileSync(outputFile, JSON.stringify(resource, null, 2), "utf8");
        resources.push(resource);
        console.log(`Saved ${resourceType} to ${outputFile}`);
      }
      this.#completedRequests.add(requestKey);
      return resources;
    } catch (error) {
      console.warn(`Couldn't download ${resourceType} from ART-DECOR, "${error.message}"`);
      return [];
    } finally {
      this.#pendingRequests.delete(requestKey);
    }
  }

  #constructFileName(resource, usedFileNames) {
    const name = resource.name || resource.id;
    if (!name) throw new Error(`${resource.resourceType} has no name or ID`);
    const baseName = `${resource.resourceType}-${this.#safeFileName(name)}`;
    let fileName = `${baseName}.json`;
    if (usedFileNames.has(fileName)) {
      const suffix = this.#safeFileName(resource.id || "duplicate");
      fileName = `${baseName}-${suffix}.json`;
      let index = 2;
      while (usedFileNames.has(fileName)) fileName = `${baseName}-${suffix}-${index++}.json`;
    }
    usedFileNames.add(fileName);
    return fileName;
  }

  #safeFileName(fileName) {
    return fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  }
}

class ValueSetDownloader {
  static skippedCanonicalPrefixes = [
    "http://hl7.org",
    "http://terminology.hl7.org",
    "http://decor.nictiz.nl",
    "http://terminology.ehdsi.eu",
    "https://specifications.openehr.org"
  ];

  constructor(artDecorDownloader) {
    this.artDecorDownloader = artDecorDownloader;
  }

  async downloadAll(canonicals) {
    for (const canonical of canonicals) {
      await this.download(canonical);
    }
  }

  async download(canonical) {
    const normalizedCanonical = ArtDecorDownloader.normalizeCanonical(canonical);
    if (
      !normalizedCanonical ||
      ValueSetDownloader.skippedCanonicalPrefixes.some(prefix => normalizedCanonical.startsWith(prefix))
    ) return;

    try {
      const valueSets = await this.artDecorDownloader.getValueSet(normalizedCanonical);
      for (const valueSet of valueSets) {
        await this.downloadAll(this.#getIncludedValueSetCanonicals(valueSet));
      }
    } catch (error) {
      console.warn(`Couldn't download ValueSet ${canonical}, "${error.message}"`);
    }
  }

  #getIncludedValueSetCanonicals(valueSet) {
    const canonicals = new Set();

    for (const include of valueSet.compose?.include ?? []) {
      for (const value of [include.valueSet].flat(Infinity)) {
        const canonical = ArtDecorDownloader.normalizeCanonical(value);
        if (canonical) canonicals.add(canonical);
      }
    }

    return Array.from(canonicals);
  }

}

class ProfileValueSetCollector {
  constructor(profileFolder) {
    this.profileFolder = profileFolder;
  }

  getBindingValueSetCanonicals() {
    if (!fs.existsSync(this.profileFolder)) return [];

    const canonicals = new Set();
    for (const profileFile of this.#getXmlFiles(this.profileFolder)) {
      try {
        this.#addBindingValueSetCanonicals(
          canonicals,
          fs.readFileSync(profileFile, "utf8")
        );
      } catch (error) {
        console.warn(`Couldn't read bindings from profile ${profileFile}, "${error.message}"`);
      }
    }

    return Array.from(canonicals);
  }

  #getXmlFiles(folder) {
    const files = [];

    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const entryPath = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.#getXmlFiles(entryPath));
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() == ".xml") {
        files.push(entryPath);
      }
    }

    return files;
  }

  #addBindingValueSetCanonicals(canonicals, xml) {
    const xmlWithoutComments = xml.replace(/<!--[\s\S]*?-->/g, "");
    const bindingPattern = /<(?:[\w.-]+:)?binding\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?binding\s*>/gi;

    for (const bindingMatch of xmlWithoutComments.matchAll(bindingPattern)) {
      const bindingXml = bindingMatch[1];

      // Covers regular bindings and valueCanonical/valueUri primitives in
      // additional-binding extensions.
      const valuePattern = /<(?:[\w.-]+:)?(?:valueSet|valueSetCanonical|valueSetUri|valueCanonical|valueUri)\b[^>]*\bvalue\s*=\s*(["'])(.*?)\1/gi;
      for (const valueMatch of bindingXml.matchAll(valuePattern)) {
        this.#addCanonical(canonicals, valueMatch[2]);
      }

      // Older FHIR profiles may express a binding as valueSetReference.
      const referenceBlockPattern = /<(?:[\w.-]+:)?valueSetReference\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?valueSetReference\s*>/gi;
      for (const referenceBlockMatch of bindingXml.matchAll(referenceBlockPattern)) {
        const referencePattern = /<(?:[\w.-]+:)?reference\b[^>]*\bvalue\s*=\s*(["'])(.*?)\1/gi;
        for (const referenceMatch of referenceBlockMatch[1].matchAll(referencePattern)) {
          this.#addCanonical(canonicals, referenceMatch[2]);
        }
      }
    }
  }

  #addCanonical(canonicals, canonical) {
    const decodedCanonical = this.#decodeXmlAttribute(canonical).trim();
    if (decodedCanonical) {
      canonicals.add(decodedCanonical);
    }
  }

  #decodeXmlAttribute(value) {
    return value
      .replace(/&#x([0-9a-f]+);/gi, (_match, codePoint) => String.fromCodePoint(parseInt(codePoint, 16)))
      .replace(/&#([0-9]+);/g, (_match, codePoint) => String.fromCodePoint(parseInt(codePoint, 10)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }
}

class LogicalModelDownloader {
  constructor(artDecorDownloader, valueSetDownloader = null) {
    this.artDecorDownloader = artDecorDownloader;
    this.valueSetDownloader = valueSetDownloader;
  }

  async download(adId) {
    try {
      const models = await this.artDecorDownloader.getLogicalModel(adId);
      for (const model of models) {
        if (this.valueSetDownloader) {
          await this.valueSetDownloader.downloadAll(this.#getBindingValueSetCanonicals(model));
        }
      }
    } catch (error) {
      console.warn(`Couldn't download logical model ${adId} from ART-DECOR, "${error.message}"`);
      return;
    }
  }

  #getBindingValueSetCanonicals(structureDefinition) {
    const canonicals = new Set();

    for (const element of [
      ...(structureDefinition.snapshot?.element ?? []),
      ...(structureDefinition.differential?.element ?? [])
    ]) {
      const binding = element.binding;
      if (!binding) continue;

      this.#addCanonicals(canonicals, binding.valueSet);
      this.#addCanonicals(canonicals, binding.valueSetCanonical);
      this.#addCanonicals(canonicals, binding.valueSetUri);
      this.#addCanonicals(canonicals, binding.valueSetReference?.reference);

      for (const extension of binding.extension ?? []) {
        if (extension?.url !== additionalBindingExtensionUrl) continue;

        for (const nestedExtension of extension.extension ?? []) {
          if (nestedExtension?.url !== "valueSet") continue;

          this.#addCanonicals(canonicals, nestedExtension.valueCanonical);
          this.#addCanonicals(canonicals, nestedExtension.valueUri);
          this.#addCanonicals(canonicals, nestedExtension.valueReference?.reference);
        }
      }
    }

    return Array.from(canonicals);
  }

  #addCanonicals(canonicals, value) {
    if (Array.isArray(value)) {
      value.forEach(canonical => this.#addCanonicals(canonicals, canonical));
      return;
    }

    if (typeof value == "string" && value.trim()) {
      canonicals.add(value.trim());
    }
  }
}

async function main() {
  commander.program
    .option("--actors", "Download ActorDefinitions from ART-DECOR")
    .option("--lm", "Download logical models referenced by Excel workbooks")
    .option("--profile-artifacts", "Download ValueSets referenced by profiles")
    .addOption(new commander.Option("--dont-descend", "Do not download ValueSets referenced by logical models").conflicts("profile-artifacts"))
    .argument("<inputFolder>")
    .argument("<outputFolder>")
    .parse();
  const options = commander.program.opts();
  const [inputFolder, outputFolder] = commander.program.args;
  const all = !options.actors && !options.lm && !options.profileArtifacts;
  const actors = all || options.actors;
  const logicalModels = all || options.lm;
  const profiles = (all && !options.dontDescend) || options.profileArtifacts;
  const config = parseSushiYaml();
  if (!config.adProject) throw new Error("No ART-DECOR project configured in sushi-config.yaml");
  const resourcesFolder = path.join(outputFolder, "resources");
  const logicalModelFolder = path.join(outputFolder, "logicalmodels");
  const vocabularyFolder = path.join(outputFolder, "vocabulary");
  // Preserve files produced by other commands and download actions.
  for (const folder of [
    ...(actors ? [resourcesFolder] : []),
    ...(logicalModels ? [logicalModelFolder] : []),
    ...(profiles || (logicalModels && !options.dontDescend) ? [vocabularyFolder] : [])
  ]) fs.mkdirSync(folder, { recursive: true });
  const artDecorDownloader = new ArtDecorDownloader(config.adProject, outputFolder);
  const valueSets = profiles || (logicalModels && !options.dontDescend)
    ? new ValueSetDownloader(artDecorDownloader) : null;
  if (actors) await artDecorDownloader.getActorDefinitions();
  if (logicalModels) {
    const downloader = new LogicalModelDownloader(artDecorDownloader, options.dontDescend ? null : valueSets);
    for (const { adId } of getLogicalModelReferences(inputFolder)) {
      await downloader.download(adId);
    }
  }
  if (profiles) {
    const collector = new ProfileValueSetCollector(path.join(inputFolder, "profiles"));
    await valueSets.downloadAll(collector.getBindingValueSetCanonicals());
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { ArtDecorDownloader, ValueSetDownloader, LogicalModelDownloader };
