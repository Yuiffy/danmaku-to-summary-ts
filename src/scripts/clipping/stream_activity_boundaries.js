'use strict';
const fs = require('fs');
const path = require('path');
const { runFfmpeg } = require('./media_runtime');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { withSelectionCache } = require('./selection_cache');
const { sha } = require('./stream_activity_plan');
const { parseVerification, requestMediaVerification } = require('./stream_activity_verification');
const { recordSelectionDiagnostic } = require('./selection_request');
const { fileDigest } = require('./source_snapshot');
const { extractEvidence } = require('./stream_game_evidence');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const localStage = () => require('../workflow-runtime').loadWorkflow('clipping/activityAudio');

const VERSION = 3;
function boundaryIntervals(event, duration, settings, reviewPrelude = false) {
    const context = settings.boundaryContextSeconds;
    if (reviewPrelude && event.kind === 'song') return [{ start: Math.max(0, event.start - context), end: Math.min(duration, event.end + context) }];
    const inside = Math.min(15, (event.end - event.start) / 2);
    if (event.kind === 'song' && event.performance === 'fragment' && event.end - event.start <= 90) return [
        localStage().shortSongInterval(event, duration, context)
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
function groupBoundaries(events, duration, settings, reviewPrelude = false) {
    const batches = [];
    for (const event of events) {
        const intervals = boundaryIntervals(event, duration, settings, reviewPrelude);
        const seconds = intervals.reduce((n, span) => n + span.end - span.start, 0);
        let batch = batches.at(-1);
        if (!batch || batch.events.length >= settings.batchMaxEvents || batch.audioSeconds + seconds > settings.batchMaxAudioSeconds) {
            batch = { events: [], audioSeconds: 0 }; batches.push(batch);
        }
        batch.events.push({ event, intervals }); batch.audioSeconds += seconds;
    }
    return batches;
}
async function extractPacket(batch, directory, source, root, extract = runFfmpeg, local = false) {
    const audio = [], frames = [];
    fs.mkdirSync(directory, { recursive: true });
    for (const row of batch.events) {
        row.audioIndices = [];
        for (const span of row.intervals) {
            const index = audio.length + 1, audioPath = path.join(directory, `audio-${index}.mp3`);
            const pcmPath = path.join(directory, `audio-${index}.pcm`), duration = span.end - span.start;
            if (local) {
                await extractEvidence(extract, ['-y', '-ss', String(span.start), '-i', source.mediaPath, '-t', String(duration),
                    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', audioPath],
                { ffmpegPath: root.audio?.ffmpeg?.path || 'ffmpeg', stage: '本地活动复核原音', timeoutMs: 60000, sourceIdentity: source });
                await extract(['-y', '-i', audioPath, '-vn', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', '-f', 's16le', pcmPath],
                    { ffmpegPath: root.audio?.ffmpeg?.path || 'ffmpeg', stage: '活动复核能量', timeoutMs: 60000 });
            } else await extract(['-y', '-ss', String(span.start), '-i', source.mediaPath,
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
        if (row.event.kind === 'watch' || local) {
            const times = local && row.event.kind === 'song'
                ? row.reviewPrelude ? Array.from({ length: Math.ceil((row.event.end - row.event.start) / 30) + 1 }, (_, i) => Math.min(row.event.start + i * 30, row.event.end))
                    : [row.event.start + 10, row.event.end - 10] : [(row.event.start + row.event.end) / 2];
            for (const [i, time] of times.entries()) {
                const framePath = path.join(directory, `${row.event.id}-${i}.jpg`);
                const args = ['-y', '-ss', String(time), '-i', source.mediaPath, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', framePath];
                const settings = { ffmpegPath: root.audio?.ffmpeg?.path || 'ffmpeg', stage: '活动内容原帧', timeoutMs: 60000, sourceIdentity: source };
                if (local) await extractEvidence(extract, args, settings); else await extract(args, settings);
                frames.push({ time, activityId: row.event.id, path: framePath, mimeType: 'image/jpeg', ...(local ? { sha256: fileDigest(framePath) } : {}) });
            }
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
            const candidate = result.preludeCorrection && evidence.method === 'independent_local_asr'
                ? localStage().revisePrelude(result, row, evidence.localAudioEvidence, packet.frames) : row.event;
            const checked = parseVerification({ text: JSON.stringify(result) }, candidate, window, duration, packet.audio);
            if (checked.decision === 'exclude') rejected.push({ ...row.event, verification: { ...checked, ...evidence } });
            else if (checked.decision === 'uncertain') events.push(uncertain(row.event, checked.reason, evidence, duration, settings));
            else events.push(...checked.events.map(event => ({ ...event, id: row.event.id,
                verification: { ...checked, events: undefined, ...evidence,
                    ...(result.evidenceRefs ? { evidenceRefs: result.evidenceRefs, boundaryPolicy: 'complete_context_enclosure' } : {}),
                    ...(result.preludeCorrection ? { preludeCorrection: result.preludeCorrection } : {}) } })));
        } catch (error) { events.push(uncertain(row.event, error.message, evidence, duration, settings)); }
    }
    return { events, rejected };
}
async function calibrateBoundaries(events, args) {
    const { config, root, source, info, directory, rows, duration, diagnostics } = args;
    const settings = config.verification, batches = groupBoundaries(events, duration, settings, args.reviewPrelude);
    if (args.reviewPrelude) for (const batch of batches) for (const row of batch.events) row.reviewPrelude = true;
    const local = settings.evidenceMethod === 'independent_local_asr';
    const maxRequests = args.maxRequests ?? settings.maxBatchRequests;
    const result = { events: [], rejected: [], requests: 0, audioSeconds: 0, cacheHits: 0, maxRequests };
    for (const batch of batches) {
        const signature = { version: VERSION, source, events: batch.events.map(r => r.event), settings, transcriptSha256: args.transcriptSha256,
            ...(args.reviewPrelude ? { reviewPrelude: true } : {}),
            ...(local ? { localImplementation: fileDigest(path.join(__dirname, '../python/activity_audio_evidence.py')) } : {}),
            ...(args.retryId ? { retryId: args.retryId } : {}) };
        const evidenceDirectory = path.join(directory, 'temp', 'boundary-verification', sha(signature).slice(0, 16));
        const evidence = { evidenceDirectory, method: local ? 'independent_local_asr' : 'short_audio_energy_batch', audioIntervals: batch.events.flatMap(r => r.intervals),
            model: settings.model || root.ai?.text?.gemini?.model, apiMode: settings.apiMode };
        const unavailable = !args.request && !root.ai?.text?.[settings.provider || 'tuZi']?.apiKey;
        if (!settings.enabled || unavailable || batch.audioSeconds > settings.batchMaxAudioSeconds) {
            const reason = !settings.enabled ? 'Boundary calibration disabled' : unavailable ? 'Boundary verifier unavailable'
                : 'Boundary packet exceeds configured audio budget';
            result.events.push(...batch.events.map(r => uncertain(r.event, reason, evidence, duration, settings)));
            continue;
        }
        try {
            // Reparse cached model text against the current candidate identities. Older
            // calibrated cache rows did not retain IDs; audio offsets need no new media IO.
            const boundaryPacket = { audio: [] };
            for (const row of batch.events) row.audioIndices = row.intervals.map(span => {
                boundaryPacket.audio.push(span); return boundaryPacket.audio.length;
            });
            const response = await withSelectionCache({ directory: path.join(directory, 'temp', 'boundary-cache'), phase: 'activity-boundaries-v1',
                prompt: JSON.stringify(signature), signature, validate: response => Boolean(response?.calibrated) }, async () => {
                if ((args.usedRequests || 0) + result.requests >= maxRequests) throw new Error('Per-stream AI budget reached');
                const packet = await extractPacket(batch, evidenceDirectory, source, root, args.extract, local);
                let localAudioEvidence;
                if (local) {
                    const { recordLocalAsrUsage } = require('../workflow-runtime').loadWorkflow('ai/usage');
                    localAudioEvidence = await localStage().prepareLocalEvidence(packet, source, settings, evidenceDirectory, signature.localImplementation,
                        { digest: fileDigest, readJson: file => JSON.parse(fs.readFileSync(file, 'utf8')), writeJson: writeJsonAtomic,
                            exists: fs.existsSync, recordLocalUsage: recordLocalAsrUsage,
                            runPython: args.localDecode || (async (input, output) => { await execFile(root.asr?.paraformer?.python_executable || 'python',
                                [path.join(__dirname, '../python/activity_audio_evidence.py'), input, output],
                                { windowsHide: true, shell: false, timeout: 600000, maxBuffer: 4 * 1024 * 1024 }); }) });
                }
                const prompt = local ? localStage().localBoundaryPrompt(batch, packet, localAudioEvidence, info, rows) : boundaryPrompt(batch, packet, info, rows);
                result.requests++; result.audioSeconds += batch.audioSeconds;
                const response = await (args.request || requestMediaVerification)(prompt, local ? packet.frames : [...packet.audio, ...packet.frames], root,
                    { ...settings, timeoutMs: settings.boundaryTimeoutMs, maxTokens: 3000,
                        thinkingLevel: /^gemini-3/u.test(settings.model || '') ? 'minimal' : undefined });
                recordSelectionDiagnostic(diagnostics, { phase: 'activity-boundaries' }, response);
                const responsePath = path.join(evidenceDirectory, 'RESPONSE.json');
                let localBinding;
                if (local) {
                    writeJsonAtomic(responsePath, { ...response, requestBinding: { source, localAudioSha256: localAudioEvidence.sha256,
                        candidates: batch.events.map(({event, audioIndices}) => ({ id: event.id, start: event.start, end: event.end, audioIndices })),
                        frames: packet.frames } });
                    localBinding = { responsePath, responseSha256: fileDigest(responsePath), localAudioEvidence, frameEvidence: packet.frames };
                }
                const calibrated = parseBatch(local ? localStage().bindLocalReply(response, batch, localAudioEvidence, packet.frames) : response, batch, packet,
                    local ? [...rows, ...localStage().independentRows(localAudioEvidence)] : rows, duration,
                    local ? { ...evidence, ...localBinding } : evidence, settings);
                writeJsonAtomic(path.join(evidenceDirectory, 'RESULT.json'), { ...response, calibrated, localAudioEvidence });
                return { ...response, calibrated, ...(local ? { localAudioEvidence, packet, localBinding } : {}) };
            });
            if (response.meta?.selectionCache?.hit) result.cacheHits++;
            if (local && (fileDigest(response.localAudioEvidence.resultPath) !== response.localAudioEvidence.sha256
                || response.packet.frames.some(f => fileDigest(f.path) !== f.sha256))) throw new Error('Local activity evidence changed after verification');
            const calibrated = parseBatch(local ? localStage().bindLocalReply(response, batch, response.localAudioEvidence, response.packet.frames) : response, batch,
                local ? response.packet : boundaryPacket, local ? [...rows, ...localStage().independentRows(response.localAudioEvidence)] : rows,
                duration, local ? { ...evidence, ...response.localBinding } : evidence, settings);
            result.events.push(...calibrated.events); result.rejected.push(...calibrated.rejected);
        } catch (error) {
            recordSelectionDiagnostic(diagnostics, { phase: 'activity-boundaries' }, null, error);
            result.events.push(...batch.events.map(r => uncertain(r.event, error.message, evidence, duration, settings)));
        }
    }
    return result;
}
module.exports = { VERSION, boundaryIntervals, audioEnergy, uncertain, groupBoundaries, extractPacket, boundaryPrompt, parseBatch, calibrateBoundaries };
