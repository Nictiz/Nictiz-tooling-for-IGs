'use strict';
// PO quoted strings use the same common escapes as JSON, plus octal escapes.
function decodePoString(token) {
    if (!token.startsWith('"') || !token.endsWith('"')) {
        throw new Error(`Invalid PO string: ${token}`);
    }

    const input = token.slice(1, -1);
    let output = '';
    for (let i = 0; i < input.length; i += 1) {
        if (input[i] !== '\\') {
            output += input[i];
            continue;
        }

        const next = input[++i];
        if (next === undefined) {
            output += '\\';
        } else if (next === 'n') output += '\n';
        else if (next === 'r') output += '\r';
        else if (next === 't') output += '\t';
        else if (next === 'b') output += '\b';
        else if (next === 'f') output += '\f';
        else if (next === 'v') output += '\v';
        else if (next === '"') output += '"';
        else if (next === '\\') output += '\\';
        else if (/[0-7]/.test(next)) {
            let octal = next;
            while (octal.length < 3 && /[0-7]/.test(input[i + 1] || '')) {
                octal += input[++i];
            }
            output += String.fromCharCode(parseInt(octal, 8));
        } else {
            // Be permissive with non-standard PO escapes.
            output += next;
        }
    }
    return output;
}

function parsePo(text) {
    const entries = [];
    let entry = null;
    let activeField = null;

    function finishEntry() {
        if (entry && Object.prototype.hasOwnProperty.call(entry, 'msgid')) {
            entries.push(entry);
        }
        entry = null;
        activeField = null;
    }

    for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') {
            finishEntry();
            continue;
        }

        if (line.startsWith('#')) {
            if (!entry) entry = { comments: [] };
            entry.comments.push(line);
            continue;
        }

        const fieldMatch = line.match(/^(msgctxt|msgid_plural|msgid|msgstr)(?:\[(\d+)\])?\s+(".*")$/);
        if (fieldMatch) {
            if (!entry) entry = { comments: [] };
            const [, field, index, value] = fieldMatch;
            const fieldName = index === undefined ? field : `${field}[${index}]`;
            entry[fieldName] = decodePoString(value);
            activeField = fieldName;
            continue;
        }

        if (line.trim().startsWith('"') && activeField && entry) {
            entry[activeField] += decodePoString(line.trim());
            continue;
        }

        // Ignore flags and other PO directives that are not needed for menu keys.
        activeField = null;
    }
    finishEntry();
    return entries;
}

function translationFor(entry) {
    if (!entry) return '';
    if (typeof entry.msgstr === 'string' && entry.msgstr) return entry.msgstr;
    if (typeof entry['msgstr[0]'] === 'string') return entry['msgstr[0]'];
    return '';
}

module.exports = { parsePo, translationFor };
