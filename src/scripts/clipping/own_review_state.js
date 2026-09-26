'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildSubtitleEvidence, parseClipResponse } = require('./subtitle_evidence');
const { chronologicalResults } = require('./own_review_report');

function prepareReviewResults(results, plan, parsed, outputRoot) {
    const topic = require('../topic_clipper');
    const evidence = buildSubtitleEvidence(parsed.segments);
    const rejected = [...(plan.aiStatus?.validation?.rejected || []), ...(plan.aiStatus?.rejectedAfterAlignment || [])];
    const requestId = plan.aiStatus?.requests?.find(request => request.phase === 'global-rerank')?.requestId;
    if (requestId && rejected.some(item => !item.title)) {
        for (const directory of [path.join(outputRoot, '.selection-cache'), path.join(outputRoot, '.selection-cache/.attempt-outcomes')]) {
            if (!fs.existsSync(directory)) continue;
            for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
                try {
                    const cached = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')).result;
                    const ids = [cached?.meta?.requestId, ...(cached?.meta?.attempts || []).map(attempt => attempt.requestId)];
                    if (!ids.includes(requestId)) continue;
                    const clips = parseClipResponse(cached.text);
                    for (const item of rejected) {
                        const original = clips.find(clip => String(clip.candidateIndex) === String(item.candidateIndex)
                            && clip.startCueId === item.startCueId && clip.endCueId === item.endCueId);
                        if (original && !item.title) { item.title = original.title; item.score = original.score; }
                    }
                } catch { /* A corrupt/unrelated cache entry is not recovery evidence. */ }
            }
        }
    }
    const held = rejected.map(rejection => {
        const source = plan.source || {};
        const key = crypto.createHash('sha256').update(JSON.stringify({
            source: source.mediaPath, candidateIndex: rejection.candidateIndex, reason: rejection.reason,
            startCueId: rejection.startCueId, endCueId: rejection.endCueId,
            startTime: rejection.startTime, endTime: rejection.endTime
        })).digest('hex').slice(0, 20);
        const directory = path.join(outputRoot, 'rejected_candidates');
        const metadataPath = path.join(directory, `rejected-${key}.json`);
        if (fs.existsSync(metadataPath)) {
            const existing = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            if (!existing.selectionSource) {
                existing.selectionSource = rejection.selectionSource || 'model_global_rerank';
                fs.writeFileSync(metadataPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
            }
            return existing;
        }
        const start = Number.isFinite(rejection.start) ? rejection.start : evidence.byId.get(rejection.startCueId)?.start;
        const end = Number.isFinite(rejection.end) ? rejection.end : evidence.byId.get(rejection.endCueId)?.end;
        const validWindow = Number.isFinite(start) && Number.isFinite(end) && end > start;
        const index = parseInt(key.slice(0, 8), 16) + 1000000;
        const window = { index, start: start ?? null, end: end ?? null, duration: validWindow ? end - start : null };
        fs.mkdirSync(directory, { recursive: true });
        const srtPath = validWindow ? path.join(directory, `rejected-${key}.srt`) : null;
        if (srtPath) topic.writeClipSrt(parsed.segments, window, srtPath);
        const metadata = {
            version: 1, mode: 'own_stream_fun_review', status: 'selection_rejected', reviewIndex: index,
            generatedAt: new Date().toISOString(), source, window,
            selectionSource: rejection.selectionSource || 'model_global_rerank',
            copy: { title: rejection.title || `\u88ab\u5254\u9664\u5019\u9009 ${rejection.candidateIndex ?? rejection.index ?? '?'}`, description: '', coverText: '' },
            recommendationScore: rejection.score ?? null, publicCopyPending: true, uploadReady: false,
            selectionRejection: { minClipSeconds: plan.config?.minClipSeconds, maxClipSeconds: plan.config?.maxClipSeconds,
                ...rejection, sourceSha256: evidence.sourceSha256 },
            grounding: { sourceSha256: evidence.sourceSha256, issues: [`selection_rejected:${rejection.reason}`],
                subtitles: validWindow ? evidence.cues.filter(cue => cue.start >= start && cue.end <= end).slice(0, 3)
                    .map(({ id, start, end, text }) => ({ id, start, end, text })) : [] },
            output: { metadataPath, mediaPath: null, srtPath, coverPath: null, burnedSubtitles: false }
        };
        fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
        return metadata;
    });
    return chronologicalResults([...results, ...held]);
}

function saveReviewState(reviewPath, results, metadata, buildReviewMarkdown) {
    fs.writeFileSync(reviewPath, buildReviewMarkdown(results, metadata), 'utf8');
    fs.writeFileSync(reviewPath.replace(/\.md$/i, '_STATE.json'), `${JSON.stringify({
        version: 1, type: 'own_stream_review_state', metadata,
        entries: results.map(result => ({ reviewIndex: result.reviewIndex ?? result.window?.index,
            metadataPath: result.output.metadataPath }))
    }, null, 2)}\n`, 'utf8');
}

module.exports = { prepareReviewResults, saveReviewState };
