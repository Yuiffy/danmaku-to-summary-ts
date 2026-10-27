'use strict';
const path = require('path');
const fs = require('fs');
const { fileDigest } = require('./source_snapshot');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { withSelectionCache } = require('./selection_cache');

const SAMPLE_SECONDS = 2, RESOLUTION_SECONDS = .25;
function parseClosingFrames(response, frames) {
    const row = JSON.parse(response.text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
    if (!String(row.reason || '').trim() || !Array.isArray(row.frames) || row.frames.length !== frames.length
        || row.frames.some((f, i) => f.index !== frames[i].index
            || !['game', 'other', 'uncertain'].includes(f.activity) || !String(f.description || '').trim())) {
        throw new Error('Game closing review must inspect every original frame');
    }
    return row;
}

/** Audio establishes the closing speech; visible menus/loading/fades may finish later. */
function closingBoundary(review) {
    const { spokenEnd, scanEnd, samples, frames } = review;
    if (!Number.isFinite(spokenEnd) || !Number.isFinite(scanEnd) || scanEnd - spokenEnd < SAMPLE_SECONDS
        || !Array.isArray(samples) || !Array.isArray(frames) || samples.length !== frames.length || samples.length < 2
        || Math.abs(samples[0].time - spokenEnd) > .001 || Math.abs(samples.at(-1).time - scanEnd) > .001
        || samples.some((s, i) => !Number.isFinite(s.time) || (i && (s.time <= samples[i - 1].time
            || s.time - samples[i - 1].time > SAMPLE_SECONDS + .001)))
        || frames.some((f, i) => f.index !== i + 1 || !['game', 'other', 'uncertain'].includes(f.activity)
            || !String(f.description || '').trim())) throw new Error('Game closing frame coverage is incomplete');
    const last = frames.findLastIndex(f => f.activity === 'game');
    // An unreadable earlier frame is retained regardless of its activity when a
    // later frame still proves game content. Only ambiguity after that last
    // confirmed game frame can change the exit boundary.
    if (frames.some((f, i) => f.activity === 'uncertain' && i > last)) throw new Error('Game closing frames remain uncertain');
    if (last === -1) return spokenEnd;
    if (last + 2 >= frames.length) throw new Error('Game remains visible at the end of the closing evidence');
    return samples[last + 1].time;
}

function validateClosingReview(review, end) {
    if (review?.version !== 1 || review.sampleSeconds !== SAMPLE_SECONDS || review.resolutionSeconds !== RESOLUTION_SECONDS
        || !String(review.reason || '').trim()) throw new Error('Original game closing frame review is missing');
    for (const context of review.contextReviews || []) {
        if (!context.responsePath || fileDigest(context.responsePath) !== context.responseSha256
            || !context.originalSample || fileDigest(context.originalSample.path) !== context.originalSample.sha256
            || !Array.isArray(context.samples) || context.samples.some(s => fileDigest(s.path) !== s.sha256)) {
            throw new Error('Original game closing context evidence changed');
        }
        const response = JSON.parse(fs.readFileSync(context.responsePath, 'utf8'));
        const result = parseClosingFrames(response, context.samples);
        const index = context.samples.findIndex(s => Math.abs(s.time - context.time) < .001);
        const sampleIndex = review.samples.findIndex(s => Math.abs(s.time - context.time) < .001);
        if (index < 0 || sampleIndex < 0 || review.samples[sampleIndex].sha256 !== context.samples[index].sha256
            || review.frames[sampleIndex].activity !== result.frames[index].activity
            || review.frames[sampleIndex].description !== result.frames[index].description) {
            throw new Error('Accepted game closing context differs from original review');
        }
    }
    const expected = closingBoundary(review), last = review.frames.findLastIndex(f => f.activity === 'game');
    if (last >= 0 && review.samples[last + 1].time - review.samples[last].time > RESOLUTION_SECONDS + .001) {
        throw new Error('Game closing transition needs finer original frames');
    }
    if (!Number.isFinite(end) || !Number.isFinite(review.end) || Math.abs(end - expected) > .001 || Math.abs(review.end - expected) > .001) {
        throw new Error('Accepted game ending differs from original closing frames');
    }
    return expected;
}

async function verifyClosingFrames({ spokenEnd, scanEnd, gameName, host, source, mediaPath, directory, root, settings, extract, request }) {
    if (scanEnd - spokenEnd < SAMPLE_SECONDS) throw new Error('Original closing excerpt does not show what follows the closing speech');
    const samples = [], observations = new Map(), reasons = [], attempts = [], contextReviews = [];
    async function inspect(times) {
        const batch = [];
        for (const time of times) {
            const frame = { index: samples.length + 1, time, path: path.join(directory, `closing-${time.toFixed(3)}.jpg`), mimeType: 'image/jpeg' };
            await extract(['-y', '-ss', String(time), '-i', mediaPath, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3', frame.path],
                { ffmpegPath: root.audio?.ffmpeg?.path || 'ffmpeg', threads: 1, stage: '核对游戏退出原帧', timeoutMs: 120000, sourceIdentity: source });
            frame.sha256 = fileDigest(frame.path); samples.push(frame); batch.push(frame);
        }
        const prompt = `Inspect EVERY original ${host} livestream frame after independently observed ${gameName} closing speech. Images are ${JSON.stringify(batch.map(({ index, time }) => ({ index, recordingSeconds: time })))}.
Classify visible live-session material as game, other, or uncertain. game includes actual gameplay, inventory/settings/exit-confirmation menus, title/loading/publisher logos and the remaining game image during an OBS crossfade, even over a talking avatar. An unobstructed talking scene with no remaining game imagery is other; this only describes the image, not whether an offscreen program has closed. Another person's replay/video player is other. Black or unreadable images and ambiguous fades are uncertain. Inspect the actual pixels; a closing announcement is not proof that the game image is gone. No audio or transcript is attached. Do not claim listening or invent game HUDs.
Return ONLY JSON {"reason":"specific visible transition evidence","frames":[{"index":original supplied index,"activity":"game|other|uncertain","description":"actual visible contents"}]}, preserving all supplied indices and order.`;
        const result = await withSelectionCache({ directory: path.join(path.dirname(directory), 'closing-cache'), phase: 'game-closing-frames-v1', prompt,
            signature: { source, settings, frames: batch.map(({time, sha256}) => ({time, sha256})) },
            validate: value => { try { parseClosingFrames(value, batch); return true; } catch { return false; } } },
        () => request(prompt, batch, root, settings));
        writeJsonAtomic(path.join(directory, `closing-response-${batch[0].index}.json`), result);
        const reviewed = parseClosingFrames(result, batch);
        reasons.push(reviewed.reason); attempts.push(...(result.meta?.attempts || []));
        reviewed.frames.forEach((f, i) => observations.set(batch[i].time, f));
    }
    const times = [];
    for (let t = spokenEnd; t < scanEnd - .001; t += SAMPLE_SECONDS) times.push(t);
    // Coalescing a near-end sample can leave a 2.001s gap whose binary value
    // exceeds the coverage limit. Inspect an actual midpoint, keeping the
    // original coverage validator and the exact excerpt endpoint unchanged.
    if (scanEnd - times.at(-1) > SAMPLE_SECONDS) times.push((times.at(-1) + scanEnd) / 2);
    times.push(scanEnd);
    for (let i = 0; i < times.length; i += 8) await inspect(times.slice(i, i + 8));
    async function inspectUncertainContext() {
        const ordered = [...samples].sort((a, b) => a.time - b.time);
        const lastGame = ordered.findLastIndex(s => observations.get(s.time).activity === 'game');
        for (let i = lastGame + 1; i < ordered.length; i++) {
            const sample = ordered[i];
            if (observations.get(sample.time).activity !== 'uncertain') continue;
            const originalSample = { ...sample };
            const full = { ...sample, path: path.join(directory, `closing-context-${sample.time.toFixed(3)}.jpg`) };
            await extract(['-y', '-ss', String(sample.time), '-i', mediaPath, '-frames:v', '1', '-q:v', '2', full.path],
                { ffmpegPath: root.audio?.ffmpeg?.path || 'ffmpeg', threads: 1, stage: '核对游戏退出暗帧上下文', timeoutMs: 120000, sourceIdentity: source });
            full.sha256 = fileDigest(full.path);
            const batch = ordered.slice(Math.max(0, i - 1), Math.min(ordered.length, i + 2))
                .map(s => ({ ...(s.time === sample.time ? full : s) }));
            const prompt = `Re-inspect these consecutive original ${host} livestream frames to resolve the visible ${gameName} exit transition. The middle target at recording ${sample.time} is supplied at its original resolution. Images are ${JSON.stringify(batch.map(({ index, time }) => ({ index, recordingSeconds: time })))}.
Classify EACH actual image as game, other, or uncertain. Game includes readable game imagery, menus, loading/title screens and faint remaining game image during a fade. Compare visible faint shapes with the adjacent original images: overall darkness alone does not erase a visible menu or logo. Do not classify a completely unreadable black image as game just because its neighbors are game. Other requires a clearly visible unrelated scene with no remaining game imagery. Black images with no identifiable game content and ambiguous fades remain uncertain. You have no audio, transcript or proposed accepted ending. Retain uncertainty when the actual pixels cannot resolve it.
Return ONLY JSON {"reason":"specific pixel and transition evidence","frames":[{"index":original supplied index,"activity":"game|other|uncertain","description":"actual visible contents"}]}, preserving every supplied index and order.`;
            const result = await withSelectionCache({ directory: path.join(path.dirname(directory), 'closing-cache'),
                phase: 'game-closing-context-v1', prompt, signature: { source, settings, frames: batch.map(({time, sha256}) => ({time, sha256})) },
                validate: value => { try { parseClosingFrames(value, batch); return true; } catch { return false; } } },
                () => request(prompt, batch, root, settings));
            const responsePath = path.join(directory, `closing-context-response-${sample.time.toFixed(3)}.json`);
            writeJsonAtomic(responsePath, result);
            const reviewed = parseClosingFrames(result, batch);
            contextReviews.push({ time: sample.time, originalSample, samples: batch, responsePath, responseSha256: fileDigest(responsePath) });
            observations.set(sample.time, reviewed.frames[batch.findIndex(f => f.time === sample.time)]);
            Object.assign(sample, full);
            reasons.push(reviewed.reason); attempts.push(...(result.meta?.attempts || []));
        }
    }
    await inspectUncertainContext();
    const snapshot = () => {
        const ordered = [...samples].sort((a, b) => a.time - b.time);
        return { version: 1, spokenEnd, scanEnd, sampleSeconds: SAMPLE_SECONDS, resolutionSeconds: RESOLUTION_SECONDS,
            samples: ordered.map((s, i) => ({ ...s, index: i + 1 })),
            frames: ordered.map((s, i) => ({ ...observations.get(s.time), index: i + 1 })), reason: reasons.join('; '),
            provider: settings.provider, model: settings.model, apiMode: settings.apiMode, attempts, contextReviews };
    };
    let review = snapshot();
    closingBoundary(review);
    const last = review.frames.findLastIndex(f => f.activity === 'game');
    if (last >= 0) {
        const extra = [];
        for (let t = review.samples[last].time + RESOLUTION_SECONDS; t < review.samples[last + 1].time - .001; t += RESOLUTION_SECONDS) extra.push(t);
        for (let i = 0; i < extra.length; i += 8) await inspect(extra.slice(i, i + 8));
        await inspectUncertainContext();
        review = snapshot();
    }
    review.end = closingBoundary(review);
    validateClosingReview(review, review.end);
    writeJsonAtomic(path.join(directory, 'CLOSING.json'), review);
    return review;
}

module.exports = { SAMPLE_SECONDS, RESOLUTION_SECONDS, parseClosingFrames, closingBoundary, validateClosingReview, verifyClosingFrames };
