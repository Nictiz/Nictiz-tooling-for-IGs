#!/usr/bin/env node

const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const commander = require("commander");
const { parseSushiYaml } = require("./ig-config");

const translationExtensionUrl = "http://hl7.org/fhir/StructureDefinition/translation";

class TargetFolders {
  static subfolders = {
    "RequirementResources": "requirements",
    "PageContent":          "pagecontent",
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

  constructor(inputFile, targetFolders, canonicalBase) {
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

  getLogicalModelId() {
    if (this.templateVersion == null) return null;
    const struct = ExcelConvertor.structConcept[this.templateVersion]["nl"];
    let rows = this.#getRows(struct.sheet);
    if (rows == null) return null;
    
    rows = rows.filter(row => this.#cell(row, struct.col.field) == struct.key.ADId);
    let ad_id = "";
    if (rows.length == 1) {
      ad_id = this.#cell(rows[0], struct.col.description);
    }
    if (ad_id == "") {
      console.warn(`Skipping logical model for ${this.inputFile.name}: "${struct.key.ADId}" is empty or absent`);
      return null;
    } 
    
    return ad_id;
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


}

function getExcelFiles(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder, { withFileTypes: true })
    .filter(file => file.isFile() && /\.(xlsx|xlsm|xls)$/i.test(file.name) && !file.name.startsWith("~$"))
    .map(file => ({ name: file.name, parentPath: folder }));
}

function getLogicalModelReferences(inputFolder) {
  const references = [];
  for (const file of getExcelFiles(inputFolder)) {
    const convertor = new ExcelConvertor(file);
    const adId = convertor.getLogicalModelId();
    if (adId) references.push({ adId, fileRoot: convertor.fileRoot });
  }
  return references;
}

async function main() {
  commander.program
    .argument("<inputFolder>")
    .argument("<outputFolder>")
    .parse();
  const config = parseSushiYaml();
  const [inputFolder, outputFolder] = commander.program.args;
  const targetFolders = new TargetFolders(outputFolder);
  for (const file of getExcelFiles(inputFolder)) {
    new ExcelConvertor(file, targetFolders, config.canonicalBase).createRequirements();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { getLogicalModelReferences };
