'use strict';

/**
 * Episode titles should follow what the audience actually reacted to, not a fixed
 * "two bosses and one area" quota. A session can contain three boss fights that all
 * matter; a quiet one can contain three areas and no boss at all.
 *
 * The signals are already on disk for every recording:
 *   - the BililiveRecorder XML (danmaku, plus <sc>/<gift>/<guard> when recorded)
 *   - the merged SRT (what the streamer says; boss names surface here first)
 *   - an optional gift/SC sidecar for recorders that write one separately
 * Nothing here calls a model: density, mentions and gifts are cheap deterministic
 * counts, so a title can be explained and reproduced.
 */
const fs = require('fs');
const path = require('path');

const DANMAKU_RE = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/gu;
const PAID_EVENT_RE = /<(sc|gift|guard)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gu;
const ATTRIBUTE_RE = /([\w:-]+)\s*=\s*"([^"]*)"/gu;
const PEAK_WINDOW_SECONDS = 60;

function decodeXml(value) {
    return String(value || '')
        .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/gu, (_, dec) => String.fromCodePoint(Number(dec)))
        .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
        .replace(/&apos;/gu, "'").replace(/&amp;/gu, '&');
}

function attributes(text) {
    const values = {};
    for (const match of String(text || '').matchAll(ATTRIBUTE_RE)) values[match[1]] = decodeXml(match[2]);
    return values;
}

/** Synchronous on purpose: title building happens inside a sync copy step. */
function parseDanmaku(xmlPath, options = {}) {
    if (!xmlPath || !fs.existsSync(xmlPath)) return [];
    if (options.maxBytes && fs.statSync(xmlPath).size > options.maxBytes) return [];
    const rows = [];
    DANMAKU_RE.lastIndex = 0;
    for (const match of fs.readFileSync(xmlPath, 'utf8').matchAll(DANMAKU_RE)) {
        const time = Number(String(match[1]).split(',')[0]);
        const text = decodeXml(match[2]).trim();
        if (Number.isFinite(time) && time >= 0 && text) rows.push({ time, text });
    }
    return rows.sort((a, b) => a.time - b.time);
}

/**
 * SuperChats and gifts, when the recorder wrote them. Their `ts` is absolute Unix
 * time while danmaku `p` is relative, so the first danmaku's own Unix stamp anchors
 * the mapping; without that anchor the events are skipped rather than misplaced.
 */
function parsePaidEvents(xmlPath, options = {}) {
    if (!xmlPath || !fs.existsSync(xmlPath)) return [];
    const text = fs.readFileSync(xmlPath, 'utf8');
    const first = DANMAKU_RE.exec(text);
    DANMAKU_RE.lastIndex = 0;
    if (!first) return [];
    const stamp = Number(String(first[1]).split(',')[4]);
    if (!Number.isFinite(stamp) || stamp <= 0) return [];
    const offsetMs = stamp - Number(String(first[1]).split(',')[0]) * 1000;
    const toMs = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : NaN; };
    const rows = [];
    for (const match of text.matchAll(PAID_EVENT_RE)) {
        const attrs = attributes(match[2]);
        const at = toMs(attrs.ts);
        if (!Number.isFinite(at)) continue;
        const time = (at - offsetMs) / 1000;
        if (!Number.isFinite(time) || time < 0) continue;
        const price = Number(attrs.price || 0);
        rows.push({ time, price: Number.isFinite(price) ? price : 0, count: Number(attrs.giftcount || 1) || 1,
            kind: match[1], name: String(attrs.giftname || attrs.user || '') });
    }
    return rows.sort((a, b) => a.time - b.time).filter(row => row.time <= (options.maxSeconds || Infinity));
}

const SRT_TIME = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/u;
const srtSeconds = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;

function parseSrt(srtPath) {
    if (!srtPath || !fs.existsSync(srtPath)) return [];
    const rows = [], blocks = fs.readFileSync(srtPath, 'utf8').split(/\r?\n\r?\n/u);
    for (const block of blocks) {
        const lines = block.split(/\r?\n/u);
        const timingIndex = lines.findIndex(line => SRT_TIME.test(line));
        if (timingIndex < 0) continue;
        const match = SRT_TIME.exec(lines[timingIndex]);
        const text = lines.slice(timingIndex + 1).join(' ').trim();
        if (!text) continue;
        rows.push({ start: srtSeconds(match[1], match[2], match[3], match[4]),
            end: srtSeconds(match[5], match[6], match[7], match[8]), text });
    }
    return rows.sort((a, b) => a.start - b.start);
}

/** Gift sidecars are optional and recorder specific; every shape degrades to []. */
function parseGifts(candidates = []) {
    for (const file of candidates.filter(Boolean)) {
        if (!fs.existsSync(file)) continue;
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            const rows = Array.isArray(raw) ? raw : (raw.gifts || raw.items || raw.list || []);
            const gifts = rows.map(row => ({
                time: Number(row.time ?? row.ts ?? row.timestamp ?? row.start),
                price: Number(row.price ?? row.value ?? row.total ?? row.amount ?? 0),
                name: String(row.name ?? row.giftName ?? row.text ?? '')
            })).filter(row => Number.isFinite(row.time) && row.time >= 0);
            if (gifts.length) return gifts.sort((a, b) => a.time - b.time);
        } catch { /* a malformed sidecar must never block a title */ }
    }
    return [];
}

function giftCandidates(source = {}) {
    if (source.giftPath) return [source.giftPath];
    const base = String(source.xmlPath || source.srtPath || source.mediaPath || '');
    if (!base) return [];
    const stem = base.replace(/\.[^.]+$/u, '');
    return [`${stem}.gifts.json`, `${stem}.gift.json`, `${stem}_gift.json`];
}

/** A recording's audience data, loaded once per XML path. */
function loadAudience(source = {}) {
    const key = `${source.xmlPath || ''}|${source.srtPath || ''}`;
    const cached = loadAudience.cache.get(key);
    if (cached) return cached;
    const danmaku = parseDanmaku(source.xmlPath);
    const subtitles = parseSrt(source.srtPath);
    // SC/礼物 live inside the recorder XML when enabled; a sidecar is the fallback.
    const inXml = parsePaidEvents(source.xmlPath);
    const gifts = inXml.length ? inXml : parseGifts(giftCandidates(source));
    const audience = { danmaku, subtitles, gifts,
        duration: Math.max(0, ...danmaku.map(row => row.time), ...subtitles.map(row => row.end)),
        available: { danmaku: danmaku.length > 0, subtitles: subtitles.length > 0, gifts: gifts.length > 0 } };
    audience.baseline = baselineFor(audience);
    loadAudience.cache.set(key, audience);
    return audience;
}
loadAudience.cache = new Map();

/** Whole-session density, used as the "quiet" reference for every chapter. */
function baselineFor(audience) {
    const minutes = audience.duration / 60;
    const perMinute = minutes > 0 ? audience.danmaku.length / minutes : 0;
    const peaks = audience.danmaku.length ? windowPeaks(audience.danmaku, PEAK_WINDOW_SECONDS).map(row => row.count) : [];
    const sorted = [...peaks].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    return { perMinute, peakMedian: Math.max(median, 1), peakP90: sorted.length ? sorted[Math.floor(sorted.length * .9)] : 1 };
}

/** Rolling count over fixed windows; exported for tests. */
function windowPeaks(rows, windowSeconds) {
    if (!rows.length) return [];
    const buckets = [];
    let index = 0;
    for (let start = 0; start <= rows.at(-1).time; start += windowSeconds) {
        while (index < rows.length && rows[index].time < start) index++;
        let count = 0;
        while (index + count < rows.length && rows[index + count].time < start + windowSeconds) count++;
        buckets.push({ start, count });
    }
    return buckets;
}

function rowsIn(rows, start, end, timeOf = row => row.time) {
    // Binary search the first row at or after start, then walk until end.
    let low = 0, high = rows.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (timeOf(rows[mid]) < start) low = mid + 1; else high = mid;
    }
    const found = [];
    for (let i = low; i < rows.length && timeOf(rows[i]) <= end; i++) found.push(rows[i]);
    return found;
}

/**
 * Audience descriptors for one interval. `mentions` only counts rows that name the
 * entity, so a loud chat talking about something else does not inflate a boss.
 * `names` accepts any spelling of the same entity (阿花 / 新娘阿花), because chat
 * usually types the short form.
 */
function windowStats(audience, start, end, names = []) {
    const minutes = Math.max(1 / 60, (end - start) / 60);
    const comments = rowsIn(audience.danmaku, start, end);
    const subtitles = rowsIn(audience.subtitles, start, end, row => row.start);
    const gifts = rowsIn(audience.gifts, start, end);
    const peak = comments.length ? Math.max(...windowPeaks(comments, PEAK_WINDOW_SECONDS).map(row => row.count)) : 0;
    const keys = (Array.isArray(names) ? names : [names])
        .map(value => String(value || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase())
        .filter(key => [...key].length >= 2);
    const mentions = rows => keys.length
        ? rows.filter(row => { const text = row.text.toLowerCase(); return keys.some(key => text.includes(key)); }).length
        : 0;
    return { minutes, comments: comments.length, perMinute: comments.length / minutes, peak,
        named: mentions(comments), spoken: mentions(subtitles), gifts: gifts.length,
        giftValue: gifts.reduce((total, row) => total + (row.price || 0), 0),
        giftCount: gifts.reduce((total, row) => total + (row.count || 0), 0) };
}

module.exports = { loadAudience, parseDanmaku, parsePaidEvents, parseSrt, parseGifts, giftCandidates, windowPeaks, windowStats,
    baselineFor, decodeXml, PEAK_WINDOW_SECONDS };
