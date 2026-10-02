'use strict';
const fs = require('fs');
const path = require('path');
const { runFfmpeg } = require('./media_runtime');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { withSelectionCache } = require('./selection_cache');
const { sha } = require('./stream_activity_plan');
const { parseVerification, requestMediaVerification } = require('./stream_activity_verification');
const { recordSelectionDiagnostic } = require('./selection_request');

const VERSION = 2;
function boundaryIntervals(event, duration, settings) {
    const context = settings.boundaryContextSeconds;
    const inside = Math.min(15, (event.end - event.start) / 2);
    if (event.kind === 'song' && event.performance === 'fragment' && event.end - event.start <= 90) return [
        { start: Math.max(0, event.start - Math.min(context, 15)), end: Math.min(duration, event.end + Math.min(context, 15)) }
    ];
    const intervals = [{ start: Math.max(0, event.start - context), end: Math.min(duration, event.start + inside) },
        { start: Math.max(0, event.end - inside), end: Math.min(duration, event.end + context) }];
    return intervals[0].end >= intervals[1].start
        ? [{ start: intervals[0].start, end: intervals[1].end }] : intervals;
}
function audioEnergy(buffer, sampleRate = 8000) {
    const samples = Math.floor(buffer.length / 2), rmsDb = [];
    for (let from = 0; from < samples; from += sampleRate) {
        const to = Math.min(samples, from + sampleRate);
        let sum = 0;
        for (let i = from; i < to; i++) sum += (buffer.readInt16LE(i * 2) / 32768) ** 2;
        rmsDb.push(Math.max(-96, Math.round(10 * Math.log10(sum / (to - from) || 1e-10))));
    }
    return { sampleRate, stepSeconds: 1, duration: samples / sampleRate, rmsDb };
}
function uncertain(event, reason, evidence, duration, settings) {
    const context = event.kind === 'song' && event.performance === 'fragment' ? 8 : settings.boundaryContextSeconds;
    const provisionalWindow = { start: Math.max(0, event.start - context), end: Math.min(duration, event.end + Math.min(context, 30)) };
    return { ...event, ...(event.kind === 'watch' ? provisionalWindow : {}), provisionalWindow,
        startObserved: false, endObserved: false,
        reviewIssues: [...new Set([...(event.reviewIssues || []), 'media_verification_unconfirmed',
            event.kind === 'song' ? 'performance_boundary_provisional' : 'watch_boundary_provisional'])],
        verification: { decision: 'uncertain', reason, ...evidence } };
}
function groupBoundaries(events, duration, settings) {
    const batches = [];
    for (const event of events) {
        const intervals = boundaryIntervals(event, duration, settings);
        const seconds = intervals.reduce((n, span) => n + span.end - span.start, 0);
        let batch = batches.at(-1);
        if (!batch || batch.events.length >= settings.batchMaxEvents || batch.audioSeconds + seconds > settings.batchMaxAudioSeconds) {
            batch = { events: [], audioSeconds: 0 }; batches.push(batch);
        }
        batch.events.push({ event, intervals }); batch.audioSeconds += seconds;
    }
    return batches;
}
async function extractPacket(batch, directory, source, root, extract = runFfmpeg) {
    const audio = [], frames = [];
    fs.mkdirSync(directory, { recursive: true });
    for (const row of batch.events) {
        row.audioIndices = [];
        for (const span of row.intervals) {
            const index = audio.length + 1, audioPath = path.join(directory, `audio-${index}.mp3`);
            const pcmPath = path.join(directory, `audio-${index}.pcm`), duration = span.end - span.start;
            await extract(['-y', '-ss', String(span.start), '-i', source.mediaPath,
                '-map', '0:a:0', '-vn', '-t', String(duration), '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', audioPath,
                '-map', '0:a:0', '-vn', '-t', String(duration), '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', '-f', 's16le', pcmPath],
            { ffmpegPath: root.audio?.ffmpeg?.path || 'ffmpeg', stage: '活动边界短音频', timeoutMs: 60000 });
            const energy = audioEnergy(fs.readFileSync(pcmPath));
            if (Math.abs(energy.duration - duration) > .25) throw new Error('Boundary audio does not match the requested source timeline');
            const energyPath = path.join(directory, `audio-${index}.energy.json`);
            writeJsonAtomic(energyPath, { recordingStart: span.start, ...energy });
            fs.unlinkSync(pcmPath);
            audio.push({ ...span, path: audioPath, mimeType: 'audio/mpeg', energy, energyPath });
            row.audioIndices.push(index);
        }
        if (row.event.kind === 'watch') {
            const time = (row.event.start + row.event.end) / 2;
            const framePath = path.join(directory, `${row.event.id}.jpg`);
            await extract(['-y', '-ss', String(time), '-i', source.mediaPath, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', framePath],
                { ffmpegPath: root.audio?.ffmpeg?.path || 'ffmpeg', stage: '视听内容画面', timeoutMs: 60000 });
            frames.push({ time, activityId: row.event.id, path: framePath, mimeType: 'image/jpeg' });
        }
    }
    return { audio, frames };
}
function boundaryPrompt(batch, packet, info, rows) {
    const candidates = batch.events.map(({ event, audioIndices }) => ({ id: event.id, kind: event.kind,
        performance: event.performance, mediaKind: event.mediaKind, roughStart: event.start, roughEnd: event.end, audioIndices }));
    const anchors = packet.audio.map((a, i) => ({ audioIndex: i + 1, recordingStart: a.start,
        duration: a.end - a.start, energyStepSeconds: 1, rmsDb: a.energy.rmsDb }));
    const cues = rows.filter(r => r.source === 'audio_transcript' && packet.audio.some(a => r.end >= a.start && r.start <= a.end))
        .map(r => ({ id: r.id, start: r.start, end: r.end, text: r.text }));
    return `Calibrate these rough activity boundaries for host ${info.streamerName} in ONE pass, using the attached short original audio and its numeric energy timeline. No full-stream redetection or extra songs.
Candidates: ${JSON.stringify(candidates)}
Audio attachments come FIRST, in their declared 1-based order. Local audio second 0 maps to recordingStart. Energy bins span [i,i+1) LOCAL seconds; low energy is a timing hint, not proof of music or singing. Listen to the actual audio. Each candidate can only use its declared audioIndices.
Audio time anchors: ${JSON.stringify(anchors)}
Nearby mixed ASR (fallible timing/words, never proof by itself): ${JSON.stringify(cues)}
Following frames show the middle of each viewing session: ${JSON.stringify(packet.frames.map(f => ({ id: f.activityId, recordingTime: f.time })))}.
For a full song, audio near its start/end is enough: preserve the complete middle, verses, chorus, bridge and interlude. Locate backing-track intro/outro, not merely the first/last lyric. Do not trim inside the rough observed singing range. For fragments keep the whole intentional sung lyric. Distinguish live host singing from conversational intonation, BGM, replayed singers and film dialogue; exclude actual false positives. Do not guess titles.
For viewing, refine only the complete session's outer boundaries, preserving all of its middle, pauses, reactions and discussions. Do not replace it with these short excerpts or add earlier/later sessions. Use the supplied frame to distinguish actual playback from film discussion.
Return JSON {"results":[{"id":"candidate id","decision":"keep|exclude|uncertain","timeBasis":"audio_local_seconds","reason":"brief actual audible evidence and boundary rationale","audibleEvidence":["one or two verbatim original-language heard phrases"],"events":[{"kind":"song|watch","start":{"audioIndex":1,"seconds":0.0},"end":{"audioIndex":2,"seconds":1.0},"performance":"full|fragment" (song),"mediaKind":"movie|anime|video" (watch),"startObserved":true,"endObserved":true}]}]}.
Every candidate gets exactly one result. keep has exactly one continuous event and concrete audibleEvidence. Numbers above are format examples, not detected boundaries. If a boundary is outside the short audio or cannot be heard, return uncertain; retain it for review rather than guessing. exclude has events:[], uncertain has events:[].`;
}
function parseBatch(response, batch, packet, rows, duration, evidence, settings) {
    const raw = JSON.parse(response.text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
    if (!Array.isArray(raw.results) || raw.results.length !== batch.events.length
        || new Set(raw.results.map(r => r.id)).size !== batch.events.length
        || raw.results.some(r => !batch.events.some(e => e.event.id === r.id))) throw new Error('Boundary batch must preserve every candidate ID once');
    const events = [], rejected = [];
    for (const row of batch.events) {
        const result = raw.results.find(r => r.id === row.event.id);
        try {
            if (result.decision === 'keep' && (result.timeBasis !== 'audio_local_seconds'
                || result.events?.some(e => !row.audioIndices.includes(e.start?.audioIndex) || !row.audioIndices.includes(e.end?.audioIndex)))) throw new Error('Boundary references another candidate audio');
            const window = { index: 1, start: row.event.start, end: row.event.end,
                from: row.intervals[0].start, to: row.intervals.at(-1).end, rows };
            const checked = parseVerification({ text: JSON.stringify(result) }, row.event, window, duration, packet.audio);
            if (checked.decision === 'exclude') rejected.push({ ...row.event, verification: { ...checked, ...evidence } });
            else if (checked.decision === 'uncertain') events.push(uncertain(row.event, checked.reason, evidence, duration, settings));
            else events.push(...checked.events.map(event => ({ ...event, verification: { ...checked, events: undefined, ...evidence } })));
        } catch (error) { events.push(uncertain(row.event, error.message, evidence, duration, settings)); }
    }
    return { events, rejected };
}
async function calibrateBoundaries(events, args) {
    const { config, root, source, info, directory, rows, duration, diagnostics } = args;
    const settings = config.verification, batches = groupBoundaries(events, duration, settings);
    const result = { events: [], rejected: [], requests: 0, audioSeconds: 0, cacheHits: 0, maxRequests: settings.maxBatchRequests };
    for (const [index, batch] of batches.entries()) {
        const signature = { version: VERSION, source, events: batch.events.map(r => r.event), settings, transcriptSha256: args.transcriptSha256 };
        const evidenceDirectory = path.join(directory, 'temp', 'boundary-verification', sha(signature).slice(0, 16));
        const evidence = { evidenceDirectory, method: 'short_audio_energy_batch', audioIntervals: batch.events.flatMap(r => r.intervals),
            model: settings.model || root.ai?.text?.gemini?.model, apiMode: settings.apiMode };
        const unavailable = !args.request && !root.ai?.text?.[settings.provider || 'tuZi']?.apiKey;
        if (!settings.enabled || unavailable || batch.audioSeconds > settings.batchMaxAudioSeconds || index >= settings.maxBatchRequests) {
            const reason = !settings.enabled ? 'Boundary calibration disabled' : unavailable ? 'Boundary verifier unavailable'
                : batch.audioSeconds > settings.batchMaxAudioSeconds ? 'Boundary packet exceeds configured audio budget' : 'Per-stream AI budget reached';
            result.events.push(...batch.events.map(r => uncertain(r.event, reason, evidence, duration, settings)));
            continue;
        }
        try {
            const response = await withSelectionCache({ directory: path.join(directory, 'temp', 'boundary-cache'), phase: 'activity-boundaries-v1',
                prompt: JSON.stringify(signature), signature, validate: response => Boolean(response?.calibrated) }, async () => {
                const packet = await extractPacket(batch, evidenceDirectory, source, root, args.extract);
                const prompt = boundaryPrompt(batch, packet, info, rows);
                result.requests++; result.audioSeconds += batch.audioSeconds;
                const response = await (args.request || requestMediaVerification)(prompt, [...packet.audio, ...packet.frames], root,
                    { ...settings, timeoutMs: settings.boundaryTimeoutMs, maxTokens: 3000,
                        thinkingLevel: /^gemini-3/u.test(settings.model || '') ? 'minimal' : undefined });
                recordSelectionDiagnostic(diagnostics, { phase: 'activity-boundaries' }, response);
                const calibrated = parseBatch(response, batch, packet, rows, duration, evidence, settings);
                writeJsonAtomic(path.join(evidenceDirectory, 'RESULT.json'), { ...response, calibrated });
                return { ...response, calibrated };
            });
            if (response.meta?.selectionCache?.hit) result.cacheHits++;
            result.events.push(...response.calibrated.events); result.rejected.push(...response.calibrated.rejected);
        } catch (error) {
            recordSelectionDiagnostic(diagnostics, { phase: 'activity-boundaries' }, null, error);
            result.events.push(...batch.events.map(r => uncertain(r.event, error.message, evidence, duration, settings)));
        }
    }
    return result;
}
module.exports = { VERSION, boundaryIntervals, audioEnergy, uncertain, groupBoundaries, extractPacket, boundaryPrompt, parseBatch, calibrateBoundaries };
