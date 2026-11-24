#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const { parsePo, translationFor } = require('./po');
const commander = require("commander");

function parseArgs(argv) {

    commander.program
        .requiredOption("--lang [language]", "The language to translate to")
        .requiredOption("--fshFolder [fsh folder]", "The folder where generated fsh artifacts are placed", "fsh-generated")
        .requiredOption("--inputFolder [input folder]", "The folder used as input folder for the IG publisher", "input")
    commander.program.parse();

    return commander.program.opts();
}

function collectMenuKeys(menu) {
    if (!menu || typeof menu !== 'object' || Array.isArray(menu)) {
        throw new Error('The YAML file must contain a mapping named "menu".');
    }

    const keys = new Set();
    function visit(mapping) {
        for (const [key, value] of Object.entries(mapping)) {
            keys.add(key);
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                visit(value);
            }
        }
    }
    visit(menu);
    return Array.from(keys);
}

function poQuote(value) {
    return JSON.stringify(value);
}

function renderPoEntry(key, translation, comments = []) {
    const lines = [];
    for (const comment of comments) lines.push(comment);
    lines.push(`msgid ${poQuote(key)}`);
    lines.push(`msgstr ${poQuote(translation)}`);
    return lines.join('\n');
}

function buildPo(keys, sourceEntries) {
    const header = sourceEntries.find(
        (entry) => entry.msgid === '' && !entry.msgctxt,
    );

    const byMsgid = new Map();
    for (const entry of sourceEntries) {
        if (entry.msgid && !entry.msgctxt && !byMsgid.has(entry.msgid)) {
            byMsgid.set(entry.msgid, entry);
        }
    }

    const blocks = [];
    if (header) {
        blocks.push(renderPoEntry('', translationFor(header), header.comments));
    } else {
        blocks.push(renderPoEntry('', ''));
    }

    for (const key of keys) {
        const sourceEntry = byMsgid.get(key);
        blocks.push(renderPoEntry(
            key,
            translationFor(sourceEntry),
            sourceEntry ? sourceEntry.comments : [],
        ));
    }
    return `${blocks.join('\n\n')}\n`;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeXml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function translateXml(xml, keys, sourceEntries) {
    const translations = [];
    const byMsgid = new Map();
    for (const entry of sourceEntries) {
        if (entry.msgid && !entry.msgctxt && !byMsgid.has(entry.msgid)) {
            byMsgid.set(entry.msgid, entry);
        }
    }

    for (const key of keys) {
        const translation = translationFor(byMsgid.get(key));
        if (translation) translations.push({ key, translation });
    }

    if (translations.length === 0) return xml;

    // Longest first avoids a shorter key winning when one key contains another.
    translations.sort((a, b) => b.key.length - a.key.length);
    const pattern = new RegExp(
        translations.map(({ key }) => escapeRegExp(key)).join('|'),
        'g',
    );
    const replacements = new Map(
        translations.map(({ key, translation }) => [key, escapeXml(translation)]),
    );
    return xml.replace(pattern, (match) => replacements.get(match));
}

function main() {
    const args = parseArgs();

    const poPath = `${args['inputFolder']}/translations/${args['lang']}/menu.po`;
    const xmlInPath = `${args['fshFolder']}/includes/menu.xml`;
    const xmlDestPath = `${args['inputFolder']}/includes/menu.xml`;
    const xmlTranslatedPath = `${args['inputFolder']}/translations/en/includes/menu.xml`;

    const yamlDocument = yaml.parse(fs.readFileSync('sushi-config.yaml', 'utf8'));
    const keys = collectMenuKeys(yamlDocument && yamlDocument.menu);

    const sourceEntries = parsePo(fs.readFileSync(poPath, 'utf8'));
    const outputPo = buildPo(keys, sourceEntries);
    const outputXml = translateXml(fs.readFileSync(xmlInPath, 'utf8'), keys, sourceEntries,);

    fs.mkdirSync(path.dirname(xmlDestPath), { recursive: true });
    fs.mkdirSync(path.dirname(xmlTranslatedPath), { recursive: true });
    fs.writeFileSync(poPath, outputPo, 'utf8');
    fs.renameSync(xmlInPath, xmlDestPath);
    fs.writeFileSync(xmlTranslatedPath, outputXml, 'utf8');

    const translatedCount = keys.filter((key) => {
        const entry = sourceEntries.find(
            (candidate) => candidate.msgid === key && !candidate.msgctxt,
        );
        return Boolean(translationFor(entry));
    }).length;
    console.log(`Wrote ${keys.length} PO keys and applied ${translatedCount} translations to ${xmlTranslatedPath}.`);
}

main();
