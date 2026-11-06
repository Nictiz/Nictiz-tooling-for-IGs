const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

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

    if (!("canonical" in config)) {
      console.error("The canonical of this IG is not defined in sushi-config.yaml!");
    }
    canonical = config["canonical"];

    const igConfig = config?.["nictizIgConfig"];

    if (igConfig && Object.prototype.hasOwnProperty.call(igConfig, "ad-project")) {
      adProject = igConfig["ad-project"];
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

module.exports = { parseSushiYaml };
