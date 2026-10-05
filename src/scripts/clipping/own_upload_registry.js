'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ownReview = require('./own_review_report');

function parseUploadRegistryOutput(output) {
    const receipt = String(output || '').split(/\r?\n/).find(line => line.startsWith('REGISTRY_RESULT: '));
    if (receipt) {
        try { return JSON.parse(receipt.slice('REGISTRY_RESULT: '.length)); } catch { return null; }
    }
    const match = String(output || '').match(/^IDs:\s*([0-9,\s]+)$/m);
    if (!match) {
        return null;
    }
    const clipIds = match[1]
        .split(',')
        .map(value => Number(value.trim()))
        .filter(Number.isFinite);
    return clipIds.length ? { clipIds } : null;
}

function buildOwnUploadSettings(metadata, copy = {}) {
    const source = `${metadata.streamerName || '主播'} 直播《${metadata.streamTitle || metadata.sourceFileName || '未知直播'}》${metadata.recordedAt || ''}`.trim();
    const tags = Array.isArray(copy.tags) && copy.tags.length
        ? copy.tags
        : ['小岁', '虚拟主播', '直播切片', '岁AI切片', 'AI切片'];
    const prefix = String(metadata.roomId || '') === '25788785'
        ? '【小岁】'
        : `【${metadata.streamerName || '切片'}】`;
    return {
        source,
        tags: Array.from(new Set(tags.map(tag => String(tag || '').trim()).filter(Boolean))),
        prefix,
        tid: 21,
        roomId: metadata.roomId || null,
        streamerName: metadata.streamerName || null
    };
}

function isOwnClipUploadEligible(result) {
    return ownReview.uploadEligible(result);
}

function writeOwnUploadManifest(manifestPath, reviewPath, results, metadata) {
    const settings = buildOwnUploadSettings(metadata, results[0]?.copy || {});
    const indices = results.map((result, index) => ownReview.reviewIndex(result, index));
    if (new Set(indices).size !== indices.length) throw new Error('Duplicate review indices; refusing ambiguous ID registration');
    const manifest = {
        version: 1,
        type: 'bilibili_clip_upload_manifest',
        generatedAt: new Date().toISOString(),
        reviewPath,
        roomId: metadata.roomId || null,
        streamerName: metadata.streamerName || null,
        recordedAt: metadata.recordedAt || null,
        streamTitle: metadata.streamTitle || metadata.sourceFileName || null,
        upload: settings,
        planPath: metadata.planPath || null,
        clips: results.map((result, index) => ({
            reviewIndex: ownReview.reviewIndex(result, index),
            metadataPath: result.output?.metadataPath || null
        }))
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifestPath;
}

function registerReviewForUpload(reviewPath, results, metadata) {
    if (!reviewPath || !results.length) return null;
    const settings = buildOwnUploadSettings(metadata, results[0]?.copy || {});
    const manifestPath = metadata.uploadManifestPath
        || path.join(path.dirname(reviewPath), `${path.basename(reviewPath, path.extname(reviewPath))}_UPLOAD_MANIFEST.json`);
    writeOwnUploadManifest(manifestPath, reviewPath, results, metadata);
    const scriptPath = path.join(__dirname, '../clip_upload_registry.py');
    const args = [
        scriptPath,
        'import-json',
        '--include-pending',
        '--manifest', manifestPath,
        '--review', reviewPath,
        '--source', settings.source,
        '--tags', settings.tags.join(','),
        '--prefix', settings.prefix,
        '--tid', '21',
        '--label', `${metadata.streamerName || '主播'} ${metadata.recordedAt || ''}`.trim()
    ];
    const result = spawnSync('python', args, {
        cwd: path.resolve(__dirname, '../../..'),
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.status !== 0) {
        metadata.registrationError = output || `registry process exit ${result.status}`;
        console.warn(`Upload registry import failed: ${output}`);
        return null;
    }
    if (output) {
        console.log(output);
    }
    const registered = parseUploadRegistryOutput(output);
    if (!registered || registered.clipIds?.length !== results.length) {
        metadata.registrationError = 'Registry did not return one ID for every candidate';
        return null;
    }
    if (registered && !registered.clipIdsByReviewIndex) registered.clipIdsByReviewIndex = Object.fromEntries(
        results.map((result, index) => [ownReview.reviewIndex(result, index), registered.clipIds[index]]));
    const mapped = results.map((result, index) => registered.clipIdsByReviewIndex[ownReview.reviewIndex(result, index)]);
    if (new Set(mapped).size !== results.length || mapped.some(id => !Number.isSafeInteger(id) || id < 1)) {
        metadata.registrationError = 'Registry returned missing or ambiguous candidate IDs';
        return null;
    }
    return registered;
}


module.exports = { parseUploadRegistryOutput, buildOwnUploadSettings, isOwnClipUploadEligible, writeOwnUploadManifest, registerReviewForUpload };
