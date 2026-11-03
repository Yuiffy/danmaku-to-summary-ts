'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { extractEvidence } = require('./stream_game_evidence');
const { runFfmpeg } = require('./media_runtime');

/**
 * The text detector claims which spans of the recording are gameplay; the visual
 * timeline decides what is actually kept. A misidentified game or an over-eager
 * `other` verdict does not raise an error — it only yields a shorter episode. When
 * a long claimed span is partly kept and partly thrown away, the thrown-away part
 * is the silent loss this guard reports, with one frame from each dropped stretch
 * so a single glance decides accept or repair.
 *
 * Fully dropped claims are a different decision: boundary review already has to
 * justify them, so they are reported but never raised as a loss.
 */
const MIN_CLAIM_SECONDS = 1800;
const MIN_KEPT_RATIO = 0.05;
const MAX_KEPT_RATIO = 0.85;

function mergeSpans(spans) {
    const sorted = spans.filter(span => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start)
        .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const span of sorted) {
        const last = merged.at(-1);
        if (last && span.start <= last.end + 1) { last.end = Math.max(last.end, span.end); last.members.push(span); }
        else merged.push({ start: span.start, end: span.end, members: [span] });
    }
    return merged;
}

function overlap(a, b) { return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)); }

function keptSpans(timeline) {
    const samples = timeline?.samples || [];
    return (timeline?.ranges || []).filter(range => range.kind === 'gameplay').map(range => {
        const first = samples[range.first - 1], last = samples[range.last - 1];
        return first && last ? { start: first.time, end: last.time } : null;
    }).filter(Boolean);
}

function droppedParts(window, kept) {
    const parts = [];
    let cursor = window.start;
    for (const span of [...kept].sort((a, b) => a.start - b.start)) {
        if (span.end <= cursor || span.start >= window.end) continue;
        if (span.start > cursor) parts.push({ start: cursor, end: Math.min(span.start, window.end) });
        cursor = Math.max(cursor, span.end);
        if (cursor >= window.end) break;
    }
    if (cursor < window.end) parts.push({ start: cursor, end: window.end });
    return parts.filter(part => part.end - part.start > 1);
}

/** Compare the detector's claims against what the visual timeline actually keeps. */
function coverageReport(plan, timeline, options = {}) {
    const minDroppedSeconds = Number.isFinite(options.minDroppedSeconds) ? options.minDroppedSeconds : 1200;
    const ratio = Number.isFinite(options.ratio) ? options.ratio : 0.15;
    const events = (plan.rawEvents?.length ? plan.rawEvents : plan.events) || [];
    const claims = mergeSpans(events.map(event => ({ start: event.start, end: event.end, id: event.id, gameId: event.gameId })));
    const kept = keptSpans(timeline);
    const notes = (timeline?.ranges || []).map(range => ({ time: timeline.samples?.[range.first - 1]?.time, note: range.note }));
    let claimSeconds = 0, keptSeconds = 0;
    const windows = [], untouched = [];
    for (const claim of claims) {
        const covered = kept.reduce((sum, row) => sum + overlap(claim, row), 0);
        const seconds = claim.end - claim.start, keptRatio = seconds ? covered / seconds : 0;
        const row = { start: claim.start, end: claim.end, seconds, keptSeconds: covered, droppedSeconds: seconds - covered, keptRatio,
            gameIds: [...new Set(claim.members.map(member => member.gameId).filter(Boolean))],
            eventIds: claim.members.map(member => member.id).filter(Boolean),
            notes: [...new Set(notes.filter(note => note.time >= claim.start && note.time <= claim.end).map(note => note.note))].slice(0, 6),
            droppedParts: droppedParts(claim, kept) };
        if (seconds < MIN_CLAIM_SECONDS || keptRatio < MIN_KEPT_RATIO || keptRatio > MAX_KEPT_RATIO) { untouched.push(row); continue; }
        claimSeconds += seconds; keptSeconds += covered; windows.push(row);
    }
    const droppedSeconds = claimSeconds - keptSeconds;
    const threshold = Math.max(minDroppedSeconds, claimSeconds * ratio);
    const alert = droppedSeconds >= threshold && droppedSeconds > 0;
    // Report every claim so the JSON still explains the detector's whole view.
    return { version: 2, sessionId: plan.sessionId, source: plan.source?.mediaPath, claimSeconds, keptSeconds, droppedSeconds,
        droppedRatio: claimSeconds ? droppedSeconds / claimSeconds : 0, thresholdSeconds: threshold, alert, windows,
        untouched: untouched.map(({ droppedParts: _parts, ...row }) => row) };
}

function clock(seconds) {
    const n = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

/** Three frames per dropped stretch, so "chat between games" is distinguishable from lost gameplay. */
async function writeCoverageSheet(plan, report, options, files) {
    const windows = [...report.windows].sort((a, b) => b.droppedSeconds - a.droppedSeconds).slice(0, 8);
    const shots = [];
    for (const window of windows) {
        const parts = [...(window.droppedParts || [])].sort((a, b) => (b.end - b.start) - (a.end - a.start));
        const part = parts[0];
        if (!part || part.end - part.start < 30) continue;
        for (const fraction of [.15, .5, .85]) {
            const time = Math.max(0, Math.min(plan.duration - .1, part.start + (part.end - part.start) * fraction));
            shots.push({ time, part });
        }
    }
    if (!shots.length) return null;
    const directory = path.join(files.directory, 'temp', 'game-coverage', String(report.sessionId || report.source || 'session').slice(0, 16));
    fs.mkdirSync(directory, { recursive: true });
    const run = options.extract || runFfmpeg;
    for (const [i, shot] of shots.entries()) {
        shot.path = path.join(directory, `frame-${i + 1}.jpg`);
        await extractEvidence(run, ['-y', '-ss', String(shot.time), '-i', options.mediaPath, '-frames:v', '1',
            '-vf', 'scale=480:270', '-q:v', '4', shot.path],
        { ffmpegPath: options.config?.audio?.ffmpeg?.path || 'ffmpeg', threads: 1, stage: '游戏切剔除片段核对',
            timeoutMs: 60000, sourceIdentity: plan.source });
    }
    const columns = 3, rows = Math.ceil(shots.length / columns), cell = { width: 480, height: 298 };
    const composite = [];
    for (const [i, shot] of shots.entries()) {
        const left = (i % columns) * cell.width, top = Math.floor(i / columns) * cell.height;
        composite.push({ input: shot.path, left, top: top + 28 });
        const label = Buffer.from(`<svg width="480" height="28"><rect width="480" height="28" fill="#101010"/>`
            + `<text x="8" y="21" fill="#ffb4b4" font-size="18">${clock(shot.time)} 剔除段 ${Math.round((shot.part.end - shot.part.start) / 60)}min</text></svg>`);
        composite.push({ input: label, left, top });
    }
    const output = path.join(files.directory, 'COVERAGE_SHEET.jpg');
    await sharp({ create: { width: columns * cell.width, height: rows * cell.height, channels: 3, background: '#101010' } })
        .composite(composite).jpeg({ quality: 82 }).toFile(output);
    return output;
}

async function guardCoverage({ plan, timeline, options = {}, config = {}, files }) {
    const visual = config.visual || {};
    const mode = visual.coverageGuard || 'warn';
    if (mode === 'off') return null;
    const report = coverageReport(plan, timeline, {
        minDroppedSeconds: (Number(visual.coverageMinDroppedMinutes) || 20) * 60,
        ratio: Number.isFinite(visual.coverageDroppedRatio) ? visual.coverageDroppedRatio : 0.15 });
    const file = path.join(files.directory, 'COVERAGE.json');
    writeJsonAtomic(file, report);
    if (!report.alert) return report;
    let sheet = null;
    try { sheet = await writeCoverageSheet(plan, report, options, files); }
    catch (error) { console.warn(`[GAME_COVERAGE_SHEET] ${plan.recordedAt || ''} ${error.message}`); }
    const message = `文字检测认定的一段游戏时段只保留了 ${Math.round(report.keptSeconds / 60)}/${Math.round(report.claimSeconds / 60)} 分钟`
        + `，丢弃 ${Math.round(report.droppedSeconds / 60)} 分钟`;
    console.warn(`[GAME_COVERAGE_ALERT] ${plan.recordedAt || ''} ${message}；明细 ${file}${sheet ? `，抽帧 ${sheet}` : ''}`);
    writeJsonAtomic(file, { ...report, sheet });
    if (mode === 'fail') {
        const error = new Error(`${message}; source preserved, review COVERAGE.json before rendering`);
        error.coverage = { ...report, sheet };
        throw error;
    }
    return { ...report, sheet };
}

module.exports = { coverageReport, guardCoverage, writeCoverageSheet, mergeSpans, droppedParts };
