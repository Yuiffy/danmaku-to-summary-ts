'use strict';
// Legacy ASR subtitle parsing and formatting, independent of model runtimes.
const fs = require('fs');

function formatTimestamp(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    const ms = Math.floor((safe % 1) * 1000);
    const whole = Math.floor(safe);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function parseTimestamp(value) {
    const match = String(value).trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
    if (!match) return 0;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function parseSrt(srtPath, backend = 'whisper') {
    const content = fs.readFileSync(srtPath, 'utf8').replace(/\r\n/g, '\n');
    const blocks = content.split(/\n{2,}/);
    const segments = [];

    for (const block of blocks) {
        const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
        if (lines.length < 2) continue;
        const timeLine = lines.find(line => line.includes('-->'));
        if (!timeLine) continue;
        const [startRaw, endRaw] = timeLine.split('-->').map(s => s.trim());
        const textStart = lines.indexOf(timeLine) + 1;
        const text = lines.slice(textStart).join('').trim();
        if (!text) continue;
        segments.push({
            start: parseTimestamp(startRaw),
            end: parseTimestamp(endRaw),
            text
        });
    }

    return { backend, segments };
}

function splitTextByLength(text, maxChars) {
    if (!text || text.length <= maxChars) return [text].filter(Boolean);
    const parts = [];
    let current = '';
    const tokens = String(text).match(/[A-Za-z0-9]+|./gu) || [];
    for (const token of tokens) {
        if (current && current.length + token.length > maxChars) {
            parts.push(current.trim());
            current = token;
        } else {
            current += token;
        }
        if (/[，。？！,.?!]/.test(token)) {
            parts.push(current.trim());
            current = '';
        }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function stripSubtitlePunctuation(text) {
    return String(text || '')
        .replace(/[，。！？；：、,.?!;:"“”‘’'`（）()【】\[\]《》<>…—\-~～]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

module.exports = { formatTimestamp, parseTimestamp, parseSrt, splitTextByLength, stripSubtitlePunctuation };
