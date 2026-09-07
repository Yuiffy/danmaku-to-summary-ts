'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function evidencePath(srtPath) {
    return path.join(path.dirname(srtPath), `${path.basename(srtPath, path.extname(srtPath))}.asr_evidence.json`);
}

function subtitleHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function writeAsrEvidence(srtPath, content, rows, backend) {
    const target = evidencePath(srtPath);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, backend,
            subtitleSha256: subtitleHash(content), segments: rows }, null, 2), 'utf8');
        fs.renameSync(temporary, target);
    } finally {
        try { fs.unlinkSync(temporary); } catch { /* already renamed */ }
    }
    return target;
}

function loadAsrEvidence(srtPath, segments) {
    try {
        const file = evidencePath(srtPath);
        if (!fs.existsSync(file)) return { status: 'missing', segments };
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.segments)) throw new Error('Invalid ASR evidence schema');
        if (data.subtitleSha256 !== subtitleHash(fs.readFileSync(srtPath, 'utf8'))) {
            return { status: 'stale', segments };
        }
        if (data.segments.length !== segments.length) throw new Error('ASR evidence row count mismatch');
        const linked = segments.map((segment, index) => {
            const row = data.segments[index];
            if (row.start !== segment.start || row.end !== segment.end || row.text !== segment.text
                || !row.asr || typeof row.asr.recognizedText !== 'string') {
                throw new Error('ASR evidence does not match the subtitle row');
            }
            return { ...segment, asrEvidence: row.asr };
        });
        return { status: 'available', backend: data.backend, segments: linked };
    } catch (error) {
        return { status: 'invalid', error: error.message, segments };
    }
}

module.exports = { evidencePath, writeAsrEvidence, loadAsrEvidence };
