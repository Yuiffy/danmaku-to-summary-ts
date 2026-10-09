'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

// Original deterministic plucked arpeggios and percussion; no sampled recording or external melody.
function createPlayfulMusic(directory) {
    const sampleRate = 32000, beat = 60 / 112, seconds = beat * 32, count = Math.round(seconds * sampleRate);
    const samples = new Float64Array(count); let seed = 71237;
    const noise = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2147483648 - 1);
    const note = (midi, start, duration, level) => {
        const hz = 440 * 2 ** ((midi - 69) / 12), at = Math.round(start * sampleRate);
        for (let i = 0; i < duration * sampleRate && at + i < count; i++) {
            const t = i / sampleRate, envelope = Math.min(1, t / .006) * Math.exp(-t * 9) * Math.min(1, (duration - t) / .04);
            samples[at + i] += level * envelope * (Math.sin(2 * Math.PI * hz * t) + .3 * Math.sin(4 * Math.PI * hz * t));
        }
    };
    const chords = [[60, 64, 67, 71], [57, 60, 64, 67], [62, 65, 69, 72], [55, 59, 62, 65]];
    for (let b = 0; b < 32; b++) {
        const chord = chords[Math.floor(b / 8)], start = b * beat;
        if (b % 2 === 0) note(chord[0] - 12, start, .3, .16);
        if (b % 8 !== 7) note(chord[(b * 3) % 4] + 12, start + beat * .5, .29, .14);
        if (b % 4 === 3) note(chord[2] + 12, start + beat * .75, .15, .08);
        const at = Math.round(start * sampleRate);
        for (let i = 0; i < .07 * sampleRate && at + i < count; i++) {
            const t = i / sampleRate;
            samples[at + i] += .018 * noise() * Math.exp(-t * 65);
            if (b % 2 === 0) samples[at + i] += .08 * Math.sin(2 * Math.PI * (65 * t + .025 * (1 - Math.exp(-60 * t)))) * Math.exp(-t * 35);
        }
    }
    const pcm = Buffer.alloc(count * 2);
    for (let i = 0; i < count; i++) pcm.writeInt16LE(Math.round(Math.max(-.9, Math.min(.9, samples[i])) * 32767), i * 2);
    const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    const bytes = Buffer.concat([header, pcm]), filePath = path.join(directory, 'playful-plucks.wav'); fs.writeFileSync(filePath, bytes);
    return { id: 'playful_plucks', kind: 'music', label: '轻快拨弦', usage: '轻松迷路、自信反差；对白下方铺底',
        filePath, sampleSeconds: count / sampleRate, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        sourceUrl: 'src/scripts/clipping/creative_music.js', creator: 'Original procedural project composition',
        license: 'Project-generated original audio', licenseUrl: 'src/scripts/clipping/creative_music.js' };
}
module.exports = { createPlayfulMusic };
