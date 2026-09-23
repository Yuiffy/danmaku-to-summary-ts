export {};
const fs = require('fs'), os = require('os'), path = require('path');
const { renderPrecisionRevision } = require('./precision_revision');
const { fileDigest } = require('./source_snapshot');
const { buildSubtitleEvidence } = require('./subtitle_evidence');

test.each(['edited', 'no_attribution_review', 'sound_override', 'invalid_sound_override', 'fallback', 'source_changed', 'stale_subtitles', 'pending', 'foreign_inset'])('precision revision %s preserves the published record and ordinary artifacts', async outcome => {
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
    if (outcome === 'no_attribution_review') delete original.attributionReview;
    fs.writeFileSync(metadataPath, JSON.stringify(original));
    const reviewPlanPath = path.join(dir, 'PLAN.json');
    fs.writeFileSync(reviewPlanPath, JSON.stringify({ clips: [{ start: 100, end: 160 }] }));
    fs.writeFileSync(registryPath, JSON.stringify({ clips: { 17: { metadataPath, reviewPlanPath, reviewIndex: 1,
        status: 'uploaded', pendingRebuild: outcome === 'pending', uploadState: { bvid: 'BVfixture' } } } }));
    const registryBefore = fs.readFileSync(registryPath, 'utf8'), before = fs.readFileSync(metadataPath, 'utf8');
    let resumeFrom, soundLevelOverridesPath;
    if (['sound_override', 'invalid_sound_override'].includes(outcome)) {
        resumeFrom = path.join(dir, 'previous');
        const scratch = path.join(resumeFrom, 'temp', 'clip-creative');
        fs.mkdirSync(scratch, { recursive: true });
        fs.writeFileSync(path.join(resumeFrom, 'original.json'), before);
        fs.writeFileSync(path.join(resumeFrom, 'clip.json'), JSON.stringify({ precisionRevision: { clipId: 17, sourceSnapshot: require('./source_snapshot').sourceSnapshot(original) } }));
        const priorPlanPath = path.join(scratch, 'creative-plan.json');
        fs.writeFileSync(priorPlanPath, JSON.stringify({ plan: { effects: [{ id: 'M1', sound: { id: 'pop', levelDb: -6 } }] } }));
        soundLevelOverridesPath = path.join(dir, 'sound-levels.json');
        fs.writeFileSync(soundLevelOverridesPath, JSON.stringify({ version: 1, clipId: 17,
            planSha256: outcome === 'invalid_sound_override' ? '0'.repeat(64) : fileDigest(priorPlanPath),
            sounds: [{ momentId: 'M1', levelDb: 0 }] }));
    }
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
        const promise = renderPrecisionRevision({ id: 17, registryPath, note: '重做精切', insetPlanPath, resumeFrom, soundLevelOverridesPath,
            coverTextPosition: outcome === 'sound_override' ? 'bottom' : undefined }, dependencies);
        if (['source_changed', 'stale_subtitles', 'pending', 'foreign_inset', 'invalid_sound_override'].includes(outcome)) await expect(promise).rejects.toThrow(/changed|active|not bound/);
        else {
            const result = await promise;
            expect(result.status).toBe(['edited', 'no_attribution_review', 'sound_override'].includes(outcome) ? 'pending_review' : 'failed');
            const saved = JSON.parse(fs.readFileSync(result.metadataPath, 'utf8'));
            expect(saved.uploadReady).toBe(false); expect(saved.precisionRevision.uploadAuthorized).toBe(false);
            expect(saved.precisionRevision.clipId).toBe(17);
            if (outcome === 'sound_override') {
                expect(enhance.mock.calls[0][1].options.creativeSoundLevelOverrides).toEqual([{ momentId: 'M1', levelDb: 0 }]);
                expect(enhance.mock.calls[0][1].options.creativeCoverTextPosition).toBe('bottom');
            }
        }
        expect(fs.readFileSync(registryPath, 'utf8')).toBe(registryBefore);
        expect(fs.readFileSync(metadataPath, 'utf8')).toBe(before);
        expect(fs.readFileSync(output.mediaPath, 'utf8')).toBe('original artifact');
        expect(fs.existsSync(metadataPath + '.cut.lock')).toBe(false);
        if (['stale_subtitles', 'pending', 'foreign_inset', 'invalid_sound_override'].includes(outcome)) expect(enhance).not.toHaveBeenCalled();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
