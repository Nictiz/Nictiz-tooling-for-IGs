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
## lm-mindmap
Creates a D2 diagram and renders it to SVG for each logical model with a mapping to a Requirements resource, using `@d2lang/d2`.

    lm-mindmap <StructureDefinition.json> [more-files.json ...] --requirements <folder> --output-folder <folder>

Add `--debug` to also save `lm-mindmap-<model name>.d2` alongside the SVG. This source includes embedded icons and can be rendered independently.

The requirements folder is searched recursively for JSON Requirements resources. Models must have a name starting with `LogicalModel` and a root mapping identity starting with `requirements-<model name>`. The mapping URI selects the Requirements resource by its canonical URL. Missing Requirements resources produce a warning and the next model is processed.

Output files are named `lm-mindmap-<model name>.svg`. D2 source is compiled in memory. The diagram includes the snapshot root, mapped elements, and their ancestors. Node names use the final path segment in bold, followed by all `type.code` values. Nodes without types use the `container` class. Statement labels starting with `NL` or `EU` select `nl.png` or `eu.png`; nodes mapped to both use `eu-nl.png`. Icons are embedded in the SVG so it can be shared independently. Existing output files with the same name are overwritten.

## excel-to-artifacts
Converts Excel files for concept and requirements documentation to content that can be published in the IG:

* The Concept sheets (nl and en) are converted to Markdown pages.
* Information requirements are converted to FHIR Requirements resources.
* Optionally, an overview table in XHTML format is generated.

Invocation

    excel-to-artifacts <inputFolder> <outputFolder>

Excel files are searched for in `<inputFolder>/requirements`. The script assumes `sushi-config.yaml` is present to provide the base url.

The intended use is to generate this information on the fly and not add this information to git. In order to do this:

* Add `<outputFolder>` to `.gitignore`
* Add `<outputFolder>/pagecontent` to the `path-pages` parameter in `sushi-config.yaml`. The Markdown output will be placed here (and a translated version under `<outputFolder>/translations/...`, but this doesn't need to be address explicitly). The resulting Markdown files are not rendered as distinct pages, but can be included using the `{% include_local ... %}` tag.
* Add `<outputFolder>/requirements` to the `path-resource` parameter in `sushi-config.yaml`. The resulting Requirements resources are placed here.

If the `--overview` flag is given, a file called `overview.xml` will be placed in the pagecontent folder as well. This file has a table with the Dutch concept name, English concept name and building block code. It can be included using:

    {% include_relative overview.xml conceptNL="[Column name for Dutch concept]" conceptEN="[Column name for English concept]" conceptCode="[Column name for building block code]" %}

In addition, the script will fail with a non-zero exit code if a duplicate building block code is detected.

## get-from-ad
Downloads artifacts from the ART-DECOR project configured by `nictizIgConfig.ad-project` in `sushi-config.yaml` in the working directory.

    Usage: get-from-ad [options] <outputFolder>

    Arguments:
    outputFolder                  The root of the folder to place the downloaded artifacts in. Different sub folders will be used for different kinds of artifacts.

    Options:
    --actors                      Download ActorDefinitions
    --lm <folder>                 Download logical models referenced by Excel files in this folder, including their associated ValueSets
    --profile-artifacts <folder>  Download ValueSets referenced by XML profiles in this folder
    --dont-descend                Do not download ValueSets referenced by logical models
    --cache-folder <folder>       Folder to cached downloaded artifacts. If used, subsequent runs will only download artifacts if they are changed on the server.
    -h, --help                    display help for command

The downloader uses `excel-to-artifacts.js` to read the adId keys from the Excel files.

Downloaded artifacts go into `<outputFolder>/resources`, `<outputFolder>/logicalmodels`, and `<outputFolder>/vocabulary`. Existing files are preserved, with matching filenames overwritten; obsolete downloads are not automatically removed.

The intended use is to not add the downloaded artifacts to git, so that ART-DECOR is the single source of truth. To do so:

* Add `<outputFolder>` to `.gitignore`
* Add `<outputFolder>/resources`, `<outputFolder>/logicalmodels` and `<outputFolder>/vocabulary` to `path-resource` parameter in `sushi-config.yaml`.

Also, it is strongly encouraged to use the caching mechanism. When used, the script will check on ART-DECOR what date the latest edits were made to determine if the cached version of an artifact can be used. A good cache folder in a typical IG setup is a sub folder under the `temp` dir.

## sync-profiles
This script is used to match cardinality, value set bindings, and obligations defined in the logical model against those defined in the FHIR profiles. This is based on the mapping elements in the profiles, which are used to relate profile elements to elements in the logical model.

The script can either be used to check if these definitions align, or to actually copy over these definitions to the profiles. The check mode can be used as an automated QA process. There could be good reasons for definitions to not align exactly, e.g. when there is an inexact match between the model and FHIR a deliberate exception can be made. For this reasons, known exceptions can be documented in the known-issues.yaml file. For the same reason, it is discouraged to use the copy mode of the script as part of an automated process. If there are deliberate mismatches, you don't want to overwrite them; setting of changing obligations should be a conscious process.

For details, run `sync-profiles --help`.

## profile-differences
FHIR profiles may impose an indirect relationship with other profiles using the the [imposeProfile](http://hl7.org/fhir/StructureDefinition/structuredefinition-imposeProfile) or [compliesWithProfile]() extensions. The IG Publisher shows this relation and can check these claims, but it cannot visualize the differences.

This script is meant to collect the changes that have been made in the profile with regards to the referenced profile, in order to visualize this in the IG. Currently, it looks at:

* Cardinality
* Binding (valueSet and strength)
* Additional bindings
* Extensions defined in the profile

There are two possible outputs:

1. Rebased profiles; new profiles that have their base definition replaced by the referenced profile. These could be added to the IG to provide a differential view. This should be done with care, as the inclusion of these profiles could be misleading to the user.
2. CVS files; these follow roughly same format as the mapping tables in the HL7 Europe FHIR IGs. This is a safer option, but contain less information.

**Warning 1**: This script is not meant to check if these changes are allowed! It just identifies a change, so don't use this script as a QA tool. The IG Publisher can detect some of these errors.

**Warning 2**: This script is, by design, not complete. It doesn't consider other information than the list mentioned above; this is considered the relevant info for users, without cluttering the difference view with minor details like aliases.

**Warning 3**: This script requires profile snapshots to work, and assumes JSON input. If the profiles are not in this format, they need to be converted using the HL7 Validator. For this to work, Java needs to be present on the system and the Validator should be downloaded in `.jar` format to the parent folder of where this script is run (or be referenced using the `--validatorJar` flag).

Usage:

    Usage: profile-differences [options] <profiles...>

    Find differences for profiles and the profiles they claim an imposeProfile or compliesWithProfile relationship to.

    Arguments:
    profiles                        Input profile files or wildcard patterns (*, ?, **). JSON snapshots are required unless --profile-cache is given.

    Options:
    --rebased-profiles <directory>  When given, create rebased profiles (af if their base definition was the related profile) in the specified directory.
    --csv-reports <directory>       When given, create difference reports in CSV format in the specified directory. Existing CSV files will be overwritten, but manually added notes in the "Notes" column are retained.
    --language <language>           Report language (repeatable; built in: en, nl; default: en)
    --validator-jar <path>          Validator JAR (default: ../validator_cli.jar relative to the working directory)
    --snapshot-cache <directory>    Enable input profile snapshot caching in this directory
    --package-cache <directory>     FHIR package cache (default: "C:\\Users\\edelman_nict1\\.fhir\\packages")
    --ig <directory>                Additional folder for snapshot generation (repeatable). By default, the input folders are included. (default: [])
    -h, --help                      display help for command

When creating CSV reports, the assumption is that they will be added to git; there's a column called "Notes"/"Opmerkingen" that can and should be used to document these changes. On subsequent runs, the script will detect if the content of these CSV files is out of date. These CSV files can be edited and visualized using the csv-to-mapping tool from this repo.

The last options all relate to snapshot generation. If the script needs to generate snapshots, it is strongly encouraged to use the `--snapshot-cache` option as this is a computationally expensive operation. A good folder in a typical IG repository would be to create a sub folder in the `temp` folder for this.

## csv-to-mapping
Generate XHTML mapping tables in the format of the eu-core guides from a CSV file.

    csv-to-mapping <inputFolder>/*.csv --outputFolder <outputFolder>

The recommended use case is to not add the resulting XML files to git, but to generate them on the fly and use the CSV files as the single source of truth. To do so:

* Add `<outputFolder>` to `.gitignore`
* Add `<outputFolder>` to the `path-pages` parameter in `sushi-config.yaml`. The resulting Markdown files are not rendered as distinct pages, but can be included using the `{% include_local ... %}` tag.

As for the CSV format:

* The first two lines must each contain a Markdown link, `[DisplayName](https://canonical-url)`, identifying the source and target artifacts.
* The third record supplies group headers: each nonempty cell starts a new group, spanning subsequent empty cells until the next group or the end of the columns. The first cell must name a group. Group names matching the source or target display name link to that artifact, including local URL conversion.
* The fourth record supplies the actual column headers, preserved in order.
* Data starts in the fifth record.

Both header rows are written to the XML table. Quoted commas, escaped quotes, multiline cells, and UTF-8 are supported. Lines beginning with `* ` or `- ` render as HTML bullet lists; other cell content is escaped text with line breaks. Every column named `Element` will be rendered as links to the source artifact. Other columns render as text; general Markdown and raw HTML are not interpreted.

## translate-menu
This is really a workaround for the way menu's are defined in FHIR IG's. The IG Publisher requires a verbatim XML fragment to included, which is not really human-maintainable. Sushi puts a wrapper in from of this, allowing you to define the menu structure in `sushi-config.yaml`. However, Sushi doesn't offer a translation mechanism, which is where this script comes in. It reads the menu entries from `sushi-config.yaml`, then loads translations from the `menu.po` translation file in the `input/translations/[language]` folder, then takes the `menu.xml` generated by Sushi, and generates a translated version. Finally, it will write out `menu.po` again with all translated and untranslated menu entries, to further work on the translation.

WARNING: this whole method interferes with Sushi if you're not careful. _If_ a `menu.xml` is present in the input folder, Sushi won't overwrite it. But if `menu.xml` is _not_ present in the input folder, the IG Publisher doesn't pick up translations. So in order for this to work, you need to take care of the following:

1. Make sure that in the calling script, remove `menu.xml` from the before running Sushi input folder.
2. Make sure `menu.xml` and its translations are in `.gitignore`, so as not to accidentally commit them.
2. Run this script after calling Sushi to provide the translation.

For details about running the script, run `translate-menu --help`.

