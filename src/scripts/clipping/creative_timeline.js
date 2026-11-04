'use strict';
const { srtText } = require('./creative_subtitles');
const round = n => Math.round(n * 1000) / 1000;
const overlap = (a, b) => a.start < b.end - .0005 && b.start < a.end - .0005;

// Only acceleration is offered: slowing a live performance or a punchline reads as
// a different clip, while skipping uneventful traversal is an ordinary editorial cut.
const SPEED_MIN = 1.2, SPEED_MAX = 10, MIN_SPED_CUE_SECONDS = .75;
const MIN_SPEED_COVERAGE = .5;
// From this rate up a whole subtitle line flashes past faster than anyone can read,
// so the accelerated span drops burned-in captions and shows a rate badge instead.
// Below it the sped captions must still clear MIN_SPED_CUE_SECONDS.
const CAPTION_BLACKOUT_RATE = 2.5;
const speedOf = span => Number(span?.speed) > 1 ? Number(span.speed) : 1;
const pieceSeconds = span => (span.end - span.start) / speedOf(span);
const validSpeed = value => Number.isFinite(value) && value >= SPEED_MIN - 1e-9 && value <= SPEED_MAX + 1e-9;
const protectedRoles = new Set(['setup', 'payoff', 'reaction', 'closing', 'performance']);

function protectedStorySpans(clip, evidence, danmaku, window, sourceExpansion = null) {
    const ids = new Set((clip.attributionReview?.claims || []).flatMap(row => [...(row.cueIds || []), ...(row.speakerCueIds || [])]));
    for (const id of clip.grounding?.danmakuIds || []) ids.add(id);
    const expanded = sourceExpansion ? require('./creative_source_expansion').validateSourceExpansion(sourceExpansion, clip, evidence, window) : [];
    return [...expanded, ...(clip.topicEditPlan ? require('./topic_edit_plan').storyConstraints(clip.topicEditPlan, evidence, window,
        sourceExpansion?.originalWindow || window) : []), ...[...ids].map(id => {
        const cue = evidence.byId.get(id);
        const audience = /^D[1-9]\d*$/.test(id) ? danmaku[Number(id.slice(1)) - 1] : null;
        if (!cue && !audience) throw new Error(`Missing protected story evidence: ${id}`);
        return { id, start: Math.max(0, (cue?.start ?? audience.time) - window.start),
            end: Math.min(window.end - window.start, (cue?.end ?? audience.time + .05) - window.start), text: cue?.text ?? audience.text };
    })];
}

// Evidence groups (G/D IDs) and editable subtitle cues (C IDs) use different
// boundaries. Expose their relationship without weakening the original spans.
function protectedStoryCues(protectedSpans, cues) {
    return protectedSpans.map(span => ({ ...span,
        cueIds: cues.filter(cue => overlap(cue, span)).map(cue => cue.id) }));
}

function assertTimeline(timeline, sourceDuration) {
    if (timeline?.version !== 1 || Math.abs(timeline.sourceDuration - sourceDuration) > .001
        || !Array.isArray(timeline.keep) || !timeline.keep.length || timeline.keep.length > 32) throw new Error('Invalid editorial timeline');
    let duration = 0, sped = 0;
    for (const [i, span] of timeline.keep.entries()) {
        if (![span.start, span.end].every(Number.isFinite) || span.start < 0 || span.end > sourceDuration + .001
            || span.end <= span.start || (i && span.start < timeline.keep[i - 1].end - .001)) throw new Error('Editorial spans overlap, reorder, or exceed source');
        if (span.speed !== undefined && span.speed !== null && span.speed !== 1) {
            if (!validSpeed(span.speed)) throw new Error(`Editorial speed must be between ${SPEED_MIN}x and ${SPEED_MAX}x`);
            if (!String(span.speedReason || '').trim()) throw new Error('An accelerated span requires a written reason');
            if (timeline.holds?.length) throw new Error('Accelerated spans cannot be combined with reaction holds');
        }
        duration += pieceSeconds(span);
        sped += (span.end - span.start) - pieceSeconds(span);
    }
    if (timeline.holds?.length) {
        const pieces = require('../workflow-runtime').loadWorkflow('clipping/enhancement').reactionPieces(timeline);
        const added = pieces.reduce((n, p) => n + p.hold, 0);
        if (Math.abs(added - timeline.addedSeconds) > .002) throw new Error('Reaction pause duration mismatch');
        duration += added;
    }
    if (Math.abs(duration - timeline.duration) > .002) throw new Error('Editorial duration does not match retained spans');
    if (sped > .001 && Math.abs((timeline.spedSavedSeconds ?? sped) - sped) > .002) throw new Error('Accelerated span duration mismatch');
}

// A sped span must still be readable: every retained cue stays whole but shows for
// less time, so the shortest word decides whether this rate is honest. Spans fast
// enough to black the captions out are exempt — they are silent by design and the
// rate badge carries the information instead.
function assertSpedCuesReadable(keep, cues) {
    const issues = [];
    for (const span of keep) {
        const speed = speedOf(span);
        if (speed <= 1 || speed >= CAPTION_BLACKOUT_RATE - 1e-9) continue;
        for (const cue of cues) {
            if (cue.start < span.start - .002 || cue.end > span.end + .002) continue;
            const shown = (cue.end - cue.start) / speed;
            if (shown < MIN_SPED_CUE_SECONDS - .001) {
                issues.push(`${cue.id}「${String(cue.text || '').slice(0, 12)}」${speed}x 后仅 ${shown.toFixed(2)}s`);
            }
        }
    }
    if (issues.length) throw new Error(`Acceleration makes subtitles unreadable: ${issues.join('；')}`);
}

function validateStoryPlan(raw, cues, sourceDuration, protectedSpans = [], profile = null, endingHoldSeconds = .22) {
    if (!Array.isArray(raw?.keep) || !raw.keep.length || raw.keep.length > 32) throw new Error('Missing story keep ranges');
    let lastCue = -1;
    const keep = raw.keep.map((row, index) => {
        const a = cues.findIndex(c => c.id === row.fromCue), b = cues.findIndex(c => c.id === row.toCue);
        if (a < 0 || b < a || !String(row.reason || '').trim()
            || !['setup', 'escalation', 'reaction', 'payoff', 'context', 'step', 'explanation', 'performance', 'closing'].includes(row.role)) throw new Error('Story ranges require ordered real cue IDs, reason and role');
        // A repair may repeat the previous range's final cue when two editorial
        // groups meet at the same subtitle. The groups are merged below, so the
        // cue is retained once without weakening ordering for earlier repeats.
        if (a < lastCue || (a === lastCue && b <= lastCue)) throw new Error(`Keep ranges must be chronological and disjoint: ${row.fromCue} repeats or precedes C${lastCue + 1}`);
        lastCue = b;
        const actionBefore = row.actionBeforeSeconds === undefined ? .12 : row.actionBeforeSeconds;
        if (!Number.isFinite(actionBefore) || actionBefore < 0 || actionBefore > 12) throw new Error('actionBeforeSeconds must be finite and between 0 and 12');
        // Keep brief action leading into a reaction, without including partial omitted speech.
        // An operator may flag a silent beat (a laugh, a sigh) between two lines as
        // performance rather than dead air. Holding the preceding span into the next
        // cue keeps that beat instead of letting the cut land on the subtitle end.
        const holdAfter = row.holdAfterSeconds === undefined || row.holdAfterSeconds === null
            ? (index === raw.keep.length - 1 ? endingHoldSeconds : .22) : Number(row.holdAfterSeconds);
        if (!Number.isFinite(holdAfter) || holdAfter < 0 || holdAfter > 12) throw new Error('holdAfterSeconds must be finite and between 0 and 12');
        const start = Math.max(0, cues[a].start - Math.max(.12, actionBefore), a ? cues[a - 1].end : 0);
        const end = Math.min(sourceDuration, cues[b].end + holdAfter, cues[b + 1]?.start ?? sourceDuration);
        const span = { start: round(start), end: Math.min(sourceDuration, round(end)), reason: row.reason, role: row.role, firstCue: a, lastCue: b };
        if (row.speed !== undefined && row.speed !== null && Number(row.speed) !== 1) {
            const speed = Number(row.speed), speedReason = String(row.speedReason || '').trim();
            if (!validSpeed(speed)) throw new Error(`Story range speed must be between ${SPEED_MIN}x and ${SPEED_MAX}x: ${row.fromCue}-${row.toCue}`);
            if (!speedReason) throw new Error(`Accelerated range ${row.fromCue}-${row.toCue} needs a speedReason`);
            if (protectedRoles.has(row.role)) throw new Error(`Only traversal, grinding or repeated action may be accelerated; ${row.fromCue}-${row.toCue} is ${row.role}`);
            span.speed = round(speed);
            span.speedReason = speedReason;
        }
        return span;
    });
    if (keep.some((s, i) => i && s.start < keep[i - 1].end - .001
        && s.firstCue !== keep[i - 1].lastCue && s.firstCue !== keep[i - 1].lastCue + 1)) {
        throw new Error('Keep ranges overlap across omitted speech');
    }
    const merged = [];
    // Adjacent retained cue groups can share padding in a short pause. Union it once,
    // but never merge spans that need different playback rates. Different rates still
    // meet inside that same padding, so clamp instead of emitting overlapping spans.
    for (const row of keep) {
        const { firstCue, lastCue, ...span } = row;
        const previous = merged.at(-1);
        if (previous && span.start - previous.end < .06 && speedOf(span) === speedOf(previous)) {
            previous.end = Math.max(previous.end, span.end); previous.reason += `；${span.reason}`;
            if (span.speedReason && !previous.speedReason) previous.speedReason = span.speedReason;
            // The merged span plays as one piece: if any part is operator-decreed process
            // footage, a protected role on the front part would get the rate plan erased.
            if (protectedRoles.has(previous.role) && !protectedRoles.has(span.role)) previous.role = span.role;
            continue;
        }
        if (previous && span.start < previous.end - .001) span.start = round(previous.end);
        if (!(span.end > span.start)) throw new Error('Keep ranges collide inside shared padding at different playback rates');
        merged.push({ ...span });
    }
    for (const cue of cues) if (merged.some(span => overlap(cue, span))
        && !merged.some(span => cue.start >= span.start - .001 && cue.end <= span.end + .001)) throw new Error(`Cut would truncate speech ${cue.id}`);
    const missing = protectedSpans.filter(cue => !merged.some(s => cue.start >= s.start - .002 && cue.end <= s.end + .002));
    if (missing.length) throw new Error(`Retain public-copy evidence: ${missing.map(c => `${c.id} ${c.start.toFixed(3)}-${c.end.toFixed(3)}`).join(', ')}`);
    // A continuous performance must remain one uninterrupted kept span, but a
    // song introduction and a closing reaction may surround that span.
    if (profile?.preserveContinuity && merged.filter(span => span.role === 'performance').length > 1) {
        throw new Error('This performance/continuous passage must not be internally spliced');
    }
    if (!profile && (!keep.some(s => s.role === 'setup') || !keep.some(s => s.role === 'payoff'))) throw new Error('Story needs setup and payoff');
    assertSpedCuesReadable(merged, cues);
    const retained = round(merged.reduce((n, s) => n + s.end - s.start, 0));
    const duration = round(merged.reduce((n, s) => n + pieceSeconds(s), 0));
    if (!profile && sourceDuration > 60 && retained > sourceDuration * .75) throw new Error('Compact edit still retains over 75% of the source; remove redundant complete exchanges');
    const timeline = { version: 1, sourceDuration, duration, keep: merged, removedSeconds: round(sourceDuration - retained),
        ...(duration < retained - .001 ? { spedSavedSeconds: round(retained - duration) } : {}) };
    assertTimeline(timeline, sourceDuration);
    return timeline;
}

// An explicit operator-requested rate plan uses absolute recording seconds so it can
// be re-applied to a re-edited story. Boundaries are snapped to whole subtitles and
// every requested window must really belong to a retained span.
function applySpeedWindows(timeline, windows, cues = [], window = null) {
    if (!Array.isArray(windows) || !windows.length) return timeline;
    if (timeline.holds?.length) throw new Error('Accelerated spans cannot be combined with reaction holds');
    const origin = Number(window?.start) || 0, horizon = timeline.sourceDuration;
    const requested = windows.map((row, index) => {
        const rate = Number(row?.rate ?? row?.speed);
        if (!validSpeed(rate)) throw new Error(`Speed window ${index + 1} rate must be between ${SPEED_MIN}x and ${SPEED_MAX}x`);
        const start = Number(row.start ?? row.startSeconds) - origin, end = Number(row.end ?? row.endSeconds) - origin;
        if (![start, end].every(Number.isFinite) || end <= start) throw new Error(`Speed window ${index + 1} needs finite start < end`);
        if (start < -1e-6 || end > horizon + 1e-6) throw new Error(`Speed window ${index + 1} falls outside the source window`);
        return { start: Math.max(0, start), end: Math.min(horizon, end), rate, reason: String(row.reason || '').trim() || `运营指定 ${rate}x 加速` };
    }).sort((a, b) => a.start - b.start);
    for (let i = 1; i < requested.length; i += 1) {
        if (requested[i].start < requested[i - 1].end - .001) throw new Error('Speed windows overlap');
    }
    const snap = value => {
        const cue = cues.find(row => row.start < value - .001 && row.end > value + .001);
        if (!cue) return value;
        return value - cue.start <= cue.end - value ? round(cue.start) : round(cue.end);
    };
    // A window edge that lands inside a protected span is an operator approximation,
    // not a request to speed up the setup/payoff itself: shrink the edge instead of
    // failing the whole render. A protected span fully inside a window still fails.
    const guarded = (timeline.keep || []).filter(span => protectedRoles.has(span.role));
    const plan = requested.map(row => ({ ...row, start: snap(row.start), end: snap(row.end) }))
        .map(row => {
            let start = Math.max(0, row.start), end = Math.min(horizon, row.end), trimmed = 0;
            for (const span of guarded) {
                if (start > span.start + .001 && start < span.end - .001) { trimmed += span.end - start; start = span.end; }
                if (end > span.start + .001 && end < span.end - .001) { trimmed += end - span.start; end = span.start; }
            }
            return { ...row, start: round(Math.max(0, start)), end: round(Math.min(horizon, end)), trimmedSeconds: round(trimmed) };
        })
        .filter(row => row.end - row.start > .05);
    if (!plan.length) throw new Error('Speed windows fall outside the retained speech');
    const keep = [];
    for (const span of timeline.keep) {
        let cursor = span.start;
        for (const row of plan) {
            if (row.end <= cursor + .001 || row.start >= span.end - .001) continue;
            const start = Math.max(cursor, row.start), end = Math.min(span.end, row.end);
            if (end - start <= .001) continue;
            if (start - cursor > .001) keep.push({ ...span, start: round(cursor), end: round(start) });
            keep.push({ ...span, start: round(start), end: round(end), speed: round(row.rate), speedReason: row.reason });
            cursor = end;
        }
        if (span.end - cursor > .001) keep.push({ ...span, start: round(cursor), end: round(span.end) });
    }
    // Merge same-rate neighbours that the split created, then prove each requested
    // window was actually retained instead of landing in removed footage.
    const merged = [];
    for (const span of keep) {
        const previous = merged.at(-1);
        if (previous && Math.abs(span.start - previous.end) < .001 && speedOf(span) === speedOf(previous)
            && span.role === previous.role) { previous.end = span.end; continue; }
        merged.push({ ...span });
    }
    for (const row of plan) {
        const covered = merged.filter(span => span.start < row.end - .001 && span.end > row.start + .001)
            .reduce((n, span) => n + Math.min(span.end, row.end) - Math.max(span.start, row.start), 0);
        if (covered < (row.end - row.start) * MIN_SPEED_COVERAGE) {
            throw new Error(`Speed window ${row.start.toFixed(2)}-${row.end.toFixed(2)}s is mostly removed by the story edit; `
                + `only ${covered.toFixed(2)}s of ${(row.end - row.start).toFixed(2)}s is retained`);
        }
    }
    const unprotected = merged.filter(span => speedOf(span) > 1 && protectedRoles.has(span.role));
    if (unprotected.length) throw new Error(`Acceleration would cover a ${unprotected[0].role} span (${unprotected[0].start.toFixed(2)}-${unprotected[0].end.toFixed(2)}s)`);
    assertSpedCuesReadable(merged, cues);
    let offset = 0;
    const speedWindows = [];
    for (const span of merged) {
        const seconds = pieceSeconds(span);
        if (speedOf(span) > 1) speedWindows.push({ start: span.start, end: span.end, rate: speedOf(span),
            outputStart: round(offset), outputDuration: round(seconds), reason: span.speedReason });
        offset += seconds;
    }
    const retained = round(merged.reduce((n, s) => n + s.end - s.start, 0));
    const duration = round(offset);
    const trimmedTotal = round(plan.reduce((n, row) => n + (row.trimmedSeconds || 0), 0));
    const next = { ...timeline, keep: merged, duration, removedSeconds: round(timeline.sourceDuration - retained),
        ...(duration < retained - .001 ? { spedSavedSeconds: round(retained - duration) } : {}),
        ...(trimmedTotal > .001 ? { speedWindowTrimSeconds: trimmedTotal } : {}) };
    if (speedWindows.length) next.speedWindows = speedWindows;
    assertTimeline(next, timeline.sourceDuration);
    return next;
}

function mapTimelineCues(cues, timeline, markBlackout = false) {
    if (timeline.holds?.length) {
        const { reactionOutputTime } = require('../workflow-runtime').loadWorkflow('clipping/enhancement');
        for (const h of timeline.holds) if (cues.some(c => c.start < h.after - .001 && c.end > h.after + .001)) throw new Error('Reaction pause would split speech');
        return cues.filter(c => timeline.keep.some(s => c.start >= s.start - .001 && c.end <= s.end + .001))
            .map(c => ({ ...c, start: reactionOutputTime(c.start, timeline), end: reactionOutputTime(c.end, timeline, 'end') }));
    }
    let offset = 0;
    return timeline.keep.flatMap(span => {
        const speed = speedOf(span), blackout = markBlackout && speed >= CAPTION_BLACKOUT_RATE - 1e-9;
        const rows = cues.filter(c => overlap(c, span)).map(c => ({ ...c,
            start: round(offset + (Math.max(c.start, span.start) - span.start) / speed),
            end: round(offset + (Math.min(c.end, span.end) - span.start) / speed),
            ...(blackout ? { hidden: true } : {}) }));
        offset += pieceSeconds(span);
        return rows;
    });
}

// Captions inside a blacked-out sped span are deliberately kept out of the burned
// subtitle track; the caller can still list them for review.
function burnedCues(cues) { return cues.filter(cue => !cue.hidden); }
function hiddenCues(cues) { return cues.filter(cue => cue.hidden); }

function storyReviewEvidence(cues, timeline, protectedSpans) {
    assertTimeline(timeline, timeline.sourceDuration);
    const kept = mapTimelineCues(cues.map(cue => ({ ...cue, sourceStart: cue.start, sourceEnd: cue.end })), timeline);
    const protectedCoverage = protectedStoryCues(protectedSpans, cues).map(span => ({ ...span,
        retainedCueIds: kept.filter(cue => span.cueIds.includes(cue.id)).map(cue => cue.id),
        covered: timeline.keep.some(range => span.start >= range.start - .002 && span.end <= range.end + .002) }));
    if (protectedCoverage.some(span => !span.covered)) throw new Error('Story review requires complete protected evidence coverage');
    return { timebases: { original: 'source-relative seconds', kept: 'edited-output seconds; sourceStart/sourceEnd refer to original',
        timeline: 'source-relative seconds', protectedCoverage: 'source-relative seconds; coverage verified by code',
        speedWindows: 'source seconds plus the resulting output seconds' },
    original: cues, kept, timeline, protectedCoverage };
}

function sourceTimeForOutput(time, timeline) {
    if (!timeline) return time;
    if (timeline.holds?.length) return require('../workflow-runtime').loadWorkflow('clipping/enhancement').reactionSourceTime(time, timeline);
    let offset = 0;
    for (const span of timeline.keep) {
        const length = pieceSeconds(span), speed = speedOf(span);
        if (time < offset + length + .00001) return Math.min(span.end, span.start + (time - offset) * speed);
        offset += length;
    }
    throw new Error('Output time exceeds editorial timeline');
}

function absoluteEditPlan(timeline, sourceId, window) {
    const keep = timeline.keep.map(s => ({ start: window.start + s.start, end: Math.min(window.end, window.start + s.end) }));
    const removed = []; let cursor = window.start;
    for (const span of keep) { if (span.start > cursor) removed.push({ start: cursor, end: span.start, reason: 'editorial_redundancy' }); cursor = span.end; }
    if (cursor < window.end) removed.push({ start: cursor, end: window.end, reason: 'editorial_redundancy' });
    return { version: 1, mode: 'editorial', sourceId, sourceWindow: { start: window.start, end: window.end }, keep, removed };
}

// atempo accepts 0.5-100 only on recent FFmpeg builds; decomposing into factors of
// at most 2 keeps older runtime paths working without changing the resulting rate.
function atempoFilter(rate) {
    const value = Number(rate);
    if (!(value > 1)) return '';
    const chain = [];
    let rest = value;
    while (rest > 2 + 1e-9) { chain.push(2); rest /= 2; }
    chain.push(round(rest));
    return chain.map(step => `atempo=${step}`).join(',');
}

// A sped span must announce itself: the viewer needs the rate and how long it lasts
// to read fast-forward as an edit rather than as broken playback.
const formatRate = value => { const n = round(value); return String(Number.isInteger(n) ? n : n.toFixed(1)); };
const formatBadgeSeconds = value => {
    const n = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
};

function speedBadges(timeline) {
    const rows = (timeline?.speedWindows || []).map(row => ({ start: round(row.outputStart),
        end: round(row.outputStart + row.outputDuration), rate: Number(row.rate), seconds: round(row.outputDuration) }))
        .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const row of rows) {
        const previous = merged.at(-1);
        if (previous && Math.abs(row.start - previous.end) < .002 && Math.abs(row.rate - previous.rate) < .001) {
            previous.end = row.end; previous.seconds = round(previous.seconds + row.seconds);
            continue;
        }
        merged.push({ ...row });
    }
    return merged.map(row => ({ ...row, text: `${formatRate(row.rate)}× 快进 ${formatBadgeSeconds(row.seconds)}s` }));
}

const CUT_AUDIO_FADE_SECONDS = .08;
function audioPieceFilter(input, start, end, hold = 0, label = 'ta', speed = 1) {
    const sourceDuration = Math.max(0, end - start);
    const speedValue = Number(speed) > 1 ? Number(speed) : 1;
    const outputDuration = sourceDuration / speedValue;
    const fade = Math.min(CUT_AUDIO_FADE_SECONDS, outputDuration / 2);
    const fadeIn = fade > .001 ? `,afade=t=in:st=0:d=${round(fade)}` : '';
    const fadeOut = fade > .001
        ? `,afade=t=out:st=${round(Math.max(0, outputDuration - fade))}:d=${round(fade)}` : '';
    const tempo = atempoFilter(speedValue);
    // atempo does not guarantee its output down to the sample, so each piece is padded
    // and re-trimmed to its declared length. Without this the few-millisecond surplus
    // of every accelerated piece accumulates and drifts the rest of the audio bed.
    const exact = (outputDuration + (hold || 0)).toFixed(6);
    return `[${input}]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS${tempo ? `,${tempo}` : ''}${fadeIn}${fadeOut}`
        + `,apad,atrim=duration=${exact},asetpts=PTS-STARTPTS[${label}]`;
}

function audioTimelineFilter(timeline, origin = 0, input = '0:a:0', output = 'baseaudio') {
    const pieces = timeline.holds?.length ? require('../workflow-runtime').loadWorkflow('clipping/enhancement').reactionPieces(timeline)
        : timeline.keep.map(s => ({ ...s, hold: 0 }));
    const rows = pieces.map((s, i) => audioPieceFilter(input, origin + s.start, origin + s.end, s.hold, `ta${i}`, speedOf(s)));
    rows.push(`${pieces.map((_, i) => `[ta${i}]`).join('')}concat=n=${pieces.length}:v=0:a=1[${output}]`);
    return rows.join(';');
}

/**
 * Operator-decreed ending. When the operator asks for a hard cut ("直接 cut 拼接")
 * instead of speeding up the tail, keep complete cue groups only up to the last cue
 * that starts before the cut point; drop every later span and clip crossing spans.
 * Mutates the draft and returns how many keep spans were dropped.
 */
function truncateStoryKeep(draft, cues, cutAfterSeconds) {
    if (!Number.isFinite(cutAfterSeconds) || !Array.isArray(draft?.keep) || !Array.isArray(cues) || !cues.length) return 0;
    const indexById = new Map(cues.map((row, i) => [row.id, i]));
    const last = cues.reduce((found, row, i) => row.start < cutAfterSeconds - .001 ? i : found, -1);
    if (last < 0) throw new Error('Cut-after point precedes the first subtitle cue');
    const position = span => indexById.get(span.fromCue) ?? -1;
    const before = draft.keep.length;
    draft.keep = draft.keep.filter(span => position(span) >= 0 && position(span) <= last);
    for (const span of draft.keep) {
        if ((indexById.get(span.toCue) ?? -1) > last) {
            span.toCue = cues[last].id;
            span.reason = (span.reason ? span.reason + '；' : '') + '运营指定在此句收尾，其后整段 cut';
        }
    }
    draft.keep.sort((a, b) => position(a) - position(b));
    return before - draft.keep.length;
}

/**
 * Operator "keep the tail verbatim" guarantee (keepTailFrom): from the given
 * window-relative second to the end of the material, every subtitle cue must be
 * retained — one line of speech may not be dropped by the story model. Silence-only
 * gaps between cues stay trimmable (adjacent cue groups naturally leave them out),
 * which is exactly the operator's "删纯空白、台词一句不删" contract. Mutates the
 * draft and returns the number of inserted keep spans.
 */
function forceKeepCueTail(draft, cues, fromSeconds) {
    if (!Number.isFinite(fromSeconds) || fromSeconds <= 0
        || !Array.isArray(draft?.keep) || !Array.isArray(cues) || !cues.length) return 0;
    const indexById = new Map(cues.map((row, i) => [row.id, i]));
    const lo = cues.findIndex(row => row.end > fromSeconds - .001);
    if (lo < 0) return 0;
    const hi = cues.length - 1;
    const covered = draft.keep.flatMap(span => {
        const a = indexById.get(span.fromCue), b = indexById.get(span.toCue);
        return a === undefined || b === undefined || b < a || b < lo ? [] : [[Math.max(a, lo), b]];
    });
    let inserted = 0;
    for (let i = lo; i <= hi;) {
        const cover = covered.find(([a, b]) => i >= a && i <= b);
        if (cover) { i = cover[1] + 1; continue; }
        let j = i;
        while (j + 1 <= hi && !covered.find(([a, b]) => j + 1 >= a && j + 1 <= b)) j += 1;
        draft.keep.push({ fromCue: cues[i].id, toCue: cues[j].id, role: 'context',
            reason: `运营指定 keepTailFrom：本片 ${cues[i].start.toFixed(1)}–${cues[j].end.toFixed(1)}s 的台词一句不删，1x 原速保留` });
        inserted += 1;
        i = j + 1;
    }
    if (inserted) {
        draft.keep.sort((a, b) => (indexById.get(a.fromCue) ?? 0) - (indexById.get(b.fromCue) ?? 0));
    }
    return inserted;
}

module.exports = { protectedStorySpans, protectedStoryCues, storyReviewEvidence, assertTimeline, validateStoryPlan, mapTimelineCues,
    truncateStoryKeep, forceKeepCueTail,
    sourceTimeForOutput, absoluteEditPlan, audioPieceFilter, audioTimelineFilter, applySpeedWindows, assertSpedCuesReadable,
    speedBadges, burnedCues, hiddenCues, atempoFilter,
    SPEED_MIN, SPEED_MAX, MIN_SPED_CUE_SECONDS, CAPTION_BLACKOUT_RATE, speedOf, pieceSeconds, srtText };
