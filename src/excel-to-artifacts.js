#!/usr/bin/env node

const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const commander = require("commander");
const YAML = require("yaml");

const serverSourceUrl = "https://decor.nictiz.nl";
const translationExtensionUrl = "http://hl7.org/fhir/StructureDefinition/translation";

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

class TargetFolders {
  static subfolders = {
    "ActorDefinitions":     "logicalmodels",
    "RequirementResources": "requirements",
    "PageContent":          "pagecontent",
    "LogicalModels":        "logicalmodels",
    "Vocabulary":           "vocabulary",
    "Resources":            "resources"
  }

  constructor(baseFolder) {
    this.baseFolder = baseFolder;

    // Clean and create all subfolders
    for (const subfolder of Object.keys(TargetFolders.subfolders)) {
      const folder = path.join(this.baseFolder, TargetFolders.subfolders[subfolder]);
      fs.rmSync(folder, { recursive: true, force: true });
      fs.mkdirSync(folder, { recursive: true });
    }
  }

  get(subfolderType) {
    return path.join(this.baseFolder, TargetFolders.subfolders[subfolderType]);
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
    "http://decor.nictiz.nl"
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
        console.warn(`Couldn't download ValueSet ${canonical}`);
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

class ExcelConvertor {
  static structConcept = {
    v1: {
      nl: {
        sheet: "Concept",
        col: {
          field: "Veld",
          description: "Beschrijving"
        },
        key: {
          ADId: "ART-DECOR-id"
        }
      },
      en: {
        sheet: null
      }
    },
    v2: {
      nl: {
        sheet: "Concept",
        col: {
          field: "Veld",
          description: "Invulling"
        },
        key: {
          ADId: "ART-DECOR-id",
          code: "Bouwblokcode"
        },
        title: {
          sources: "Bronnen"
        }
      },
      en: {
        sheet: "Concept (ENG)",
        col: {
          field: "Field",
          description: "Input"
        },
        key: {
          ADId: "ART-DECOR-id",
          code: "Building block code"
        },
        title: {
          sources: "Sources"
        }
      }
    }
  }

  static structBaseModelConsiderations = {
    v1: {
      nl: {
        sheet: null,
      },
      en: {
        sheet: null
      }
    },
    v2: {
      nl: {
        sheet: "Overwegingen kiezen basismodel",
        title: "Gebruikt basismodel",
        col: {
          field: "Veld",
          description: "Invulling"
        },
        key: {
          considerations: "Overwegingen"
        }
      },
      en: {
        sheet: "Base model considerations (ENG)",
        title: "Base model used",
        col: {
          field: "Field",
          description: "Input"
        },
        key: {
          considerations: "Considerations"
        }
      }
    }
  }

  static structRequirements = {
    v1: {
      nl: {
        sheet: "Informatiebehoefte",
        col: {
          number: "Nummer",
          name: "Naam",
          description: "Omschrijving",
          variability: "Variabiliteit",
          presence: "Aanwezigheid",
          temp: "Verleden/heden/toekomst",
          source: "Herkomst",
        },
        key: {
          ADId: "ART-DECOR-id"
        }
      },
      en: {
        sheet: null
      }
    },
    v2: {
      nl: {
        sheet: "Informatie-requirements",
        col: {
          number: "Key",
          euOrNl: "EU of NL",
          name: "Titel",
          description: "Omschrijving",
          rationale: "Onderbouwing",
          variability: "Variabiliteit",
          presence: "Aanwezigheid",
          context: "Context voor toepassing",
          source: "Bron(nen)",
          derivedFrom: "Afgeleid van",
          addressed: "Opgenomen of niet-opgenomen"
        },
        key: {
          notAddressed: "Niet-opgenomen informatiebehoefte"
        }
      },
      en: {
        sheet: "Information requirements (ENG)",
        col: {
          number: "Key",
          euOrNl: "EU or NL",
          name: "Title",
          description: "Description",
          rationale: "Rationale",
          variability: "Variability",
          presence: "Presence",
          context: "Context for use",
          source: "Source(s)",
          derivedFrom: "Derived from",
          addressed: "Included or excluded information requirement"
        },
        key: {
          notAddressed: "Excluded information requirement"
        }
      }
    }
  }

  static structSources = {
    v1: {
      nl: {
        sheet: null
      }
    },
    v2: {
      nl: {
        sheet: "Bronnen",
        col: {
          key: "Afkorting / abbreviation",
          name: "Naam / name",
          version: "Versie / version",
          url: "Verwijzing (URL) / Reference (URL)"
        }
      }
    }
  }

  constructor(inputFile, targetFolders, valueSetDownloader, canonicalBase) {
    this.inputFile = inputFile;
    this.fileRoot = path.basename(inputFile.name, path.extname(inputFile.name));
    this.workbook = XLSX.readFile(path.join(inputFile.parentPath, inputFile.name));

    // Figure out the version of the template we're using, as this steers the output
    this.templateVersion = this.#getTemplateVersion();
    if (this.templateVersion == null) {
      console.warn(`Excel file ${inputFile} doesn't conform to the template. Skipping further processing.`)
    }

    this.sources = this.#getSources();
    this.targetFolders = targetFolders;
    this.valueSetDownloader = valueSetDownloader;
    this.canonicalBase = canonicalBase;
  }

  createRequirements() {
    if (this.templateVersion != null) {
      this.convertConceptPage("nl");
      this.convertConceptPage("en");
      this.convertRequirements();
    }
  }

  convertConceptPage(language) {
    const struct = ExcelConvertor.structConcept[this.templateVersion][language];
    const sheetTitle = struct.sheet;
    if (!sheetTitle) return;
    const rows = this.#getRows(sheetTitle);
    if (rows == null) return;

    const colField      = struct.col.field;
    const colDefinition = struct.col.description;
    let markdown = this.#convertKeyValueToMDDefinition(rows
      .filter(row => this.#cell(row, colField) != struct.key.ADId)
      .filter(row => this.#cell(row, colField) != struct.key.code)
      .filter(row => this.#cell(row, colField) != struct.col.field), // Empty rows are populated in the rows array with the title of the column
     colField, colDefinition);

    if (this.templateVersion == "v2" && Object.keys(this.sources).length > 0) {
      markdown += "\n\n" + struct.title.sources + "\n:\n";
      markdown += Object.entries(this.sources)
        .map(([key, value]) => `* [${value.name} ${value.version}](${value.url})${value.remarks ? " (" + value.remarks + ")" : ""}`)
        .join("\n");
    }

    markdown += this.#convertBaseModelConsiderations(language);

    let outputFileName = "";
    if (this.templateVersion == "v1") {
      outputFileName = `${this.fileRoot}-Concept.md`;
    } else {
      outputFileName = `${this.fileRoot}-Concept-${language}.md`;
    }
    const outputFile = path.join(this.targetFolders.get("PageContent"), outputFileName);
    fs.writeFileSync(outputFile, markdown, "utf8");
    console.log(`Wrote ${outputFile}`);
  }

  #convertBaseModelConsiderations(language) {
    const struct = ExcelConvertor.structBaseModelConsiderations[this.templateVersion][language];
    const sheetTitle = struct.sheet;
    if (!sheetTitle) return "";
    const rows = this.#getRows(sheetTitle);
    if (rows == null) return "";

    const colField      = struct.col.field;
    const colDefinition = struct.col.description;
    let markdown = this.#convertKeyValueToMDDefinition(rows
      .filter(row => this.#cell(row, colField) != struct.key.considerations)
      .filter(row => this.#cell(row, colField) != struct.col.field),  // Empty rows are populated in the rows array with the title of the column
      colField, colDefinition);
    markdown += rows
      .filter(row => this.#cell(row, colField) == struct.key.considerations)
      .map(row => "\n" + this.#cell(row, colDefinition))[0];

    if (markdown.length > 0) {
      markdown = `\n#### ${struct.title}\n${markdown}`
    }
    return markdown;
  }

  #convertKeyValueToMDDefinition(rows, keyCol, valCol) {
    const markdown = rows
      .map(row => { 
        let lines = this.#cell(row, valCol).split("\n");
        let output = this.#cell(row, keyCol) + "\n";
        output += ": " + lines[0] + "\n";
        output += lines.slice(1).map(line => "   " + line).join("\n");
        return output;
      }).join("\n\n");

    return markdown;
  }

  convertRequirements() {
    // Read building block code from the Concept sheet (if relevant)
    let buildingBlockCode = null;
    if (this.templateVersion == "v2") {
      const structNl = ExcelConvertor.structConcept[this.templateVersion]["nl"];
      const codeRow = this.#getRows(structNl.sheet).find(row => this.#cell(row, structNl.col.field) == structNl.key.code);
      if (!codeRow || !this.#cell(codeRow, structNl.col.description)) {
        console.error("Building block code is not defined on the Concept sheet of the Excel file");
        process.exit(1);
      }
      buildingBlockCode = this.#cell(codeRow, structNl.col.description).toUpperCase();
    }

    // Construct the resource
    const id = this.fileRoot;
    const canonical = this.canonicalBase + "/Requirements/" + id;
    const requirements = {
      resourceType: "Requirements",
      id: id,
      language: "nl",
      url: canonical,
      status: "active",
      statement: this.#getStatements(canonical, buildingBlockCode)
    };

    // Read out the file
    const outputFile = path.join(this.targetFolders.get("RequirementResources"), "Requirements-" + this.fileRoot + ".json");
    fs.writeFileSync(outputFile, JSON.stringify(requirements, null, 2), "utf8");
    console.log(`Wrote ${outputFile}`);
  }

  async getLogicalModel(adProject) {
    if (!adProject) {
      console.error("No ART-DECOR project defined for downloading logical models");
      process.exit(1);
    }
    const struct = ExcelConvertor.structConcept[this.templateVersion]["nl"];
    let rows = this.#getRows(struct.sheet);
    if (rows == null) return;
    
    rows = rows.filter(row => this.#cell(row, struct.col.field) == struct.key.ADId);
    let ad_id = "";
    if (rows.length == 1) {
      ad_id = this.#cell(rows[0], struct.col.description);
    }
    if (ad_id == "") {
      console.warn(`Skipping logical model for ${this.inputFile.name}: "${struct.key.ADId}" is empty or absent`);
      return;
    } 
    
    const id_parts = ad_id.split("/");
    const id_date = id_parts[1].replace(/-/g, "").replace(/:/g, "").replace("T", "");
    const fetch_url = `${serverSourceUrl}/fhir/4.0/${adProject}/StructureDefinition/${id_parts[0]}--${id_date}?_format=json&language=en-US`;
    try {
      const response = await fetch(`${fetch_url}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} - ${fetch_url}`);
      }

      const body = await response.json();
      normalizeResourceLanguages(body);
      
      const outputFile = path.join(this.targetFolders.get("LogicalModels"), this.fileRoot + ".json");
      fs.writeFileSync(outputFile, JSON.stringify(body, null, 2), 'utf8');
      console.log(`Saved LogicalModel to ${outputFile}`);

      if (this.valueSetDownloader) {
        await this.valueSetDownloader.downloadAll(this.#getBindingValueSetCanonicals(body));
      }
    } catch (error) {
      console.warn(`Couldn't download logical model for ${this.inputFile.name} from ART-DECOR using ${fetch_url}, "${error.message}"`);
      return;
    }
  }

  #getTemplateVersion() {
    for (const version of ["v1", "v2"]) {
      const sheet = this.workbook.Sheets[ExcelConvertor.structRequirements[version]["nl"]["sheet"]];
      if (sheet) {
        return version;
      }
    }
    return null;
  }

  /** Get the rows from the names sheet.
   *  The header row is assumed to be the second row, in accordance to the template.
   *  @returns An array of JSON objects, or null if the sheet was not found.
   */
  #getRows(sheetName) {
    const sheet = this.workbook.Sheets[sheetName];
    if (!sheet) {
      console.warn(`Skipping sheet "${sheetName}" in ${this.inputFile.name}: not found`);
      return null;
    }

    const rows = XLSX.utils.sheet_to_json(sheet, {
      defval: "",
      range: 1     // The header row is the second row in the template (row 1)
    })

    return rows;
  }

  #cell(row, colName) {
    const value = row[colName];
    return String(value ?? "").trim();
  }
  
  #getStatements(canonical, buildingBlockCode) {
    const structNl = ExcelConvertor.structRequirements[this.templateVersion]["nl"];
    const structEn = ExcelConvertor.structRequirements[this.templateVersion]["en"];
    let rowsNl = this.#getRows(structNl.sheet);
    if (rowsNl == null) return;

    const rowsEn = structEn.sheet ? this.#getRows(structEn.sheet) : null;

    let statements = [];
    for (let i = 0; i < rowsNl.length; i++) {
      const row = rowsNl[i];
      const rowEn = rowsEn ? rowsEn[i] : null;

      const key = this.#cell(row, structNl.col.number);
      if (!key) continue;
      
      let parentKey = null;
      if (this.templateVersion == "v1" && key.includes(".")) {
        parentKey = key.split(".").slice(0, -1).join(".");
      } else if (this.#cell(row, structNl.col.derivedFrom)) {
        parentKey = this.#cell(row, structNl.col.derivedFrom);
      }

      let label = "";
      let labelEn = "";
      const title = this.#cell(row, structNl.col.name);
      const titleEn = rowEn ? this.#cell(rowEn, structEn.col.name) : "";
      if (this.templateVersion == "v1") {
        label = title;
        labelEn = titleEn;
      } else {
        label = this.#cell(row, structNl.col.euOrNl) + ": " + buildingBlockCode + " " + title;
        labelEn = this.#cell(row, structNl.col.euOrNl) + ": " + buildingBlockCode + " " + (titleEn ? titleEn : title);
      }

      let requirementText = "";
      if (this.templateVersion == "v1") {
        requirementText = this.#createBodyText(row, [structNl.col.description, structNl.col.variability, structNl.col.presence, structNl.col.temp]);
      } else {
        requirementText = this.#createBodyText(row, [structNl.col.description, structNl.col.rationale, structNl.col.variability, structNl.col.presence, structNl.col.context]);
      }

      let requirementTextEn = null;
      if (rowEn) {
        requirementTextEn = this.#createBodyText(rowEn, [structEn.col.description, structEn.col.rationale, structEn.col.variability, structEn.col.presence, structEn.col.context]);
      }

      if (parentKey) {
        requirementText += `\n\nAanscherping van requirement [#${parentKey}](#${parentKey})`;
        requirementTextEn += `\n\nRefinement of requirement [#${parentKey}](#${parentKey})`;
      }

      if (this.#cell(row, structNl.col.addressed) == structNl.key.notAddressed) {
        requirementText += "\n\n**" + structNl.key.notAddressed + "**";
        requirementTextEn += "\n\n**" + structEn.key.notAddressed + "**";
      }

      let statement = {
        extension: [
          {
            url: "http://hl7.org/fhir/tools/StructureDefinition/requirements-statementshallnot",
            valueBoolean: false
          }
        ],
        key: key,
        label: label
      }
      statement = this.#addTranslationExtension(statement, "label", "en", "string", labelEn);
      statement.requirement = requirementText;
      statement = this.#addTranslationExtension(statement, "requirement", "en", "Markdown", requirementTextEn);

      if (parentKey) {
        statement.parent = `${canonical}#${parentKey}`;
      }

      // Source gets abused a bit, as it is not truly a reference of course
      const source = this.#cell(row, structNl.col.source);
      if (source) {
        if (this.templateVersion == "v1") {
          statement.source = [{ display: source }];
        } else {
          statement.source = source.split(",")
            .map(source => {
              const ref = this.sources[source.trim()];
              return {
                "reference": ref.url,
                "display": ref.name + " " + ref.version
              }
            })
        }
      }   

      statements.push(statement);
    
    }

    return statements;
  }

  #createBodyText(row, columns) {
    return columns
      .filter(col => this.#cell(row, col))
      .map(col => `* *${col}*: ${this.#cell(row, col)}`)
      .join("\n");
  }

  #addTranslationExtension(statement, elementName, language, dataType, value) {
    if (!value) return statement;

    dataType = dataType.charAt(0).toUpperCase() + dataType.slice(1).toLowerCase();
    let content = {
      "url": "content",
    }
    content["value" + dataType] = value;

    statement["_" + elementName] = {
      "extension": [
        {
          "url": "http://hl7.org/fhir/StructureDefinition/translation",
          "extension": [
            {
              "url": "lang",
              "valueCode": language
            },
            content
          ]
        }
      ]
    }
    return statement;
  }

  #getSources() {
    if (this.templateVersion != "v2") return {};
    const struct = ExcelConvertor.structSources[this.templateVersion]["nl"];
    const rows = this.#getRows(struct.sheet);
    if (rows == null) return {};

    let sources = {};

    for (const row of rows) {
      const key = this.#cell(row, struct.col.key);
      if (key == null) continue;

      if (key in sources) {
        console.log(`Duplicate source "${source}" found!`);
      }

      sources[key] = {
        "name": this.#cell(row, struct.col.name),
        "version": this.#cell(row, struct.col.version),
        "url": this.#cell(row, struct.col.url),
        "remarks": this.#cell(row, struct.col.remarks)
      }
    }

    return sources;
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

function parseSushiYaml() {
  const configPath = path.resolve("sushi-config.yaml");

  if (!fs.existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    process.exit(1);
  }

  let canonical = null;
  let adProject = null;
  try {
    const text = fs.readFileSync(configPath, "utf8");
    const config = YAML.parse(text);

    if (!"canonical" in config) {
      console.error("The canonical of this IG is not defined in sushi-config.yaml!");
    }
    canonical = config["canonical"];

    const igConfig = config?.["nictizIgConfig"];

    if (igConfig && Object.prototype.hasOwnProperty.call(igConfig, "ad-project")) {
      adProject = igConfig["ad-project"];
    } else {
      console.warn('Warning: there is no ART-DECOR project configured in sushi-config.yaml. Use the "ad-project" parameter in section "nictizIgCconfig" to do so.');
      adProject = null;
    }
  } catch (error) {
    console.error(`Could not read or parse ${configPath}: ${error.message}`);
    process.exit(1);
  }

  return {
    "canonicalBase": canonical,
    "adProject": adProject
  };
}

async function main() {
  commander.program
    .option("--requirements", "Create Requirements resources from Excel")
    .option("--actors", "Download ActorDefinitions from ART-DECOR")
    .option("--lm", "Download logical model StructureDefinitions from ART-DECOR")
    .option("--profile-artifacts", "Download referenced artifacts on ART-DECOR from profiles")
    .addOption(new commander.Option("--dont-descend", "When downloading material from ART-DECOR, don't download materials included from those materials").conflicts("profile-artifacts"))
    .argument('<inputFolder>')
    .argument('<outputFolder>')
  commander.program.parse()

  const config = parseSushiYaml();

  const inputFolder = commander.program.args[0];
  const outputFolder = commander.program.args[1];

  let createRequirements = commander.program.opts()['requirements'];
  let downloadActors = commander.program.opts()['actors'];
  let downloadLogicalModels = commander.program.opts()['lm'];
  let downloadArtifactsFromProfiles = commander.program.opts()['profileArtifacts']
  const descend = !(commander.program.opts()['dontDescend'] === true);
  if (!createRequirements && !downloadActors && !downloadLogicalModels && !downloadArtifactsFromProfiles) {
    // If no explicit action is given, do everything
    createRequirements = true;
    downloadActors = true;
    downloadLogicalModels = true;
    downloadArtifactsFromProfiles = true;
  }

  const targetFolders = new TargetFolders(outputFolder);

  if (downloadActors) {
    const actorDefinitionDownloader = new ActorDefinitionDownloader(config.adProject, targetFolders.get("Resources"));
    await actorDefinitionDownloader.downloadAll();
  }

  let valueSetDownloader = null;
  if ((downloadLogicalModels || downloadArtifactsFromProfiles) && descend) {
    valueSetDownloader = new ValueSetDownloader(config.adProject, targetFolders.get("Vocabulary"));
  }

  if (!fs.existsSync(inputFolder)) {
    return;
  }

  for (const excelFile of fs.readdirSync(path.join(inputFolder, "requirements"), {withFileTypes: true}).filter(file => /\.(xlsx|xlsm|xls)$/i.test(file.name)).filter(file => !file.name.startsWith('~$'))) {
    const convertor = new ExcelConvertor(excelFile, targetFolders, valueSetDownloader, config["canonicalBase"]);
    if (createRequirements) {
      convertor.createRequirements();
    }

    if (downloadLogicalModels) {
      await convertor.getLogicalModel(config.adProject);
    }
  }

  if (downloadArtifactsFromProfiles) {
    const profileFolder = path.join(inputFolder, "profiles");
    const profileValueSetCollector = new ProfileValueSetCollector(profileFolder);
    await valueSetDownloader.downloadAll(profileValueSetCollector.getBindingValueSetCanonicals());
  }

}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
