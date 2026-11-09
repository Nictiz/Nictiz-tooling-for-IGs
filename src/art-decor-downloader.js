#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const commander = require("commander");
const { parseSushiYaml } = require("./ig-config");
const { getLogicalModelReferences } = require("./excel-to-artifacts");

const serverSourceUrl = "https://decor.nictiz.nl";
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
  static artifactTypes = Object.freeze({
    ActorDefinition: { folder: "resources", resourceType: "ActorDefinition" },
    ValueSet: { folder: "vocabulary", resourceType: "ValueSet" },
    LogicalModel: { folder: "logicalmodels", resourceType: "StructureDefinition" }
  });

  #downloadedCanonicals = new Set();
  #pendingDownloads = new Set();

  constructor(adProject, outputFolder, serverSourceUrl = "https://decor.nictiz.nl") {
    if (!adProject) throw new Error("No ART-DECOR project defined for downloading FHIR artifacts");
    if (!outputFolder) throw new Error("No output folder defined for downloading FHIR artifacts");
    this.adProject = adProject;
    this.outputFolder = outputFolder;
    this.serverSourceUrl = serverSourceUrl;
  }

  async #download(canonical, artifactType, fileName) {
    const canonicalObj = new URL(canonical.split("|")[0]);
    const normalizedCanonical = canonicalObj.toString();
    if (this.#downloadedCanonicals.has(normalizedCanonical) ||
      this.#pendingDownloads.has(normalizedCanonical)) return;

    this.#pendingDownloads.add(normalizedCanonical);
    try {
      const { folder, resourceType } = ArtDecorDownloader.artifactTypes[artifactType];
      const isDirectFetch = canonicalObj.origin === new URL(this.serverSourceUrl).origin;
      const downloadUrl = isDirectFetch
        ? canonicalObj
        : new URL(`${this.serverSourceUrl}/fhir/4.0/${this.adProject}/${resourceType}`);
      if (!isDirectFetch) downloadUrl.searchParams.set("url", canonicalObj.toString());
      downloadUrl.searchParams.set("_format", "json");

      const response = await fetch(downloadUrl.toString(), {
        headers: {
          "Accept": "application/fhir+json, application/json; fhirVersion=4.0"
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

      let resource = await response.json();
      if (!isDirectFetch) {
        if (resource.resourceType !== "Bundle") {
          throw new Error(`Expected Bundle, got ${resource.resourceType ?? "unknown resource"}`);
        }
        const matches = (resource.entry ?? [])
          .filter(entry => entry.search?.mode !== "outcome" && entry.search?.mode !== "include")
          .map(entry => entry.resource)
          .filter(entryResource => entryResource?.resourceType === resourceType);
        if (!matches.length) throw new Error(`No ${resourceType} found for ${normalizedCanonical}`);
        if (matches.length > 1) {
          console.warn(`Multiple ${resourceType} resources have canonical ${normalizedCanonical}. Downloading the first one.`);
        }
        resource = matches[0];
      }
      if (resource.resourceType !== resourceType) {
        throw new Error(`Expected ${resourceType}, got ${resource.resourceType ?? "unknown resource"}`);
      }

      const outputFolder = path.join(this.outputFolder, folder);
      const outputFile = path.join(outputFolder, fileName.endsWith(".json") ? fileName : `${fileName}.json`);
      normalizeResourceLanguages(resource);
      fs.mkdirSync(outputFolder, { recursive: true });
      fs.writeFileSync(outputFile, JSON.stringify(resource, null, 2), "utf8");
      this.#downloadedCanonicals.add(normalizedCanonical);
      console.log(`Saved ${resourceType} to ${outputFile}`);
    } catch (error) {
      console.warn(`Couldn't download ${normalizedCanonical} from ART-DECOR, "${error.message}"`);
    } finally {
      this.#pendingDownloads.delete(normalizedCanonical);
    }
  }
}

class ActorDefinitionDownloader {
  constructor(adProject, outputFolder) {
    if (!adProject) {
      console.error("No ART-DECOR project specified as source for the ActorDefinitions");
      process.exit(1);
    }
    this.adProject = adProject;
    this.outputFolder = outputFolder;
  }

  async downloadAll() {
    try {
      const actorDefinitionsUrl = `${serverSourceUrl}/fhir/4.0/${this.adProject}/ActorDefinition?publisher=${this.adProject}&_format=json`;
      const body = await this.#fetchJson(actorDefinitionsUrl);
      const usedFileNames = new Set();

      for (const actorDefinition of this.#getActorDefinitions(body)) {
        const outputFile = path.join(this.outputFolder, this.#getFileName(actorDefinition, usedFileNames));
        
        normalizeResourceLanguages(actorDefinition);
        
        fs.writeFileSync(outputFile, JSON.stringify(actorDefinition, null, 2), "utf8");
        console.log(`Saved ActorDefinition to ${outputFile}`);
      }
    } catch (error) {
      console.warn(`Couldn't download ActorDefinitions from ART-DECOR, "${error.message}"`);
    }
  }

  async #fetchJson(url) {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/fhir+json, application/json; fhirVersion=4.0"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  #getActorDefinitions(body) {
    if (body.resourceType == "ActorDefinition") {
      return [body];
    }

    if (body.resourceType != "Bundle") {
      throw new Error(`Expected Bundle, got ${body.resourceType ?? "unknown resource"}`);
    }

    return (body.entry ?? [])
      .map(entry => entry.resource)
      .filter(resource => resource?.resourceType == "ActorDefinition");
  }

  #getFileName(actorDefinition, usedFileNames) {
    const actorDefinitionName = actorDefinition.name || actorDefinition.id || "ActorDefinition";
    const baseFileName = `ActorDefinition-${this.#safeFileName(actorDefinitionName)}.json`;

    if (!usedFileNames.has(baseFileName)) {
      usedFileNames.add(baseFileName);
      return baseFileName;
    }

    const fallbackName = actorDefinition.id || actorDefinition.url?.split("/").filter(Boolean).pop() || "duplicate";
    const duplicateFileName = `ActorDefinition-${this.#safeFileName(actorDefinitionName)}-${this.#safeFileName(fallbackName)}.json`;
    usedFileNames.add(duplicateFileName);
    console.warn(`Duplicate ActorDefinition name "${actorDefinitionName}"; saved duplicate as ${duplicateFileName}`);
    return duplicateFileName;
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

  constructor(adProject, outputFolder) {
    if (!adProject) {
      console.error("No ART-DECOR project defined for downloading ValueSets");
      process.exit(1);
    }
    this.adProject = adProject;
    this.outputFolder = outputFolder;
    this.downloadedCanonicals = new Set();
    this.pendingDownloads = new Map();
  }

  async downloadAll(canonicals) {
    for (const canonical of canonicals) {
      await this.download(canonical);
    }
  }

  async download(canonical) {
    const normalizedCanonical = this.#normalizeCanonical(canonical);
    if (
      !normalizedCanonical ||
      this.#shouldSkipCanonical(normalizedCanonical) ||
      this.downloadedCanonicals.has(normalizedCanonical)
    ) return;

    if (this.pendingDownloads.has(normalizedCanonical)) {
      await this.pendingDownloads.get(normalizedCanonical);
      return;
    }

    const download = this.#download(normalizedCanonical)
      .finally(() => this.pendingDownloads.delete(normalizedCanonical));

    this.pendingDownloads.set(normalizedCanonical, download);
    await download;
  }

  async #download(canonical) {
    this.downloadedCanonicals.add(canonical);

    try {
      const response = await fetch(this.#toDownloadUrl(canonical), {
        headers: {
          "Accept": "application/fhir+json, application/json; fhirVersion=4.0"
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const bundle = await response.json();
      if (bundle.resourceType != "Bundle") {
        throw new Error(`Expected Bundle, got ${bundle.resourceType ?? "unknown resource"}`);
      }
      if (bundle.total < 1) {
        console.error(`Couldn't download ValueSet ${canonical}. Bundle turned up empty for request ${this.#toDownloadUrl(canonical)}`);
        return;
      } else if (bundle.total > 1) {
        console.warn(`Multiple ValueSets are present with canonical ${canonical}. Downloading the first one.`);
      }
      const valueSet = bundle.entry[0].resource;
      if (valueSet.resourceType != "ValueSet") {
        throw new Error(`Expected ValueSet, got ${valueSet.resourceType ?? "unknown resource"}`);
      }

      const outputFile = path.join(
        this.outputFolder,
        `${this.#safeFileName(valueSet.name || valueSet.id || this.#fallbackName(canonical))}.json`
      );
      
      normalizeResourceLanguages(valueSet);

      fs.writeFileSync(outputFile, JSON.stringify(valueSet, null, 2), "utf8");
      console.log(`Saved ValueSet to ${outputFile}`);

      await this.downloadAll(this.#getIncludedValueSetCanonicals(valueSet));
    } catch (error) {
      console.warn(`Couldn't download ValueSet ${canonical}, "${error.message}"`);
    }
  }

  #getIncludedValueSetCanonicals(valueSet) {
    const canonicals = new Set();

    for (const include of valueSet.compose?.include ?? []) {
      this.#addCanonicals(canonicals, include.valueSet);
    }

    return Array.from(canonicals);
  }

  #addCanonicals(canonicals, value) {
    if (Array.isArray(value)) {
      value.forEach(canonical => this.#addCanonicals(canonicals, canonical));
      return;
    }

    const canonical = this.#normalizeCanonical(value);
    if (canonical) {
      canonicals.add(canonical);
    }
  }

  #normalizeCanonical(canonical) {
    return typeof canonical == "string" ? canonical.trim() : "";
  }

  #shouldSkipCanonical(canonical) {
    return ValueSetDownloader.skippedCanonicalPrefixes.some(prefix => canonical.startsWith(prefix));
  }

  #toDownloadUrl(canonical) {
    const resourceUrl = new URL(canonical.split("|")[0]);
    const searchUrl = new URL(`${serverSourceUrl}/fhir/4.0/${this.adProject}/ValueSet`);
    searchUrl.searchParams.set("url", resourceUrl);
    searchUrl.searchParams.set("_format", "json");
    return searchUrl.toString();
  }

  #fallbackName(canonical) {
    return canonical.split("|")[0].split("/").filter(Boolean).pop() || "ValueSet";
  }

  #safeFileName(fileName) {
    return fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
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
  constructor(adProject, outputFolder, valueSetDownloader = null) {
    if (!adProject) throw new Error("No ART-DECOR project defined for downloading logical models");
    this.adProject = adProject;
    this.outputFolder = outputFolder;
    this.valueSetDownloader = valueSetDownloader;
  }

  async download(adId, fileRoot) {
    const id_parts = adId.split("/");
    if (id_parts.length != 2 || !id_parts[0] || !id_parts[1]) {
      console.warn(`Skipping logical model for ${fileRoot}: invalid ART-DECOR ID "${adId}"`);
      return;
    }
    const id_date = id_parts[1].replace(/-/g, "").replace(/:/g, "").replace("T", "");
    const fetch_url = `${serverSourceUrl}/fhir/4.0/${this.adProject}/StructureDefinition/${id_parts[0]}--${id_date}?_format=json&language=en-US`;
    try {
      const response = await fetch(`${fetch_url}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} - ${fetch_url}`);
      }

      const body = await response.json();
      normalizeResourceLanguages(body);
      
      const outputFile = path.join(this.outputFolder, fileRoot + ".json");
      fs.writeFileSync(outputFile, JSON.stringify(body, null, 2), 'utf8');
      console.log(`Saved LogicalModel to ${outputFile}`);

      if (this.valueSetDownloader) {
        await this.valueSetDownloader.downloadAll(this.#getBindingValueSetCanonicals(body));
      }
    } catch (error) {
      console.warn(`Couldn't download logical model for ${fileRoot} from ART-DECOR using ${fetch_url}, "${error.message}"`);
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
  const valueSets = profiles || (logicalModels && !options.dontDescend)
    ? new ValueSetDownloader(config.adProject, vocabularyFolder) : null;
  if (actors) await new ActorDefinitionDownloader(config.adProject, resourcesFolder).downloadAll();
  if (logicalModels) {
    const downloader = new LogicalModelDownloader(config.adProject, logicalModelFolder, options.dontDescend ? null : valueSets);
    for (const { adId, fileRoot } of getLogicalModelReferences(inputFolder)) {
      await downloader.download(adId, fileRoot);
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

module.exports = { ArtDecorDownloader, ActorDefinitionDownloader, ValueSetDownloader, LogicalModelDownloader };
