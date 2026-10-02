'use strict';
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { runFfmpeg } = require('./media_runtime');
const { withSelectionCache } = require('./selection_cache');
const { sha, parseEvents } = require('./stream_activity_plan');
const { recordSelectionDiagnostic } = require('./selection_request');
// Keep cached response evidence paths stable when plan validation changes but media packets do not.
const MEDIA_PACKET_VERSION = 7;

async function requestMediaVerification(prompt, inputs, root, settings) {
    const provider = settings.provider || 'tuZi';
    const credentials = root.ai?.text?.[provider] || {};
    if (!credentials.apiKey) throw new Error(`${provider} audio/video verification is not configured`);
    const model = settings.model || root.ai?.text?.gemini?.model;
    if (!model || !/^[a-zA-Z0-9._-]+$/u.test(model)) throw new Error('Invalid activity verification model');
    const contents = [{ role: 'user', parts: [{ text: prompt }, ...inputs.map(input => ({ inlineData: {
        mimeType: input.mimeType, data: fs.readFileSync(input.path).toString('base64') } }))] }];
    const chat = { model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...inputs.map(input =>
        input.mimeType.startsWith('audio/') ? { type: 'input_audio', input_audio: { data: fs.readFileSync(input.path).toString('base64'), format: 'mp3' } }
            : { type: 'image_url', image_url: { url: `data:${input.mimeType};base64,${fs.readFileSync(input.path).toString('base64')}` } })] }],
        temperature: .1, max_tokens: settings.maxTokens || 8192, response_format: { type: 'json_object' } };
    const native = provider === 'gemini' || settings.apiMode === 'gemini_native';
    const baseUrl = String(credentials.baseUrl || 'https://api.tu-zi.com').replace(/\/(?:v1)?\/?$/u, '');
    const url = provider === 'gemini' ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
        : native ? `${baseUrl}/v1beta/models/${model}:generateContent` : `${baseUrl}/v1/chat/completions`;
    const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(provider === 'gemini'
            ? { 'x-goog-api-key': credentials.apiKey } : { Authorization: `Bearer ${credentials.apiKey}` }) },
        body: JSON.stringify(native ? { contents, generationConfig: {
            temperature: .1, responseMimeType: 'application/json', maxOutputTokens: settings.maxTokens || 8192,
            ...(settings.thinkingLevel ? { thinkingConfig: { thinkingLevel: settings.thinkingLevel } } : {}) } } : chat),
        agent: credentials.proxy ? new HttpsProxyAgent(credentials.proxy) : undefined, timeout: settings.timeoutMs });
    if (!response.ok) {
        let message = '';
        try { message = String((await response.json()).error?.message || '').replaceAll(credentials.apiKey, '[redacted]').slice(0, 400); } catch { /* status still explains the failure */ }
        throw new Error(`Activity media verification HTTP ${response.status}${message ? `: ${message}` : ''}`);
    }
    const data = await response.json();
    const candidate = native ? data.candidates?.[0] : data.choices?.[0];
    const finish = candidate?.finishReason || candidate?.finish_reason;
    if (!['STOP', 'stop'].includes(finish)) throw new Error(`Activity verification incomplete: ${finish || 'missing candidate'}`);
    const text = native ? candidate.content?.parts?.filter(p => typeof p.text === 'string').map(p => p.text).join('') : candidate.message?.content;
    if (!text) throw new Error('Activity verification returned no JSON');
    const usage = data.usageMetadata || data.usage || {};
    return { text, meta: { model, apiMode: native ? 'gemini_native' : 'openai_chat', attempts: [{ provider, model, status: 'success', finishReason: 'completed',
        inputAudioTokens: usage.promptTokensDetails?.filter(p => p.modality === 'AUDIO').reduce((sum, p) => sum + p.tokenCount, 0),
        promptTokens: usage.promptTokenCount ?? usage.prompt_tokens, completionTokens: usage.candidatesTokenCount ?? usage.completion_tokens,
        reasoningTokens: usage.thoughtsTokenCount ?? usage.completion_tokens_details?.reasoning_tokens,
        totalTokens: usage.totalTokenCount ?? usage.total_tokens, usageFinal: true }] } };
}
function parseVerification(response, event, window, duration, audio = []) {
    const raw = JSON.parse(response.text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
    if (!['keep', 'exclude', 'uncertain'].includes(raw.decision) || !String(raw.reason || '').trim()) throw new Error('Invalid activity verification decision');
    if (raw.decision !== 'keep') return { decision: raw.decision, reason: raw.reason, events: raw.decision === 'exclude' ? [] : [event] };
    if (!['audio_local_seconds', 'recording_seconds'].includes(raw.timeBasis)) throw new Error('Verification needs an explicit timeBasis; relative timestamps cannot be interpreted as recording seconds');
    if (!Array.isArray(raw.events) || raw.events.length !== 1) throw new Error('Verify one complete candidate at a time; verses, choruses and neighboring context performances cannot become separate events');
    const normalizeQuote = text => String(text || '').replace(/\[[^\]]+\]/gu, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    const quotes = Array.isArray(raw.audibleEvidence) ? raw.audibleEvidence.filter(q => typeof q === 'string' && normalizeQuote(q).length >= 4) : [];
    if (!quotes.length) throw new Error('Verification needs specific audibleEvidence quotes, not a generic performance claim');
    const absolute = boundary => {
        if (raw.timeBasis === 'recording_seconds') return boundary;
        const span = Number.isInteger(boundary?.audioIndex) && audio[boundary.audioIndex - 1];
        if (!span || typeof boundary.seconds !== 'number' || !Number.isFinite(boundary.seconds)
            || boundary.seconds < 0 || boundary.seconds > span.end - span.start + .01) throw new Error('Verification boundary is outside its declared audio attachment');
        return span.start + boundary.seconds;
    };
    // Audio is inspected without transcript claims. Bind the observed intervals to
    // existing source citations and supported titles locally, never invented model IDs.
    const observed = raw.events.map(row => ({ ...row, start: absolute(row.start), end: absolute(row.end) }))
        .map((row, index) => ({ ...row, name: index === 0 ? event.name : null,
        evidenceIds: event.evidenceIds.filter(id => window.rows.some(r => r.id === id && r.end >= row.start - 180 && r.start <= row.end + 180)),
        titleEvidenceIds: index === 0 ? event.titleEvidenceIds : [] }));
    const events = parseEvents({ events: observed }, window, duration);
    if (!events.length || events.some(e => e.kind !== event.kind)) throw new Error('Verification changed an unrelated activity');
    if (event.kind === 'song' && event.performance === 'full' &&
        ((event.startObserved && events[0].start > event.start + .5) || (event.endObserved && events[0].end < event.end - .5))) {
        throw new Error('Full performance would omit recalled singing; locate the musical intro/outro outside the sung interval or return uncertain, never trim a verse');
    }
    const quoteEvidenceIds = window.rows.filter(row => row.source === 'audio_transcript'
        && events.some(e => row.end >= e.start - 5 && row.start <= e.end + 5)
        && quotes.some(quote => { const q = normalizeQuote(quote), text = normalizeQuote(row.text);
            return text.includes(q) || (text.length >= 4 && q.includes(text)); })).map(row => row.id);
    if (!quoteEvidenceIds.length) throw new Error('Audible quotes do not match the source transcript near the observed activity; keep uncertainty for review');
    return { decision: raw.decision, reason: raw.reason, audibleEvidence: quotes, quoteEvidenceIds, events };
}
async function verifyActivity(event, { root, config, source, info, directory, rows, duration, diagnostics, request, extract }) {
    const settings = config.verification;
    const fallback = (reason, evidence = {}) => {
        const preserveContext = event.kind === 'song' && event.performance === 'full' && Number.isFinite(duration);
        return { decision: 'uncertain', reason, events: [{ ...event,
            ...(preserveContext ? { provisionalWindow: { start: Math.max(0, event.start - Math.min(settings.contextSeconds, 90)),
                end: Math.min(duration, event.end + Math.min(settings.contextSeconds, 30)) }, startObserved: false, endObserved: false } : {}),
            verification: { decision: 'uncertain', reason, ...evidence },
            reviewIssues: [...new Set([...(event.reviewIssues || []), 'media_verification_unconfirmed',
                ...(preserveContext ? ['performance_boundary_provisional'] : [])])] }] };
    };
    if (!settings.enabled) return fallback('Media verification disabled');
    if (!root.ai?.text?.[settings.provider || 'tuZi']?.apiKey && !request) return fallback('Audio/video verifier unavailable');
    const completeSong = event.kind === 'song' && event.performance === 'full';
    const beforeSong = Math.min(settings.contextSeconds, completeSong ? 90 : 30);
    const afterSong = Math.min(settings.contextSeconds, 30);
    const intervals = event.kind === 'song'
        ? [{ start: Math.max(0, event.start - beforeSong), end: Math.min(duration, event.end + afterSong) }]
        : [{ start: Math.max(0, event.start - settings.contextSeconds), end: Math.min(duration, event.start + settings.contextSeconds) },
            { start: Math.max(0, event.end - settings.contextSeconds), end: Math.min(duration, event.end + settings.contextSeconds) }];
    if (intervals.length === 2 && intervals[0].end >= intervals[1].start) intervals.splice(0, 2, { start: intervals[0].start, end: intervals[1].end });
    if (completeSong) intervals.push(
        { start: intervals[0].start, end: Math.min(event.end, event.start + 30) },
        { start: Math.max(event.start, event.end - 30), end: intervals[0].end });
    if (intervals.reduce((n, row) => n + row.end - row.start, 0) > settings.maxAudioSeconds) return fallback('Performance too long for one audio-verification packet; full media review required');
    const cited = new Set(event.evidenceIds);
    const localRows = rows.filter(r => cited.has(r.id) || intervals.some(w => r.end >= w.start && r.start <= w.end));
    const window = { index: event.windows[0] || 1, start: event.start, end: event.end,
        from: intervals[0].start, to: intervals.at(-1).end, rows: localRows };
    const scratch = path.join(directory, 'temp', 'media-verification', sha({ source, event, settings, intervals, version: MEDIA_PACKET_VERSION }).slice(0, 16));
    fs.mkdirSync(scratch, { recursive: true });
    const audio = intervals.map((span, i) => ({ ...span, path: path.join(scratch, `audio-${i + 1}.mp3`), mimeType: 'audio/mpeg' }));
    const frameTimes = [...new Set([Math.max(0, event.start - 5), event.start + Math.min(8, (event.end - event.start) / 2),
        event.end - Math.min(8, (event.end - event.start) / 2), Math.min(duration - .1, event.end + 5)])];
    const frames = frameTimes.map((time, i) => ({ time, path: path.join(scratch, `frame-${i + 1}.jpg`), mimeType: 'image/jpeg' }));
    const prompt = `Listen to the attached original recording audio and inspect the actual frames to independently check ONE candidate for ${event.kind === 'song' ? 'a host singing performance' : 'actual video playback with the host watching'}.
Host ${info.streamerName}. ${completeSong ? 'The main audio contains one recalled candidate performance; the initial lyric timestamps are withheld so they cannot be copied as musical boundaries.' : `The text detector suggests an unverified interval ${event.start}-${event.end}.`} Its transcript and activity interpretation are deliberately withheld. Determine what ACTUALLY happens in the attached media. Normal conversational intonation is not singing.
Audio attachments in order: ${audio.map((a, i) => `audio ${i + 1}: absolute recording seconds ${a.start}-${a.end}; local audio 0 = recording ${a.start}`).join('; ')}.
${completeSong ? 'Audio 1 is the complete performance with nearby speech. Audio 2 isolates the lead-in and musical beginning; audio 3 isolates the last sung line, outro and subsequent speech. Locate the actual backing-track onset in audio 2, including accompaniment while the host still talks, and the last accompaniment ending in audio 3. A first lyric timestamp is not the intro. Return start using audioIndex 2 and end using audioIndex 3. If the musical boundary cannot be located, retain the available audio with observed=false rather than claiming the first lyric is a complete start.' : `The candidate begins near local ${(event.start - audio[0].start).toFixed(3)} seconds in audio 1 and ends near local ${(event.end - audio.at(-1).start).toFixed(3)} seconds in audio ${audio.length}. Focus on this candidate; earlier/later performances in the context are not additional candidates.`} Return boundary times in LOCAL AUDIO SECONDS with the 1-based audioIndex. The program will convert them to recording seconds; do not do that conversion yourself.
Following images in order: ${frames.map((f, i) => `image ${i + 1}: recording ${f.time.toFixed(3)} seconds`).join('; ')}.
Identify the live host voice from nearby speech and scene; recorded singers/film characters, BGM on the opening/waiting screen, replayed old performances, a named song not sung, and '哒哒'/sound effects without a song performance must be excluded. Quote actual audible speech and sung lyrics in the reason, rather than repeating the suggested interval as proof. Deliberately sung recognizable song fragments are retained as fragment. Do not exclude a sung verse merely because it is short.
For songs listen for the actual intro, first note, instrumental pauses, last sung line and accompaniment ending. Include the complete intentional performance; exclude later unrelated speech or old replay. Keep the verses, rap/bridge, repeated choruses and instrumental pauses of the SAME performance together in ONE continuous event. A lyric change is not a new song. This step refines one recalled candidate and must not split it into separate verses or add nearby performances from context. If it actually contains multiple distinct performances that cannot be resolved as one candidate, return uncertain for review. Adjust start/end to those audio boundaries within provided audio. The source may begin/end during a performance: retain available content with observed=false, never invent missing audio.
For viewing preserve the whole continuous watch timeline including pauses and host comments; use the boundary audios and frames to refine start/end. The middle has been inspected by the complete text detector. Never replace a full session with only the boundary excerpts. Exclude mere discussion of movies without actual playback. Do not assert visual evidence proves a speaker's identity or guess an exact frame boundary from sparse images.
Do not guess titles or transcript citations; those are bound separately from source text. Return ONLY JSON {"decision":"keep|exclude|uncertain","timeBasis":"audio_local_seconds","audibleEvidence":["short verbatim actually heard words or lyrics in their ORIGINAL language","another actual phrase"],"reason":"specific actually heard lead-in speech, first/last lyrics, subsequent speech and seen playback","events":[{"kind":"${event.kind}","start":{"audioIndex":${completeSong ? 2 : 1},"seconds":0.0},"end":{"audioIndex":${audio.length},"seconds":1.0},"performance":"full|fragment" (songs only),"mediaKind":"movie|anime|video" (watch only),"startObserved":true,"endObserved":true,"note":"boundary rationale"}]}. The numeric values are placeholders; replace them with the actual observed boundaries. keep has exactly ONE event and specific original-language audibleEvidence. Generic statements that the host sang are insufficient. exclude has events:[], uncertain preserves the original candidate for human review. Keep requires actual media support. If the supplied media does not match the suggested activity, exclude or return uncertain; never use the suggested timestamps alone as evidence.`;
    try {
        const response = await withSelectionCache({ directory: path.join(directory, 'temp', 'verification-cache'),
            phase: 'activity-media-v1', prompt, signature: { source, settings, model: settings.model || root.ai?.text?.gemini?.model },
            validate: response => { try { parseVerification(response, event, window, duration, audio); return true; } catch { return false; } } }, async () => {
            const run = extract || runFfmpeg;
            for (const a of audio) await run(['-y', '-ss', String(a.start), '-i', source.mediaPath,
                '-t', String(a.end - a.start), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', a.path],
            { ffmpegPath: root.audio?.ffmpeg?.path || 'ffmpeg', stage: '活动原音频复核', timeoutMs: 120000 });
            for (const frame of frames) await run(['-y', '-ss', String(frame.time), '-i', source.mediaPath,
                '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', frame.path],
            { ffmpegPath: root.audio?.ffmpeg?.path || 'ffmpeg', stage: '活动画面复核', timeoutMs: 60000 });
            let requestPrompt = prompt;
            const attempts = [];
            for (let attempt = 0; attempt < 2; attempt++) {
                const response = await (request || requestMediaVerification)(requestPrompt, [...audio, ...frames], root, settings);
                try {
                    parseVerification(response, event, window, duration, audio);
                    return { ...response, meta: { ...response.meta, retryAttempts: attempts } };
                } catch (error) {
                    attempts.push(...(response.meta?.attempts || []));
                    if (attempt === 1) throw Object.assign(error, { attempts });
                    requestPrompt = `${prompt}\nFORMAT REPAIR: ${error.message}. Recheck the attached original media and return the declared local-audio boundary objects for exactly one complete candidate. Previous output (untrusted): ${response.text}`;
                }
            }
        });
        recordSelectionDiagnostic(diagnostics, { phase: 'activity-media', provider: 'gemini' }, response);
        const observation = parseVerification(response, event, window, duration, audio);
        const verified = observation.decision === 'uncertain' ? fallback(observation.reason) : observation;
        return { ...verified, evidenceDirectory: scratch, model: response.meta?.model, events: verified.events.map(e => ({ ...e,
            reviewIssues: [...new Set([...(e.reviewIssues || []), ...(!e.startObserved ? ['start_boundary_unconfirmed'] : []),
                ...(!e.endObserved ? ['end_boundary_unconfirmed'] : []), ...(verified.decision === 'uncertain' ? ['media_verification_unconfirmed'] : [])])],
            verification: { decision: verified.decision, reason: verified.reason, evidenceDirectory: scratch,
                audibleEvidence: verified.audibleEvidence, quoteEvidenceIds: verified.quoteEvidenceIds,
                audioIntervals: intervals, frameTimes, model: response.meta?.model, apiMode: response.meta?.apiMode } })) };
    } catch (error) {
        recordSelectionDiagnostic(diagnostics, { phase: 'activity-media', provider: 'gemini' }, null, error);
        return fallback(error.message, { evidenceDirectory: scratch, audioIntervals: intervals, frameTimes,
            model: settings.model || root.ai?.text?.gemini?.model, apiMode: settings.apiMode });
    }
}
module.exports = { requestMediaVerification, parseVerification, verifyActivity };
