const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

class IgConfig {
  #canonicalBase;
  #adProject;
  #dependencies;

  constructor() {
    const configPath = path.resolve("sushi-config.yaml");

    if (!fs.existsSync(configPath)) {
      console.error(`Config file not found: ${configPath}`);
      process.exit(1);
    }

    let canonical = null;
    let adProject = null;
    let dependencies = {};
    try {
      const text = fs.readFileSync(configPath, "utf8");
      const config = YAML.parse(text);

      if (!("canonical" in config)) {
        console.error("The canonical of this IG is not defined in sushi-config.yaml!");
      }
      canonical = config["canonical"];
      dependencies = config.dependencies || {};

      const igConfig = config?.["nictizIgConfig"];

      if (igConfig && Object.prototype.hasOwnProperty.call(igConfig, "ad-project")) {
        adProject = igConfig["ad-project"];
      }
    } catch (error) {
      console.error(`Could not read or parse ${configPath}: ${error.message}`);
      process.exit(1);
    }

    this.#canonicalBase = canonical;
    this.#adProject = adProject;
    this.#dependencies = dependencies;
    }

    get canonicalBase() { return this.#canonicalBase; }
    get adProject() { return this.#adProject; }
    get dependencies() { return this.#dependencies; }

    get formattedDependencies() {
      return Object.entries(this.dependencies).map(([id, dependency]) => {
        const version = typeof dependency === 'object' && dependency !== null ? dependency.version : dependency;
        if (typeof version !== 'string' || !version) {
          throw new Error(`Missing or invalid version for dependency ${id} in sushi-config.yaml`);
        }
        return `${id}#${version}`;
      });
    }
  }

  module.exports = { IgConfig };
