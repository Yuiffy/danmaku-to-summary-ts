'use strict';
const round = n => Math.round(n * 1000) / 1000;
const overlap = (a, b) => a.start < b.end - .0005 && b.start < a.end - .0005;

function protectedStorySpans(clip, evidence, danmaku, window) {
    const ids = new Set((clip.attributionReview?.claims || []).flatMap(row => [...(row.cueIds || []), ...(row.speakerCueIds || [])]));
    for (const id of clip.grounding?.danmakuIds || []) ids.add(id);
    return [...ids].map(id => {
        const cue = evidence.byId.get(id);
        const audience = /^D[1-9]\d*$/.test(id) ? danmaku[Number(id.slice(1)) - 1] : null;
        if (!cue && !audience) throw new Error(`Missing protected story evidence: ${id}`);
        return { id, start: Math.max(0, (cue?.start ?? audience.time) - window.start),
            end: Math.min(window.end - window.start, (cue?.end ?? audience.time + .05) - window.start), text: cue?.text ?? audience.text };
    });
}

function assertTimeline(timeline, sourceDuration) {
    if (timeline?.version !== 1 || Math.abs(timeline.sourceDuration - sourceDuration) > .001
        || !Array.isArray(timeline.keep) || !timeline.keep.length || timeline.keep.length > 32) throw new Error('Invalid editorial timeline');
    let duration = 0;
    for (const [i, span] of timeline.keep.entries()) {
        if (![span.start, span.end].every(Number.isFinite) || span.start < 0 || span.end > sourceDuration + .001
            || span.end <= span.start || (i && span.start < timeline.keep[i - 1].end - .001)) throw new Error('Editorial spans overlap, reorder, or exceed source');
        duration += span.end - span.start;
    }
    if (Math.abs(duration - timeline.duration) > .002) throw new Error('Editorial duration does not match retained spans');
}

function validateStoryPlan(raw, cues, sourceDuration, protectedSpans = [], profile = null) {
    if (!Array.isArray(raw?.keep) || !raw.keep.length || raw.keep.length > 32) throw new Error('Missing story keep ranges');
    let lastCue = -1;
    const keep = raw.keep.map(row => {
        const a = cues.findIndex(c => c.id === row.fromCue), b = cues.findIndex(c => c.id === row.toCue);
        if (a < 0 || b < a || !String(row.reason || '').trim()
            || !['setup', 'escalation', 'reaction', 'payoff', 'context', 'step', 'explanation', 'performance', 'closing'].includes(row.role)) throw new Error('Story ranges require ordered real cue IDs, reason and role');
        if (a <= lastCue) throw new Error(`Keep ranges must be chronological and disjoint: ${row.fromCue} repeats or precedes C${lastCue + 1}`);
        lastCue = b;
        // Only complete approved subtitle cues; adjacent boundaries never split another cue.
        const start = Math.max(0, cues[a].start - .12, a ? cues[a - 1].end : 0);
        const end = Math.min(sourceDuration, cues[b].end + .22, cues[b + 1]?.start ?? sourceDuration);
        return { start: round(start), end: Math.min(sourceDuration, round(end)), reason: row.reason, role: row.role, firstCue: a, lastCue: b };
    });
    if (keep.some((s, i) => i && s.start < keep[i - 1].end - .001 && s.firstCue !== keep[i - 1].lastCue + 1)) {
        throw new Error('Keep ranges overlap across omitted speech');
    }
    const merged = [];
    // Adjacent retained cue groups can share padding in a short pause. Union it once.
    for (const { firstCue, lastCue, ...span } of keep) {
        const previous = merged.at(-1);
        if (previous && span.start - previous.end < .06) { previous.end = Math.max(previous.end, span.end); previous.reason += `；${span.reason}`; }
        else merged.push({ ...span });
    }
    for (const cue of cues) if (merged.some(span => overlap(cue, span))
        && !merged.some(span => cue.start >= span.start - .001 && cue.end <= span.end + .001)) throw new Error(`Cut would truncate speech ${cue.id}`);
    const missing = protectedSpans.filter(cue => !merged.some(s => cue.start >= s.start - .002 && cue.end <= s.end + .002));
    if (missing.length) throw new Error(`Retain public-copy evidence: ${missing.map(c => `${c.id} ${c.start.toFixed(3)}-${c.end.toFixed(3)}`).join(', ')}`);
    if (profile?.preserveContinuity && merged.length !== 1) throw new Error('This performance/continuous passage must not be internally spliced');
    if (!profile && (!keep.some(s => s.role === 'setup') || !keep.some(s => s.role === 'payoff'))) throw new Error('Story needs setup and payoff');
    const duration = round(merged.reduce((n, s) => n + s.end - s.start, 0));
    if (!profile && sourceDuration > 60 && duration > sourceDuration * .75) throw new Error('Compact edit still retains over 75% of the source; remove redundant complete exchanges');
    const timeline = { version: 1, sourceDuration, duration, keep: merged, removedSeconds: round(sourceDuration - duration) };
    assertTimeline(timeline, sourceDuration);
    return timeline;
}

function mapTimelineCues(cues, timeline) {
    let offset = 0;
    return timeline.keep.flatMap(span => {
        const rows = cues.filter(c => overlap(c, span)).map(c => ({ ...c,
            start: round(offset + Math.max(c.start, span.start) - span.start),
            end: round(offset + Math.min(c.end, span.end) - span.start) }));
        offset += span.end - span.start;
        return rows;
    });
}

function sourceTimeForOutput(time, timeline) {
    if (!timeline) return time;
    let offset = 0;
    for (const span of timeline.keep) {
        const length = span.end - span.start;
        if (time < offset + length + .00001) return Math.min(span.end, span.start + time - offset);
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

function audioTimelineFilter(timeline, origin = 0, input = '0:a:0', output = 'baseaudio') {
    const rows = timeline.keep.map((s, i) => `[${input}]atrim=start=${origin + s.start}:end=${origin + s.end},asetpts=PTS-STARTPTS[ta${i}]`);
    rows.push(`${timeline.keep.map((_, i) => `[ta${i}]`).join('')}concat=n=${timeline.keep.length}:v=0:a=1[${output}]`);
    return rows.join(';');
}

function srtText(cues) {
    const clock = time => { const n = Math.round(time * 1000); return `${String(Math.floor(n / 3600000)).padStart(2, '0')}:${String(Math.floor(n / 60000) % 60).padStart(2, '0')}:${String(Math.floor(n / 1000) % 60).padStart(2, '0')},${String(n % 1000).padStart(3, '0')}`; };
    return cues.map((c, i) => `${i + 1}\n${clock(c.start)} --> ${clock(c.end)}\n${c.text}\n`).join('\n');
}
module.exports = { protectedStorySpans, assertTimeline, validateStoryPlan, mapTimelineCues, sourceTimeForOutput, absoluteEditPlan, audioTimelineFilter, srtText };
