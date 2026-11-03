export {};
const fs = require('fs'), os = require('os'), path = require('path');
const { prepareReviewResults } = require('./own_review_state');

test('unrendered editorial backups keep stable registry identities, subtitles and peer evidence without rendering', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-review-'));
    try {
        const parsed = { segments: [{ start: 10, end: 12, text: '完整前情' }, { start: 12, end: 15, text: '回应收束' }] };
        const deferred = { start: 10, end: 15, candidateIndex: 7, title: '人工待选', score: 88,
            curation: { status: 'covered', reason: '同题完整覆盖', peer: { bvid: 'BV1234567890' } },
            publication: { selected: false, reason: 'curation_covered' } };
        const plan = { source: { mediaPath: 'source.mp4' }, publication: { deferred: [deferred] } };
        const first = prepareReviewResults([], plan, parsed, directory);
        const second = prepareReviewResults([], plan, parsed, directory);
        expect(second).toEqual(first);
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ uploadReady: false, selectionRejection: { reason: 'editorial_deferred' },
            window: { start: 10, end: 15 }, curation: deferred.curation, publication: deferred.publication });
        expect(fs.readFileSync(first[0].output.srtPath, 'utf8')).toContain('完整前情');
        expect(first[0].output.mediaPath).toBeNull();
        expect(first[0].reviewIndex).toBeGreaterThan(0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
