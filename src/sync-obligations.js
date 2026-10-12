#!/usr/bin/env node

const commander = require("commander");
const fs = require("node:fs");
const path = require("node:path");
const { Fhir } = require("fhir-tool");
const { parseAllDocuments, isMap, isSeq } = require("yaml");

const OBLIGATION_URL = "http://hl7.org/fhir/StructureDefinition/obligation";

const YAML_FORMAT = `
...
[profile id]:
  unmatched obligations:
    [path of the element]:
      - actor: [canonical url for the actor that doesn't match]
        reason: [explanation for the mismatch]
      - actor: [canonical url for another actor that doesn't match]
        reason: [explanation for the mismatch]
...
`;

class Suppressions {
  #suppressions = new Map();

  constructor(filename) {
    if (!filename) return;

    let documents = [];
    try {
      documents = parseAllDocuments(fs.readFileSync(filename, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read YAML file "${filename}": ${getErrorMessage(error)}`);
    }
    for (const document of documents) {
      this.#parseYAMLDocument(document);
    }
  }

  #parseYAMLDocument(document) {
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
      throw new Error(`Suppression file must contain a YAML object.`);
    }

    for (const pair of document.contents.items) {
      const profileId = pair.key.value;
      const profileConfiguration = pair.value;

      if (!isMap(profileConfiguration)) continue;

      const unmatchedObligations = profileConfiguration.get("unmatched obligations");
      if (unmatchedObligations === undefined) continue;

      if (unmatchedObligations === null || typeof unmatchedObligations !== "object" || Array.isArray(unmatchedObligations)) {
        throw new Error(`"unmatched obligations" for profile "${profileId}" must be an object keyed by profile path:\n${CliParser.YAML_FORMAT}`);
      }

      let profilePaths = new Map();
      if (this.#suppressions.has(profileId)) {
        profilePaths = this.#suppressions.get(profileId); // Merge with the suppressions from another YAML document
      }
      for (const pair of unmatchedObligations.items) {
        const profilePath = pair.key.value;
        const entries = pair.value;
        if (!isSeq(entries)) {
          throw new Error(`Suppressions for path "${profilePath}" must be a list:\n${CliParser.YAML_FORMAT}`);
        }

        let actors = new Set();
        if (profilePaths.has(profilePath)) {
          actors = profilePaths.get(profilePath);
        }
        for (const entry of entries.items) {
          if (!isMap(entry)) {
            throw new Error(`Each suppression for path "${profilePath}" must be an object:\n${CliParser.YAML_FORMAT}`);
          }

          if (!entry.get("actor")) {
            throw new Error(`The suppression for path "${profilePath}" must have an actor:\n${CliParser.YAML_FORMAT}`);
          }

          if (!entry.get("reason")) {
            throw new Error(`The suppression reason for path "${profilePath}" and actor "${entry.actor}" must be provided as a string:\n${CliParser.YAML_FORMAT}`);
          }
          actors.add(entry.get("actor"));
        }
        profilePaths.set(profilePath, actors);
      }
      this.#suppressions.set(profileId, profilePaths);
    }
  }

  get(profileId, profilePath, actor) {
    return this.#suppressions.get(profileId)?.get(profilePath)?.has(stripVersionFromCanonical(actor));
  }
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function stripVersionFromCanonical(canonical) {
  return canonical.trim().split("|")[0];
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:` + canonicalJson(value[key]))
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
class LogicalModelRegistry {
  #modelsByUrl = new Map();

  constructor(folder, structureDefinitionHandler) {
    const absoluteFolder = path.resolve(folder);

    if (!fs.existsSync(absoluteFolder)) {
      throw new Error(`Logical model folder does not exist: "${absoluteFolder}".`);
    }
    if (!fs.statSync(absoluteFolder).isDirectory()) {
      throw new Error(`Logical model path is not a folder: "${absoluteFolder}".`);
    }

    const jsonFiles = this.#findJsonFiles(absoluteFolder);
    if (jsonFiles.length === 0) {
      throw new Error(`No JSON files found in logical-model folder "${absoluteFolder}".`);
    }

    for (const filename of jsonFiles) {
      const logicalModel = structureDefinitionHandler.readJson(filename);
      const canonicalUrl = stripVersionFromCanonical(logicalModel.url);

      if (this.#modelsByUrl.has(canonicalUrl)) {
        const existing = this.#modelsByUrl.get(canonicalUrl);

        throw new Error(`Duplicate logical-model canonical URL "${canonicalUrl}" in:\n` +
            `  ${existing.filename}\n` +
            `  ${filename}`
        );
      }

      this.#modelsByUrl.set(canonicalUrl, {
        filename,
        logicalModel,
        elementIndex: this.#buildElementIndex(logicalModel, filename),
      });
    }
  }

  get size() {
    return this.#modelsByUrl.size;
  }

  get(canonicalUrl) {
    return this.#modelsByUrl.get(stripVersionFromCanonical(canonicalUrl));
  }

  has(canonicalUrl) {
    return this.#modelsByUrl.has(stripVersionFromCanonical(canonicalUrl));
  }

  entries() {
    return this.#modelsByUrl.entries();
  }

  #findJsonFiles(folder) {
    const files = [];

    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);

      if (entry.isDirectory()) {
        files.push(...this.#findJsonFiles(filename));
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".json") {
        files.push(filename);
      }
    }

    return files.sort();
  }

  #buildElementIndex(logicalModel, filename) {
    const index = new Map();

    // Prefer snapshot over differential.
    let elements = [];
    if (logicalModel.snapshot) {
      elements = logicalModel.snapshot.element ?? [];
    } else if (logicalModel.differential) {
      elements = logicalModel.differential.element ?? [];
    }

    for (const element of elements) {
      if (!element.path) continue;
      if (index.has(element.path)) {
        throw new Error(`Logical model "${filename}" contains duplicate element path "${element.path}".`);
      }
      index.set(element.path, element);
    }
    if (index.size === 0) {
      throw new Error(`Logical model "${filename}" has no snapshot or differential elements.`);
    }

    return index;
  }
}

class ObligationComparator {
  constructor(profile, logicalModelRegistry, actors, suppressions) {
    this.profile = profile;
    this.logicalModelRegistry = logicalModelRegistry;
    this.actors = actors;
    this.suppressions = suppressions;
    this.mappingContexts = this.#createMappingContexts();
  }

  get hasMatchingMappings() {
    return this.mappingContexts.length > 0;
  }

  copy() {
    // We simply copy both to the snapshot and the differential and assume
    // they are in sync. Other tools will check this.
    if (this.profile.differential) {
      this.#copyObligations(this.profile.differential.element);
    }
    if (this.profile.snapshot) {
      this.#copyObligations(this.profile.snapshot.element);
    }
  }

  report() {
    if (this.profile.differential) {
      return this.#reportDiscrepancies(this.profile.differential.element);
    }
    if (this.profile.snapshot) {
      return this.#reportDiscrepancies(this.profile.snapshot.element);
    }

    return {
      discrepancyCount: 0,
      suppressedCount: 0,
    };
  }

  #createMappingContexts() {
    const contexts = [];

    for (const mapping of this.profile.mapping ?? []) {
      if (!mapping.identity || !mapping.uri) continue;

      const registryEntry = this.logicalModelRegistry.get(mapping.uri);
      if (!registryEntry) continue;

      contexts.push({
        mappingIdentity: mapping.identity,
        mappingUri: stripVersionFromCanonical(mapping.uri),
        logicalModel: registryEntry.logicalModel,
        logicalModelFilename: registryEntry.filename,
        logicalModelIndex: registryEntry.elementIndex,
      });
    }

    return contexts;
  }

  #copyObligations(elements) {
    for (const profileElement of elements) {
      profileElement.extension ??= [];

      const existingObligations = new Set(this.#getObligations(profileElement).map(canonicalJson));

      for (const context of this.mappingContexts) {
        const targetElements = this.#resolveTargetElements(profileElement, context);

        for (const logicalModelElement of [...targetElements].filter(el => (el != null))) {
          console.log(profileElement)
          for (const obligation of this.#getObligations(logicalModelElement)) {
            if (!this.#obligationAppliesToActors(obligation)) {
              continue;
            }

            const canonicalObligation = canonicalJson(obligation);

            if (existingObligations.has(canonicalObligation)) {
              continue;
            }

            profileElement.extension.push(structuredClone(obligation));
            profileElement.mustSupport = true;
            existingObligations.add(canonicalObligation);

            console.log(`Copied obligation from ${context.logicalModel.url}# ${logicalModelElement.path} to ${profileElement.path ?? profileElement.id}`);
          }
        }
      }

      if (profileElement.extension.length === 0) {
        delete profileElement.extension;
      }
    }
  }

  #reportDiscrepancies(elements) {
    const result = {
      discrepancyCount: 0,
      targetMissingCount: 0,
      suppressedCount: 0,
    };

    for (const profileElement of elements) {
      for (const context of this.mappingContexts) {
        for (const logicalModelElement of this.#resolveTargetElements(profileElement, context)) {
          if (logicalModelElement == null) {
            result.targetMissingCount += 1;
            continue;
          }

          const profileObligationsByActor = this.#getActorObligations(profileElement);
          const modelObligationsByActor = this.#getActorObligations(logicalModelElement);

          for (const actor of this.actors) {
            const profileObligations = profileObligationsByActor.get(actor);
            const modelObligations = modelObligationsByActor.get(actor);

            let discrepancyType;

            if (modelObligations.present && !profileObligations.present) {
              discrepancyType = "missing-in-profile";
            } else if (!modelObligations.present && profileObligations.present) {
              discrepancyType = "missing-in-model";
            } else if (modelObligations.present && profileObligations.present && !this.#setsAreEqual(modelObligations.codes, profileObligations.codes)) {
              discrepancyType = "different-codes";
            }
            if (!discrepancyType) continue;

            const suppressionReason = this.suppressions.get(this.profile.id, profileElement.path, actor);

            if (suppressionReason !== undefined) {
              result.suppressedCount += 1;
              continue;
            }

            result.discrepancyCount += 1;
            this.#reportDiscrepancy(discrepancyType, profileElement, logicalModelElement, context, actor, modelObligations.codes, profileObligations.codes);
          }
        }
      }
    }

    return result;
  }

  #reportDiscrepancy(type, profileElement, logicalModelElement, context, actor, modelCodes, profileCodes) {
    console.log();

    switch (type) {
      case "missing-in-profile":
        console.log("OBLIGATION MISSING IN PROFILE");
        console.log(
          "  The logical model contains an " +
            "obligation for this actor, but " +
            "the profile does not."
        );
        break;

      case "different-codes":
        console.log("OBLIGATION CODES DIFFER");
        console.log(
          "  The logical model and profile " +
            "contain obligations for this actor, " +
            "but their obligation codes differ."
        );
        break;

      case "missing-in-model":
        console.log("OBLIGATION MISSING IN LOGICAL MODEL");
        console.log(
          "  The profile contains an obligation " +
            "for this actor, but the logical model " +
            "does not."
        );
        break;

      default:
        throw new Error(
          `Unknown discrepancy type "${type}".`
        );
    }

    console.log(`  Profile: ${this.profile.id}`);
    console.log(`  Profile element: ` + `${profileElement.path ?? profileElement.id}`);
    console.log(`  Logical model: ` + `${context.logicalModel.url}`);
    console.log(`  Logical model file: ` + `${context.logicalModelFilename}`);
    console.log(`  Logical model element: ` + `${logicalModelElement.path ?? logicalModelElement.id}`);
    console.log(`  Actor: ${actor}`);
    console.log(`  Logical model codes: ` + this.#formatCodes(modelCodes));
    console.log(`  Profile codes: ` + this.#formatCodes(profileCodes));
  }

  #resolveTargetElements(profileElement, context) {
    const targets = this.#getMappingTargets(profileElement, context.mappingIdentity);
    const resolvedElements = new Set();

    for (const target of targets) {
      const logicalModelElement = this.#resolveMapTargetToElement(target, context.logicalModelIndex);
      if (!logicalModelElement) {
        console.warn(`Mapping target not found in logical model "${context.logicalModel.url}": ${target} (from ${profileElement.path ?? profileElement.id})`);
        resolvedElements.add(null);
      } else {
        resolvedElements.add(logicalModelElement);
      }
    }

    return resolvedElements;
  }

  #getMappingTargets(profileElement, mappingIdentity) {
    return (profileElement.mapping ?? [])
      .filter(mapping => mapping.identity === mappingIdentity && typeof mapping.map === "string")
      .map(mapping => mapping.map.trim())
      .filter(Boolean);
  }

  #resolveMapTargetToElement(mapping, logicalModelIndex) {
    const candidates = [
      mapping,
      mapping.split("|")[0].trim(),
      mapping.replace(/\s+\([^)]*\)\s*$/, "").trim(),
    ];

    const resolvedPath = candidates.find(candidate => logicalModelIndex.has(candidate));

    return resolvedPath ? logicalModelIndex.get(resolvedPath) : undefined;
  }

  #getObligations(element) {
    return (element.extension ?? [])
      .filter(extension => extension.url === OBLIGATION_URL);
  }

  #getObligationActors(obligation) {
    return (obligation.extension ?? [])
      .filter(extension => extension.url === "actor" && typeof extension.valueCanonical === "string")
      .map(extension => stripVersionFromCanonical(extension.valueCanonical));
  }

  #getObligationCodes(obligation) {
    return (obligation.extension ?? [])
      .filter(extension => extension.url === "code" && typeof extension.valueCode === "string")
      .map(extension => extension.valueCode);
  }

  #obligationAppliesToActors(obligation) {
    const obligationActors = this.#getObligationActors(obligation);

    // Obligations without an actor are deliberately excluded.
    if (obligationActors.length === 0) {
      return false;
    }

    return obligationActors.some(actor => this.actors.has(actor));
  }

  #getActorObligations(element) {
    const obligationsByActor = new Map();

    for (const actor of this.actors) {
      obligationsByActor.set(actor, {
        present: false,
        codes: new Set(),
      });
    }

    for (const obligation of this.#getObligations(element)) {
      const obligationActors = this.#getObligationActors(obligation);
      const obligationCodes = this.#getObligationCodes(obligation);

      for (const actor of obligationActors) {
        if (!this.actors.has(actor)) {
          continue;
        }

        const actorObligations = obligationsByActor.get(actor);
        actorObligations.present = true;
        for (const code of obligationCodes) {
          actorObligations.codes.add(code);
        }
      }
    }

    return obligationsByActor;
  }

  #setsAreEqual(left, right) {
    if (left.size !== right.size) {
      return false;
    }

    return [...left].every(
      (value) => right.has(value)
    );
  }

  #formatCodes(codes) {
    if (codes.size === 0) {
      return "(no code)";
    }

    return [...codes].sort().join(", ");
  }
}

class StructureDefinitionHandler {
  constructor() {
    this.fhir = new Fhir();
  }

  readXML(filename) {
    const sd = this.fhir.xmlToObj(fs.readFileSync(filename, "utf8"));
    this.validate(sd, filename);
    return sd;
  }

  readJson(filename) {
    let sd;
    try {
      sd = JSON.parse(fs.readFileSync(filename, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read JSON file "${filename}": ${getErrorMessage(error)}`);
    }
    this.validate(sd, filename);
    return sd;
  }

  writeXML(structureDefinition, filename) {
    const xml = this.#addXmlDeclaration(this.fhir.objToXml(structureDefinition));
    fs.writeFileSync(filename, `${xml.trimEnd()}\n`, "utf8");
  }

  validate(resource, filename) {
    if (resource?.resourceType !== "StructureDefinition") {
      throw new Error(`"${filename}" does not contain a FHIR StructureDefinition.`);
    }
    if (!resource.id) {
      throw new Error(`"${filename}" does not have a StructureDefinition.id.`);
    }
    if (!resource.url) {
      throw new Error(`"${filename}" does not have a StructureDefinition.url.`);
    }
  }

  #addXmlDeclaration(xml) {
    if (/^\s*<\?xml\b/.test(xml)) {
      return xml;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
  }
}

function parseArgs() {
    commander.program
      .requiredOption("--lm-folder <folder>", "Folder containing logical model StructureDefinitions in JSON format. Searched recursively; StructureDefinitions are indexed by canonical URL.")
      .requiredOption("--actor <canonical>", "ActorDefinition canonical to check. Repeat this option to check multiple actors. Canonical versions are ignored; obligations without an actor are ignored.", (value, previous) => previous.concat([value]), [])
      .option("--copy", "Copy matching obligation extensions from logical models to profiles and update the profile XML files in place.")
      .addOption(new commander.Option("--suppressions <file.yaml>", "Suppress known discrepancies in check mode. Cannot be used in copy mode.").conflicts("--copy"))
      .argument("<profile.xml...>", "One or more FHIR profile StructureDefinitions in XML format.")
      .addHelpText("after", `

Suppression file format:

${YAML_FORMAT.trim().split("\n").map((line) => `  ${line}`).join("\n")}`);
    
    commander.program.parse();

    return commander.program;
}

function main() {
  const cliParser = parseArgs();
  const cliOptions = cliParser.opts();
  const profiles = cliParser.args;

  const sdHandler = new StructureDefinitionHandler();

  const lmRegistry = new LogicalModelRegistry(cliOptions.logicalModelFolder, sdHandler);
  console.log(`Indexed ${lmRegistry.size} logical ${lmRegistry.size === 1 ? "model" : "models"}.`);

  const selectedActors = new Set(cliOptions.actors.map(stripVersionFromCanonical));
  console.log("Actors:");
  for (const actor of selectedActors) {
    console.log(`  ${actor}`);
  }

  const suppressions = new Suppressions(cliOptions.suppressionsFilename);

  let totalDiscrepancyCount = 0;
  let totalTargetMissingCount = 0;
  let totalSuppressedCount = 0;
  let processedProfileCount = 0;
  let skippedProfileCount = 0;

  for (const profileFilename of profiles) {
    const profile = sdHandler.readXML(profileFilename);
    const comparator = new ObligationComparator(profile, lmRegistry, selectedActors, suppressions);

    console.log();
    console.log(`Profile: ${profile.id} (${path.resolve(profileFilename)})`);

    if (!comparator.hasMatchingMappings) {
      console.warn("  No profile mappings refer to an indexed logical model.");
      skippedProfileCount += 1;
      continue;
    }
    processedProfileCount += 1;

    if (cliOptions.copy) {
      console.log("  Mode: copy");
      comparator.copy();
      sdHandler.writeXML(comparator.profile, profileFilename);
      console.log(`  Updated: ${path.resolve(profileFilename)}`);
      continue;
    }

    console.log("  Mode: report");
    const result = comparator.report();
    totalDiscrepancyCount += result.discrepancyCount;
    totalTargetMissingCount += result.targetMissingCount;
    totalSuppressedCount += result.suppressedCount;
    if (result.discrepancyCount === 0) {
      console.log("  No unsuppressed obligation discrepancies found.");
    } else {
      console.log(`  Found ${result.discrepancyCount} unsuppressed obligation ${result.discrepancyCount === 1 ? "discrepancy" : "discrepancies"}.`);
    }

    if (result.suppressedCount > 0) {
      console.log(`  Suppressed ${result.suppressedCount} obligation ${result.suppressedCount === 1 ? "discrepancy" : "discrepancies"}.`);
    }
  }

  console.log();
  console.log(`Processed profiles: ${processedProfileCount}`);
  if (skippedProfileCount > 0) {
    console.log(`Profiles without matching logical-model mappings: ${skippedProfileCount}`);
  }
  if (!cliParser.options.copy) {
    console.log(`Unsuppressed discrepancies: ${totalDiscrepancyCount}`);
    console.log(`Mappings to non-existing model elements: ${totalTargetMissingCount}`);
    console.log(`Suppressed discrepancies: ${totalSuppressedCount}`);
    if (totalDiscrepancyCount > 0 || totalTargetMissingCount > 0) {
      process.exitCode = 2;
    }
  }
}

main()
