# Nictiz tooling for IGs
This repo contains the custom tools used by Nictiz for working with FHIR IG's.

These tools are all Node scripts, for the simple reason that Sushi is also a Node script, so the assumption is that Node is installed and working when building an IG.

# Installation
The tools in this repo are installed together on your computer. To do so:

    npm install -g github:Nictiz/Nictiz-tooling-for-IGs

The tools listed below can than be used as command line tools.

Alternatively, the tools can be installed locally for an IG repository, e.g. if the tools make a breaking change in the behavior:

    npm install github:Nictiz/Nictiz-tooling-for-IGs

This will put a folder called `node_modules` in your repo. Make sure to put it in your `.gitignore` file. Scripts can be run from this folder using:

    npm exec -- [script name] [arguments]

# Tools
## excel-to-artifacts
This is the most important script, as this is really the glue between the Excel based method to collect and document requirements and model choices within Nictiz, the ART-DECOR based method to define logical models and terminology artfiacts, and publications using a FHIR IG. More specifically, it does te following:

1. Convert the Concept tab in Excel to a Markdown file.
2. Convert the information requirements to a Requirements resource.
3. Download the logical model as noted on the Concept tab of the Excel as FHIR logical model.
4. Download linked ValueSets from the logical model or from FHIR-resources from ART-DECOR.
5. Download ActorDefinitions from ART-DECOR.

By default, the script does all these things. There are command line flags to perform specific actions.

The script requires two input arguments and one setting:

1. The `inputFolder` argument: the parent folder for the Excel files and FHIR profiles; the Excel files should be in a sub folder called "requirements" and the profiles in a sub folder called "profiles".
2. The `outputFolder` argument: the parent folder in which all output should be placed. This folder should be excluded from git.
3. The setting "ad-project" in the section "nictizIgConfig" of `sushi-config.yaml`. This should be the prefix of the ART-DECOR project this IG is linked to.

