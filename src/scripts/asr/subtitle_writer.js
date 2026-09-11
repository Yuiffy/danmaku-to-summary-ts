'use strict';
const fs = require('fs');
const { applyCorrectionsToSegments, makeCorrectionStats, logCorrectionStats } = require('./asr_corrections');

function writeSrt(result, srtPath, cfg, helpers) {
    const { stripSubtitlePunctuation, splitTextByLength, formatTimestamp, parseTimestamp } = helpers;
    const lines = [];
    const evidenceRows = [];
    let lineIndex = 1;
    const segments = Array.isArray(result?.segments) ? result.segments : [];
    const correctionStats = makeCorrectionStats();
    const aliasedTexts = applyCorrectionsToSegments(segments, cfg.corrections, correctionStats);
    const prepared = require('./subtitle_proofreading').proofreadSubtitleTexts(segments, aliasedTexts, cfg.proofreading);
    const correctedTexts = prepared.texts;
    segments.forEach((segment, index) => {
        const correctedText = correctedTexts[index] || '';
        const content = cfg.strip_punctuation ? stripSubtitlePunctuation(correctedText) : correctedText;
        if (!content) {
            return;
        }
        const text = content;
        const wrapped = splitTextByLength(text, cfg.max_chars_per_line).join('\n');
        if (cfg.write_evidence === true) {
            evidenceRows.push({
                start: parseTimestamp(formatTimestamp(segment.start)),
                end: parseTimestamp(formatTimestamp(segment.end)),
                text: wrapped.split('\n').map(line => line.trim()).join(''),
                asr: {
                    status: typeof segment.asrSource?.rawText === 'string' ? 'available' : 'raw_unavailable',
                    sourceSpan: segment.asrSource || null,
                    recognizedText: String(segment.text || ''),
                    correctedText,
                    aliasChanged: correctedText !== String(segment.text || ''),
                    ...(prepared.enabled ? { proofreading: { version: 1,
                        edits: prepared.edits.filter(edit => edit.cue === index + 1),
                        checks: prepared.checks.filter(check => check.cue === index + 1) } } : {})
                },
                ...(segment.speakerEvidence || segment.speaker_evidence
                    ? { speaker: segment.speakerEvidence || segment.speaker_evidence } : {})
            });
        }
        lines.push(String(lineIndex));
        lines.push(`${formatTimestamp(segment.start)} --> ${formatTimestamp(segment.end)}`);
        lines.push(wrapped);
        lines.push('');
        lineIndex += 1;
    });
    logCorrectionStats(correctionStats, 'ASR corrections');
    if (prepared.enabled) console.log(`[Subtitle proofreading] ${prepared.edits.length} source-backed edits; ${prepared.checks.length} advisory checks`);
    const content = `${lines.join('\n').trim()}\n`;
    fs.writeFileSync(srtPath, content, 'utf8');
    if (cfg.write_evidence === true) {
        try {
            require('./evidence_sidecar').writeAsrEvidence(srtPath, content, evidenceRows, result?.backend || 'unknown');
        } catch (error) {
            console.warn(`ASR evidence sidecar unavailable: ${error.message}`);
        }
    }
}

module.exports = { writeSrt };
