export {};
const fs = require('fs'), os = require('os'), path = require('path');
const { renderPrecisionRevision } = require('./precision_revision');
const { fileDigest } = require('./source_snapshot');
const { buildSubtitleEvidence } = require('./subtitle_evidence');

test.each(['edited', 'fallback', 'source_changed', 'stale_subtitles', 'pending', 'foreign_inset'])('precision revision %s preserves the published record and ordinary artifacts', async outcome => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precision-revision-'));
    const metadataPath = path.join(dir, 'original.json'), registryPath = path.join(dir, 'registry.json');
    const source = { mediaPath: path.join(dir, 'recording.mp4'), srtPath: path.join(dir, 'recording.srt') };
    const output = { metadataPath, mediaPath: path.join(dir, 'ordinary.mp4'), srtPath: path.join(dir, 'ordinary.srt'),
        coverPath: path.join(dir, 'ordinary.jpg'), burnedSubtitles: true };
    const sourceCues = [{ start: 101, end: 103, text: '看看这里' }];
    fs.writeFileSync(source.mediaPath, 'source video'); fs.writeFileSync(source.srtPath, 'source evidence');
    for (const file of [output.mediaPath, output.srtPath, output.coverPath]) fs.writeFileSync(file, 'original artifact');
    const original = { mode: 'own_stream_fun_review', roomId: 'room', uploadReady: true, source, output,
        window: { start: 100, end: 160, duration: 60, index: 1 }, copy: { title: '看看这里' },
        attributionReview: { sourceSha256: buildSubtitleEvidence(sourceCues).sourceSha256,
            artifactDigests: { video: fileDigest(output.mediaPath), subtitles: fileDigest(output.srtPath) } },
        creativeResult: { status: 'kept_original' } };
    fs.writeFileSync(metadataPath, JSON.stringify(original));
    const reviewPlanPath = path.join(dir, 'PLAN.json');
    fs.writeFileSync(reviewPlanPath, JSON.stringify({ clips: [{ start: 100, end: 160 }] }));
    fs.writeFileSync(registryPath, JSON.stringify({ clips: { 17: { metadataPath, reviewPlanPath, reviewIndex: 1,
        status: 'uploaded', pendingRebuild: outcome === 'pending', uploadState: { bvid: 'BVfixture' } } } }));
    const registryBefore = fs.readFileSync(registryPath, 'utf8'), before = fs.readFileSync(metadataPath, 'utf8');
    const enhance = jest.fn(async baseline => {
        expect(baseline.output.metadataPath).not.toBe(metadataPath);
        expect(baseline.output.mediaPath).toBe(output.mediaPath);
        expect(baseline.precisionExperiment.selected).toBe(true);
        expect(baseline.creativeResult).toBeUndefined();
        if (outcome === 'source_changed') fs.appendFileSync(source.srtPath, 'modified');
        if (outcome === 'fallback') return { ...baseline, creativeResult: { status: 'kept_original', reason: 'invalid plan' } };
        const mediaPath = path.join(path.dirname(baseline.output.metadataPath), 'edited.mp4');
        fs.writeFileSync(mediaPath, 'new video');
        return { ...baseline, output: { ...baseline.output, mediaPath }, creativeResult: { status: 'edited' },
            creativePlan: { effects: [{ id: 'M1' }] }, qaResult: { status: 'passed' } };
    });
    const dependencies = { enhance, rootConfig: { ownStreamClips: { enhancements: { enabled: true,
        roomIds: ['room'], workflow: 'creative' } } }, topic: { parseTopicSrt: file => ({ segments: file === source.srtPath
        ? sourceCues : [{ start: 1, end: 3, text: '看看这里' }] }) } };
    try {
        if (outcome === 'stale_subtitles') fs.appendFileSync(output.srtPath, 'unreviewed edit');
        const insetPlanPath = outcome === 'foreign_inset' ? path.join(dir, 'inset.json') : undefined;
        if (insetPlanPath) fs.writeFileSync(insetPlanPath, JSON.stringify({ version: 1, clipId: 17,
            sourceMetadataSha256: '0'.repeat(64), timelineSha256: '1'.repeat(64), insets: [] }));
        const promise = renderPrecisionRevision({ id: 17, registryPath, note: '重做精切', insetPlanPath }, dependencies);
        if (['source_changed', 'stale_subtitles', 'pending', 'foreign_inset'].includes(outcome)) await expect(promise).rejects.toThrow(/changed|active|not bound/);
        else {
            const result = await promise;
            expect(result.status).toBe(outcome === 'edited' ? 'pending_review' : 'failed');
            const saved = JSON.parse(fs.readFileSync(result.metadataPath, 'utf8'));
            expect(saved.uploadReady).toBe(false); expect(saved.precisionRevision.uploadAuthorized).toBe(false);
            expect(saved.precisionRevision.clipId).toBe(17);
        }
        expect(fs.readFileSync(registryPath, 'utf8')).toBe(registryBefore);
        expect(fs.readFileSync(metadataPath, 'utf8')).toBe(before);
        expect(fs.readFileSync(output.mediaPath, 'utf8')).toBe('original artifact');
        expect(fs.existsSync(metadataPath + '.cut.lock')).toBe(false);
        if (['stale_subtitles', 'pending', 'foreign_inset'].includes(outcome)) expect(enhance).not.toHaveBeenCalled();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
