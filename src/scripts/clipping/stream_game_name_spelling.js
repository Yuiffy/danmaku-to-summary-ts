'use strict';

/**
 * The original-frame reviewer reads a health bar literally, but a vision model can
 * still misread a near-identical glyph: 2026-11-01 produced "斧光大：彭猛" for a bar
 * that actually says "斧老大：彭猛". The recording itself settles it — chat typed
 * 斧老大 thirteen times and 斧光大 never. So a name read off a frame is checked
 * against how the audience writes it: same length, one character apart, and the
 * audience spelling must clearly dominate. Nothing else about the name is invented.
 *
 * The same pass drops a subtitle half the chat never uses: a bar labelled
 * "斧老大：彭猛" is published as 斧老大 when chat only ever says 斧老大.
 */

// Below three observations a spelling is a typo or noise, not a consensus.
const MIN_OBSERVED = 3;
// The audience spelling has to beat the frame reading by this factor.
const MIN_DOMINANCE = 3;
// A two-character name has one shared character left after a one-glyph difference,
// which is too little to call a misreading.
const MIN_FRAGMENT = 3;
const MAX_FRAGMENT = 8;
// "斧老大：彭猛" — the bar joins a title and a personal name.
const CJK = /^[\u3400-\u9fff]+$/u;

const chars = value => [...String(value || '')];

/** Character n-gram counts over danmaku plus subtitles, built lazily per length. */
function createCorpus(audience) {
    const texts = [...(audience?.danmaku || []).map(row => row.text),
        ...(audience?.subtitles || []).map(row => row.text)].filter(Boolean);
    const buckets = new Map();
    const bucketFor = length => {
        if (buckets.has(length)) return buckets.get(length);
        const bucket = new Map();
        for (const text of texts) {
            const characters = chars(text);
            for (let i = 0; i + length <= characters.length; i++) {
                const gram = characters.slice(i, i + length).join('');
                bucket.set(gram, (bucket.get(gram) || 0) + 1);
            }
        }
        buckets.set(length, bucket);
        return bucket;
    };
    return {
        texts,
        count(word) {
            const length = chars(word).length;
            if (length < 2 || length > MAX_FRAGMENT) return 0;
            return bucketFor(length).get(word) || 0;
        },
        /** Same-length spellings differing in exactly one character, most frequent first. */
        neighbours(word) {
            const length = chars(word).length;
            if (length < MIN_FRAGMENT || length > MAX_FRAGMENT) return [];
            const target = chars(word), found = [];
            for (const [gram, count] of bucketFor(length)) {
                if (gram === word || !CJK.test(gram)) continue;
                const candidate = chars(gram);
                let diff = 0;
                for (let i = 0; i < length; i++) if (candidate[i] !== target[i]) { if (++diff > 1) break; }
                if (diff === 1) found.push({ word: gram, count });
            }
            return found.sort((a, b) => b.count - a.count);
        }
    };
}

/**
 * One fragment of a visible name. Only a one-glyph misreading that the audience
 * outnumbers MIN_DOMINANCE-to-one is corrected; a name nobody types stays literal.
 */
function correctFragment(fragment, corpus) {
    const exact = corpus.count(fragment);
    const [best] = corpus.neighbours(fragment);
    if (!best || best.count < MIN_OBSERVED || best.count < Math.max(exact + MIN_OBSERVED, exact * MIN_DOMINANCE)) return null;
    return { from: fragment, to: best.word, observed: best.count, frameReadings: exact };
}

/**
 * The bar's "title：personal name" form. Chat addresses the title (斧老大), not the
 * personal name (彭猛), so publish the half the audience actually says — but only
 * when the other half is clearly unused. The separator is preserved as written.
 */
function dropUnspokenHalf(name, corpus) {
    const parts = splitName(name);
    const words = parts.filter((part, i) => i % 2 === 0);
    if (words.length !== 2) return null;
    const counts = words.map(part => corpus.count(part));
    const speakers = words.filter((word, i) => counts[i] >= MIN_OBSERVED && counts[i] >= counts[1 - i] * MIN_DOMINANCE);
    return speakers.length === 1 ? speakers[0] : null;
}

/** "斧老大：彭猛" → ['斧老大', '：', '彭猛'], so a rewrite keeps the original punctuation. */
function splitName(name) {
    return String(name || '').split(/([：:])/u);
}

function correctName(name, corpus) {
    const original = String(name || '').trim();
    if (!original) return { title: original, corrections: [] };
    const corrections = [];
    const corrected = splitName(original).map((part, index) => {
        if (index % 2) return part;
        const fragment = part.trim();
        const fix = correctFragment(fragment, corpus);
        if (!fix) return fragment;
        corrections.push(fix);
        return fix.to;
    }).join('');
    const spoken = dropUnspokenHalf(corrected, corpus);
    return { title: spoken || corrected, corrections, shortened: Boolean(spoken) };
}

/**
 * Rewrite frame-read chapter names to the audience spelling. Text-grounded names
 * (from the streamer's own speech) are left alone: they are not OCR.
 * @returns {Array<object>} corrections, for the reviewer and the log
 */
function correctFrameNames(event, audience) {
    const chapters = event?.chapters || [];
    if (!audience?.danmaku?.length && !audience?.subtitles?.length) return [];
    const corpus = createCorpus(audience);
    const applied = [];
    for (const [index, chapter] of chapters.entries()) {
        if (chapter?.nameEvidenceSource !== 'original_frame' || !chapter.nameEvidence) continue;
        // Correct the evidence itself, then the published title, so a re-render keeps the fix.
        const evidence = correctName(chapter.nameEvidence, corpus);
        const title = correctName(chapter.title, corpus);
        const changed = evidence.title !== chapter.nameEvidence || title.title !== chapter.title;
        if (!changed) continue;
        const correction = { start: chapter.start, from: chapter.nameEvidence, evidence: evidence.title,
            title: title.title, corrections: evidence.corrections, shortened: title.shortened };
        chapters[index] = { ...chapter, title: title.title, nameEvidence: evidence.title, nameCorrection: correction,
            ...(chapter.frameNameEvidence ? { frameNameEvidence: { ...chapter.frameNameEvidence,
                publicTitle: title.title, label: evidence.title,
                correction: { literal: chapter.nameEvidence, published: title.title, corrections: evidence.corrections } } } : {}) };
        applied.push(correction);
    }
    return applied;
}

module.exports = { correctFrameNames, correctName, correctFragment, dropUnspokenHalf, createCorpus, MIN_OBSERVED, MIN_DOMINANCE };
