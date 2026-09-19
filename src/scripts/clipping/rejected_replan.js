'use strict';

const fs = require('fs');
const path = require('path');

const REPLANNABLE = new Set(['outside_candidate_context', 'overlap_after_alignment', 'overlap']);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function checkRegistryOverlap(metadata, options, start, end) {
    if (!options.registryPath) throw new Error('Editorial replanning requires the upload registry');
    const records = JSON.parse(fs.readFileSync(options.registryPath, 'utf8')).clips || {};
    const current = records[String(metadata.uploadId)];
    if (!current) throw new Error('Editorial replan ID is missing from the registry');
    const peers = [];
    for (const [id, record] of Object.entries(records)) {
        if (Number(id) === metadata.uploadId) continue;
        const knownSource = record.sourceMediaPath;
        if (knownSource && !samePath(knownSource, metadata.source.mediaPath)) continue;
        if (!record.metadataPath || !fs.existsSync(record.metadataPath)) {
            if (knownSource) throw new Error(`Cannot check overlapping clip ${id}: metadata missing`);
            continue;
        }
        const peer = JSON.parse(fs.readFileSync(record.metadataPath, 'utf8'));
        if (!peer.source?.mediaPath || !samePath(peer.source.mediaPath, metadata.source.mediaPath)
            || peer.selectionRejection) continue;
        const window = peer.window;
        if (!Number.isFinite(window?.start) || !Number.isFinite(window?.end)) {
            throw new Error(`Cannot check overlapping clip ${id}: invalid window`);
        }
        if (Math.min(end, window.end) - Math.max(start, window.start) > 0.001) {
            throw new Error(`Editorial replan overlaps retained clip ${id}; choose an independent complete window`);
        }
        peers.push({ id: Number(id), start: window.start, end: window.end });
    }
    return peers;
}

function validateEditorialReplan(metadata, options, evidence) {
    const rejection = metadata.originalSelectionRejection;
    if (!rejection || rejection.reason === 'duration_out_of_bounds' || metadata.selectionRejection) return;
    const plan = metadata.editorialReplan;
    if (!REPLANNABLE.has(rejection.reason) || !plan || plan.clipId !== metadata.uploadId
        || plan.sourceSha256 !== evidence.sourceSha256 || !String(plan.note || '').trim()
        || plan.start !== metadata.window.start || plan.end !== metadata.window.end) {
        throw new Error('Rejected candidate needs a matching new editorial plan');
    }
    checkRegistryOverlap(metadata, options, plan.start, plan.end);
}

function reviewEditorialReplan(metadata, options, evidence, start, end) {
    const rejection = metadata.selectionRejection || metadata.originalSelectionRejection;
    const requested = options.replan === true || options.replan === 'yes';
    if (!requested) {
        if (metadata.editorialReplan && !metadata.selectionRejection) {
            validateEditorialReplan(metadata, options, evidence);
            if (start === metadata.window.start && end === metadata.window.end) return metadata.editorialReplan;
        }
        throw new Error('This rejection needs a new editorial plan; use rebuild --replan with a new window and reviewed copy');
    }
    if (metadata.mode !== 'own_stream_fun_review' || !REPLANNABLE.has(rejection?.reason)) {
        throw new Error('This selection rejection cannot be recovered by editorial replanning');
    }
    if (options.start === undefined || options.end === undefined
        || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start
        || ['reviewNote', 'sourceKind', 'title', 'description', 'coverText'].some(key => !String(options[key] || '').trim())) {
        throw new Error('Editorial replan requires explicit start/end, source-kind, review note and complete publishing copy');
    }
    if (start === metadata.window.start && end === metadata.window.end) {
        throw new Error('Editorial replan must select a new window, not approve the rejected window unchanged');
    }
    const peers = checkRegistryOverlap(metadata, options, start, end);
    return { version: 1, clipId: metadata.uploadId, authority: 'user', at: new Date().toISOString(),
        note: options.reviewNote.trim(), sourceSha256: evidence.sourceSha256,
        originalWindow: { start: metadata.window.start, end: metadata.window.end },
        rejectionReason: rejection.reason, start, end, checkedPeers: peers,
        previousPlan: metadata.editorialReplan || null };
}

module.exports = { reviewEditorialReplan, validateEditorialReplan };
