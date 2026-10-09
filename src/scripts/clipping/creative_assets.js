'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const projectRoot = path.resolve(__dirname, '../../..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readCatalog(manifestPath) {
    const file = path.resolve(projectRoot, manifestPath);
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (catalog.version !== 1 || !Array.isArray(catalog.assets) || catalog.assets.length > 40) throw new Error('Invalid creative asset catalog');
    const directory = path.resolve(projectRoot, catalog.cacheDirectory);
    const seen = new Set();
    for (const asset of catalog.assets) {
        if (!/^[a-z][a-z0-9_]{1,60}$/.test(asset.id) || seen.has(asset.id) || !['sticker', 'sound'].includes(asset.kind)
            || path.basename(asset.file) !== asset.file || !/^[a-z0-9_-]+\.(png|mp3|wav)$/.test(asset.file)
            || !/^[a-f0-9]{64}$/.test(asset.sha256) || !asset.license || !asset.creator
            || ![asset.sourceUrl, asset.licenseUrl, asset.downloadUrl].every(url => typeof url === 'string' && url.startsWith('https://'))) {
            throw new Error('Invalid creative asset entry');
        }
        seen.add(asset.id);
        if (asset.kind === 'sound' && (!Number.isFinite(asset.sampleStart) || asset.sampleStart < 0
            || !Number.isFinite(asset.sampleSeconds) || asset.sampleSeconds < .3 || asset.sampleSeconds > 4)) throw new Error('Invalid sound excerpt');
    }
    return { ...catalog, directory };
}

function loadCreativeAssets(settings = {}) {
    if (!settings.assetManifest) return { assets: {}, unavailable: [] };
    const catalog = readCatalog(settings.assetManifest), assets = {}, unavailable = [];
    for (const entry of catalog.assets) {
        const filePath = path.join(catalog.directory, entry.file);
        try {
            const bytes = fs.readFileSync(filePath);
            if (digest(bytes) !== entry.sha256) throw new Error('asset checksum changed');
            if (entry.kind === 'sticker' && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('not PNG');
            assets[entry.id] = { ...entry, filePath };
        } catch (error) { unavailable.push({ id: entry.id, reason: error.message }); }
    }
    return { assets, unavailable };
}

function assetChoices(assets) {
    return Object.values(assets).map(({ id, kind, label, usage, sampleSeconds, family, intensity }) => ({ id, kind, label, usage, family, intensity,
        ...(kind === 'sound' ? { duration: sampleSeconds } : {}) }));
}

function soundId(sound) { return typeof sound === 'string' ? sound : sound?.id; }

function creativeInputs(plan, assets = {}) {
    const args = [], bindings = {};
    for (const [index, row] of plan.effects.entries()) {
        for (const [kind, id] of [['sticker', row.sticker?.id], ['sound', soundId(row.sound)]]) {
            const asset = assets[id];
            if (!asset) continue;
            if (digest(fs.readFileSync(asset.filePath)) !== asset.sha256) throw new Error(`Creative asset changed: ${id}`);
            // Each event gets its own bounded input timeline; no model-supplied paths or URLs.
            const inputIndex = args.length / 2 + 1;
            args.push('-i', asset.filePath);
            bindings[`${index}:${kind}`] = { inputIndex, asset };
        }
    }
    if (plan.music) {
        const asset = assets[plan.music.id];
        if (!asset || asset.kind !== 'music' || digest(fs.readFileSync(asset.filePath)) !== asset.sha256) throw new Error('Background music asset changed');
        bindings.music = { inputIndex: args.length / 2 + 1, asset };
        args.push('-i', asset.filePath);
    }
    return { args, bindings };
}

async function fetchAssets(manifestPath) {
    const fetch = require('node-fetch'), catalog = readCatalog(manifestPath);
    fs.mkdirSync(catalog.directory, { recursive: true });
    const results = [];
    for (const asset of catalog.assets) {
        const file = path.join(catalog.directory, asset.file);
        if (fs.existsSync(file) && digest(fs.readFileSync(file)) === asset.sha256) { results.push({ id: asset.id, status: 'cached' }); continue; }
        const response = await fetch(asset.downloadUrl, { timeout: 30000, size: 12 * 1024 * 1024 });
        if (!response.ok) throw new Error(`Asset ${asset.id}: HTTP ${response.status}`);
        const bytes = await response.buffer();
        if (digest(bytes) !== asset.sha256) throw new Error(`Asset ${asset.id} changed; review the source before updating its hash`);
        const temp = file + `.${process.pid}.tmp`;
        fs.writeFileSync(temp, bytes); fs.renameSync(temp, file);
        results.push({ id: asset.id, status: 'downloaded' });
    }
    return results;
}

if (require.main === module) {
    const [command, manifest = 'config/clip-creative-assets.json'] = process.argv.slice(2);
    (command === 'fetch' ? fetchAssets(manifest) : Promise.resolve(loadCreativeAssets({ assetManifest: manifest })))
        .then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { loadCreativeAssets, assetChoices, creativeInputs, soundId, fetchAssets };
