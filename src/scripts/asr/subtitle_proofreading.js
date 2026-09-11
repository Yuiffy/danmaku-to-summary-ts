'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xml2js = require('xml2js');
const lexicon = require('./subtitle_lexicon.json');

const compact = text => String(text || '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function resolveProofreadingOptions(config = {}, context = {}) {
    const settings = config.asr?.subtitleProofreading || {};
    const roomId = String(context.room_id || context.roomId || '');
    return { ...settings, roomId, enabled: settings.enabled === true
        && Array.isArray(settings.roomIds) && settings.roomIds.map(String).includes(roomId)
        && Boolean(lexicon.profiles[roomId]),
    contextSeconds: Math.max(0, Math.min(30, Number(settings.contextSeconds ?? 20))),
    maxContextChars: Math.max(32, Math.min(1000, Number(settings.maxContextChars ?? 400))) };
}

async function readSuperChats(xmlPath) {
    if (!xmlPath || !fs.existsSync(xmlPath)) return { status: 'missing', messages: [] };
    try {
        const content = fs.readFileSync(xmlPath, 'utf8');
        const root = await new xml2js.Parser({ explicitArray: true, strict: true, trim: true }).parseStringPromise(content);
        const rows = root?.i?.sc || root?.I?.SC || [];
        const messages = rows.flatMap((row, index) => {
            const attrs = row.$ || {};
            const time = Number(attrs.ts ?? attrs.TS);
            const text = String(row._ || '').trim();
            return Number.isFinite(time) && time >= 0 && text && text.length <= 4000
                ? [{ id: `SC${index + 1}`, time, text }] : [];
        });
        return { status: 'available', path: path.resolve(xmlPath), sha256: hash(content), messages };
    } catch (error) {
        return { status: 'invalid', error: error.message, messages: [] };
    }
}

async function loadProofreadingContext(config, context = {}, mediaPath = '') {
    const settings = resolveProofreadingOptions(config, context);
    if (!settings.enabled) return settings;
    const sibling = mediaPath ? path.join(path.dirname(mediaPath), `${path.basename(mediaPath, path.extname(mediaPath))}.xml`) : '';
    const superchat = await readSuperChats(context.xmlPath || context.xml_path || sibling);
    if (superchat.status === 'invalid') console.warn(`[Subtitle proofreading] SC evidence unavailable: ${superchat.error}`);
    return { ...settings, superchat };
}

function localContext(segments, texts, index, seconds, maxChars) {
    const current = segments[index];
    let left = index;
    let right = index;
    while (left > 0 && current.start - segments[left - 1].end <= seconds && current.start >= segments[left - 1].start) left--;
    while (right + 1 < segments.length && segments[right + 1].start - current.end <= seconds && segments[right + 1].end >= current.end) right++;
    return { text: texts.slice(left, index).join('').slice(-maxChars) + texts[index]
        + texts.slice(index + 1, right + 1).join('').slice(0, maxChars), left, right };
}

function applies(rule, segments, texts, index, options) {
    const current = texts[index];
    if (!current.includes(rule.from)) return false;
    const context = localContext(segments, texts, index, rule.contextSeconds ?? options.contextSeconds ?? 20,
        options.maxContextChars ?? 400).text;
    if (rule.exclude?.some(word => context.includes(word))) return false;
    if (rule.nearby?.length && !rule.nearby.some(word => context.includes(word))) return false;
    return true;
}

function replaceLiteral(text, rule) {
    let result = '';
    let offset = 0;
    let found;
    while ((found = text.indexOf(rule.from, offset)) >= 0) {
        const end = found + rule.from.length;
        const embedded = rule.latinBoundary && (/[A-Za-z0-9_]/.test(text[found - 1] || '') || /[A-Za-z0-9_]/.test(text[end] || ''));
        result += text.slice(offset, found) + (embedded ? rule.from : rule.to);
        offset = end;
    }
    return result + text.slice(offset);
}

function superchatMatch(rule, segments, texts, index, messages, requireBothAnchors = true) {
    const local = localContext(segments, texts, index, 8, 120);
    const before = compact(texts.slice(local.left, index).join(''));
    const current = compact(texts[index]);
    const after = compact(texts.slice(index + 1, local.right + 1).join(''));
    const original = compact(rule.from);
    const replacement = compact(rule.to);
    const offset = current.indexOf(original);
    if (offset < 0 || current.indexOf(original, offset + 1) >= 0) return null;
    const left = (before + current.slice(0, offset)).slice(-12);
    const right = (current.slice(offset + original.length) + after).slice(0, 12);
    if (requireBothAnchors ? left.length < 4 || right.length < 4 : left.length < 4 && right.length < 4) return null;
    const matches = [];
    let originalSupported = false;
    for (const message of messages) {
        if (message.time > segments[index].start || segments[index].start - message.time > 90) continue;
        const reference = compact(message.text);
        let matched = false;
        for (let l = left.length; l >= (requireBothAnchors ? 4 : 0) && !matched; l--) {
            for (let r = right.length; r >= (requireBothAnchors ? 4 : 0) && !matched; r--) {
                if (l < 4 && r < 4) continue;
                const prefix = left.slice(-l);
                const suffix = right.slice(0, r);
                const target = prefix + replacement + suffix;
                const at = reference.indexOf(target);
                if (reference.includes(prefix + original + suffix)) originalSupported = true;
                if (at >= 0 && reference.indexOf(target, at + 1) < 0 && !reference.includes(prefix + original + suffix)) matched = true;
            }
        }
        if (matched) matches.push(message);
    }
    return matches.length === 1 && !originalSupported ? matches[0] : null;
}

function analyzeSubtitleRisks(segments, texts, profile = {}) {
    const checks = [];
    texts.forEach((text, index) => {
        // Long glued Latin output is a routing hint, not proof of a spoken language.
        const cleaned = text.replace(/https?:\/\/\S+|\S+@\S+/g, '');
        if (/[A-Za-z]{18,}/.test(cleaned)) checks.push({ cue: index + 1, start: segments[index].start, end: segments[index].end,
            type: 'possible_foreign_audio', text, action: 'local_multilingual_asr_check' });
        for (const rule of profile.reviewOnly || []) {
            if (applies(rule, segments, texts, index, {}) && replaceLiteral(text, { ...rule, to: '' }) !== text) {
                checks.push({ cue: index + 1, start: segments[index].start, end: segments[index].end,
                    type: 'ambiguous_term', text, original: rule.from, suggestion: rule.suggestion, ruleId: rule.id, action: 'confirm_once_per_term' });
            }
        }
    });
    return checks;
}

function proofreadSubtitleTexts(segments, initialTexts, options = {}) {
    const texts = initialTexts.slice();
    const profile = options.enabled === true ? lexicon.profiles[String(options.roomId)] : null;
    if (!profile) return { texts, edits: [], checks: [], enabled: false };
    const edits = [];
    const candidates = [];
    const scChecks = [];
    segments.forEach((segment, index) => {
        if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start) return;
        for (const rule of profile.rules) {
            if (!applies(rule, segments, initialTexts, index, options)) continue;
            candidates.push({ index, rule, method: 'curated_context' });
        }
        for (const rule of profile.superchatAliases) {
            if (!initialTexts[index].includes(rule.from)) continue;
            const message = superchatMatch(rule, segments, initialTexts, index, options.superchat?.messages || []);
            if (message) candidates.push({ index, rule, method: 'superchat_anchors',
                evidence: { id: message.id, time: message.time, text: message.text, xmlSha256: options.superchat?.sha256 } });
            else {
                const possible = superchatMatch(rule, segments, initialTexts, index, options.superchat?.messages || [], false);
                if (possible) scChecks.push({ cue: index + 1, start: segment.start, end: segment.end,
                    type: 'superchat_reading', text: initialTexts[index], original: rule.from, suggestion: rule.to,
                    reference: possible.text, evidence: { id: possible.id, time: possible.time, xmlSha256: options.superchat?.sha256 },
                    action: 'compare_spoken_reading_with_sc' });
            }
        }
    });
    // All support is read from the unchanged input, never another rule's output.
    for (const candidate of candidates) {
        const { index, rule } = candidate;
        const original = texts[index];
        const revised = replaceLiteral(original, rule);
        if (revised === original) continue;
        texts[index] = revised;
        edits.push({ cue: index + 1, start: segments[index].start, end: segments[index].end, ruleId: rule.id,
            from: rule.from, to: rule.to, before: original, after: revised, method: candidate.method,
            ...(candidate.evidence ? { evidence: candidate.evidence } : {}) });
    }
    return { enabled: true, texts, edits, checks: [...analyzeSubtitleRisks(segments, texts, profile), ...scChecks] };
}

function groupSubtitleChecks(checks, window = { start: 0, end: Infinity }) {
    const groups = new Map();
    for (const check of checks) {
        if (check.end <= window.start || check.start >= window.end) continue;
        const key = check.type === 'ambiguous_term' ? `${check.type}:${check.original}:${check.suggestion}`
            : check.type === 'superchat_reading' ? `${check.type}:${check.evidence?.id}` : check.type;
        if (!groups.has(key)) groups.set(key, { type: check.type, original: check.original, suggestion: check.suggestion,
            ...(check.reference ? { reference: check.reference, evidence: check.evidence } : {}), occurrences: [] });
        groups.get(key).occurrences.push({ start: check.start, end: check.end, cue: check.cue, text: check.text });
    }
    return [...groups.values()].map(group => {
        const windows = [];
        for (const occurrence of group.occurrences.slice().sort((a, b) => a.start - b.start)) {
            let start = Math.max(window.start, occurrence.start - 2);
            const end = Math.min(window.end, occurrence.end + 2);
            while (start < end) {
                const partEnd = Math.min(end, start + 30);
                const last = windows.at(-1);
                if (last && start <= last.end && partEnd - last.start <= 30) last.end = Math.max(last.end, partEnd);
                else windows.push({ start, end: partEnd });
                start = partEnd;
            }
        }
        return { ...group, windows };
    });
}

function summarizeSubtitleProofreading(segments, window) {
    const rows = segments.filter(segment => segment.end > window.start && segment.start < window.end);
    const edits = rows.flatMap(segment => segment.asrEvidence?.proofreading?.edits || []);
    const checks = rows.flatMap(segment => segment.asrEvidence?.proofreading?.checks || []);
    const fallback = analyzeSubtitleRisks(rows, rows.map(segment => segment.text));
    const unique = [...checks, ...fallback].filter((check, index, all) => all.findIndex(other =>
        other.type === check.type && other.start === check.start && other.end === check.end && other.original === check.original) === index);
    return { version: 1, automaticEdits: edits, reviewGroups: groupSubtitleChecks(unique, window), advisory: true };
}

module.exports = { resolveProofreadingOptions, readSuperChats, loadProofreadingContext, proofreadSubtitleTexts,
    analyzeSubtitleRisks, groupSubtitleChecks, summarizeSubtitleProofreading };
