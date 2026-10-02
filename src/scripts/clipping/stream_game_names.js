'use strict';
const fs = require('fs');
const path = require('path');
const { sha } = require('./stream_game_plan');
const { fileDigest } = require('./source_snapshot');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { runFfmpeg } = require('./media_runtime');
const { extractEvidence } = require('./stream_game_evidence');
const { requestMediaVerification } = require('./stream_activity_verification');
const { withSelectionCache } = require('./selection_cache');
const normalize = value => String(value || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
function parseNameReview(response, chapter, frames) {
    const row = JSON.parse(response.text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
    if (typeof row.supported !== 'boolean' || !String(row.reason || '').trim()) throw new Error('Invalid original-frame game name review');
    if (!row.supported) return row;
    if (!['boss', 'location'].includes(row.kind) || normalize(row.label).length < 2
        || !normalize(chapter.proposedTitle).includes(normalize(row.label))
        || !frames.some(f => f.index === row.frameIndex) || row.activity !== 'gameplay') {
        throw new Error('Proposed game name needs its literal visible label in an original live frame');
    }
    return row;
}
async function restoreFrameNamedChapters(event, plan, options, config, files, settings) {
    for (const [index, chapter] of event.chapters.entries()) {
        if (chapter.titleIssue !== 'proper_name_not_grounded' || !String(chapter.proposedTitle || '').trim()) continue;
        const end = event.chapters[index + 1]?.start || event.end, duration = end - chapter.start;
        if (duration < 2) continue;
        const times = [...new Set([chapter.start + Math.min(15, duration / 6), ...[.25, .5, .75].map(f => chapter.start + duration * f),
            Math.max(chapter.start, end - 15), Math.max(chapter.start, end - 5)])].filter(t => t >= chapter.start && t < end);
        const directory = path.join(files.directory, 'temp', 'game-chapter-names', sha({ version: 1, source: plan.source, chapter, end, settings }).slice(0, 16));
        fs.mkdirSync(directory, { recursive: true });
        const frames = times.map((time, i) => ({ index: i + 1, time, path: path.join(directory, `frame-${i + 1}.jpg`), mimeType: 'image/jpeg' }));
        for (const frame of frames) {
            await extractEvidence(options.extract || runFfmpeg, ['-y', '-ss', String(frame.time), '-i', options.mediaPath,
                '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3', frame.path],
            { ffmpegPath: options.config.audio?.ffmpeg?.path || 'ffmpeg', threads: 1, stage: '核对原帧Boss与地点名称', timeoutMs: 120000, sourceIdentity: plan.source });
            frame.sha256 = fileDigest(frame.path);
        }
        const prompt = `Read literal game labels in these ORIGINAL livestream frames for ${config.games.find(g => g.id === event.gameId).name}, host ${plan.streamerName}.
Unverified proposed chapter title: ${JSON.stringify(chapter.proposedTitle)}. This title is only a hint, never evidence. Phase ${chapter.start}-${end}. Images ${JSON.stringify(frames.map(({index,time})=>({index,recordingSeconds:time})))}.
Restore a name ONLY if an attached actual live-game frame visibly spells that named Boss on its health bar, or that location in its location banner/map. Do not identify a boss/location from scenery, appearance, previous knowledge, chat, or this proposed title. A replay/browser/video player does not establish live host play. Read the label verbatim, preserving all characters; spaces between actual name words are allowed. Its literal normalized spelling must occur in the proposed title. Do not infer victory. If the name is unreadable or only inferred, return supported=false. No audio is supplied; do not claim listening.
Return ONLY JSON {"supported":boolean,"reason":"specific visible label or lack of evidence","label":"literal visible name or null","kind":"boss|location" or null,"frameIndex":selected original image index or null,"activity":"gameplay|other|watching_game"}.`;
        const response = await withSelectionCache({ directory: path.join(files.directory, 'temp', 'game-name-cache'), phase: 'game-literal-name-v1',
            prompt, signature: { source: plan.source, settings, frames: frames.map(({time,sha256})=>({time,sha256})) },
            validate: value => { try { parseNameReview(value, chapter, frames); return true; } catch { return false; } } },
        () => (options.nameRequest || options.verifyRequest || requestMediaVerification)(prompt, frames, options.config, settings));
        const responsePath = path.join(directory, 'RESPONSE.json'); writeJsonAtomic(responsePath, response);
        const row = parseNameReview(response, chapter, frames);
        if (!row.supported) continue;
        event.chapters[index] = { ...chapter, title: chapter.proposedTitle, kind: row.kind, nameEvidence: row.label,
            nameEvidenceSource: 'original_frame', titleIssue: null,
            frameNameEvidence: { version: 1, source: plan.source, phaseStart: chapter.start, phaseEnd: end, publicTitle: chapter.proposedTitle,
                label: row.label, kind: row.kind, selectedFrameIndex: row.frameIndex, frames,
                responsePath, responseSha256: fileDigest(responsePath) } };
    }
    return event;
}
module.exports = { parseNameReview, restoreFrameNamedChapters };
