'use strict';
const fs = require('fs');
const path = require('path');
const { fileDigest } = require('./source_snapshot');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { sha } = require('./stream_game_plan');

/** Bind every original excerpt to its source and exact extraction arguments. */
async function extractEvidence(run, args, settings) {
    const output = args.at(-1), receiptPath = output + '.complete.json';
    const { mediaPath, mediaBytes, mediaMtimeNs } = settings.sourceIdentity || {};
    const source = { mediaPath, mediaBytes, mediaMtimeNs };
    const signatureFor = values => sha({ args: values, source });
    const signature = signatureFor(args);
    const save = digest => writeJsonAtomic(receiptPath, { version: 3, signature, args, source, sha256: digest });
    if (fs.existsSync(receiptPath) && fs.existsSync(output)) {
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        if ([2, 3].includes(receipt.version) && receipt.signature === signature && receipt.sha256 === fileDigest(output)) {
            if (receipt.version === 2) save(receipt.sha256);
            return;
        }
    }
    const parent = path.dirname(path.dirname(output));
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const previous = path.join(parent, entry.name, path.basename(output));
        if (previous === output || !fs.existsSync(previous + '.complete.json') || !fs.existsSync(previous)) continue;
        const receipt = JSON.parse(fs.readFileSync(previous + '.complete.json', 'utf8'));
        if (![2, 3].includes(receipt.version) || receipt.signature !== signatureFor([...args.slice(0, -1), previous])
            || receipt.sha256 !== fileDigest(previous)) continue;
        fs.copyFileSync(previous, output); save(receipt.sha256); return;
    }
    await run(args, settings);
    if (!fs.existsSync(output) || fs.statSync(output).size < 1000) throw new Error('Missing original game review evidence');
    save(fileDigest(output));
}
module.exports = { extractEvidence };
