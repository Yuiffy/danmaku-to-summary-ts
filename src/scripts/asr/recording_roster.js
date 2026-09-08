'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rosterPath = srtPath => srtPath.replace(/(?:\.speaker)?\.srt$/iu, '.participants.json');
const subtitleHash = srtPath => crypto.createHash('sha256').update(fs.readFileSync(srtPath)).digest('hex');

function loadRecordingParticipants(srtPath, mediaPath, roomId, speakerSidecar = {}) {
    const metadata = { plannedParticipantIds: [], source: 'none', issues: [] };
    if (speakerSidecar.input && path.resolve(speakerSidecar.input) === path.resolve(mediaPath)) {
        metadata.plannedParticipantIds = Array.isArray(speakerSidecar.plannedParticipantIds)
            ? speakerSidecar.plannedParticipantIds.map(String) : [];
        if (metadata.plannedParticipantIds.length) metadata.source = 'asr_planned_roster';
    }
    const file = rosterPath(srtPath);
    if (!fs.existsSync(file)) return metadata;
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const hash = subtitleHash(srtPath);
        if (data.version !== 1 || String(data.roomId) !== String(roomId) || data.subtitleSha256 !== hash
            || typeof data.sourceMediaPath !== 'string' || path.resolve(data.sourceMediaPath) !== path.resolve(mediaPath)
            || !Array.isArray(data.plannedParticipantIds) || !data.source) throw new Error('participant_source_mismatch');
        return { plannedParticipantIds: Array.from(new Set(data.plannedParticipantIds.map(String))),
            source: data.source, subtitleSha256: hash, issues: [] };
    } catch (error) {
        return { ...metadata, issues: [error.message] };
    }
}

function writeRecordingParticipants({ srtPath, mediaPath, roomId, participantIds, source = 'operator_confirmation' }) {
    if (!srtPath || !/\.srt$/iu.test(srtPath) || !mediaPath || !fs.statSync(mediaPath).isFile()
        || !/^\d+$/u.test(String(roomId)) || !Array.isArray(participantIds)
        || participantIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Invalid recording roster');
    const data = { version: 1, roomId: String(roomId), source, sourceMediaPath: path.resolve(mediaPath),
        subtitleSha256: subtitleHash(srtPath), plannedParticipantIds: Array.from(new Set(participantIds)) };
    const file = rosterPath(srtPath);
    // A changed recording or roster requires explicit removal/review, never silent overwrite.
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); }
    catch (error) {
        if (error.code !== 'EEXIST' || JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) !== JSON.stringify(data)) throw error;
    }
    return { path: file, ...data };
}

module.exports = { loadRecordingParticipants, writeRecordingParticipants };
