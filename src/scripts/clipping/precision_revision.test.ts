export {};
const fs = require('fs'), os = require('os'), path = require('path');
const { renderPrecisionRevision } = require('./precision_revision');
const { fileDigest } = require('./source_snapshot');
const { buildSubtitleEvidence } = require('./subtitle_evidence');

test.each(['edited', 'rebuilt', 'campaign', 'campaign_wrong_date', 'no_attribution_review', 'sound_override', 'invalid_sound_override', 'automatic_edited', 'automatic_tampered', 'automatic_copy_changed', 'automatic_missing_baseline', 'fallback', 'source_changed', 'stale_subtitles', 'pending', 'foreign_inset'])('precision revision %s preserves the published record and ordinary artifacts', async outcome => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precision-revision-'));
    const metadataPath = path.join(dir, 'original.json'), registryPath = path.join(dir, 'registry.json');
    const source = { mediaPath: path.join(dir, 'recording.mp4'), srtPath: path.join(dir, 'recording.srt') };
    const output = { metadataPath, mediaPath: path.join(dir, 'ordinary.mp4'), srtPath: path.join(dir, 'ordinary.srt'),
        coverPath: path.join(dir, 'ordinary.jpg'), burnedSubtitles: true };
    const sourceCues = [{ start: 101, end: 103, text: '看看这里' }];
    fs.writeFileSync(source.mediaPath, 'source video'); fs.writeFileSync(source.srtPath, 'source evidence');
    for (const file of [output.mediaPath, output.srtPath, output.coverPath]) fs.writeFileSync(file, 'original artifact');
    const original: any = { mode: 'own_stream_fun_review', roomId: 'room', uploadReady: true, source, output,
        window: { start: 100, end: 160, duration: 60, index: 1 }, copy: { title: '看看这里' },
        attributionReview: { sourceSha256: buildSubtitleEvidence(sourceCues).sourceSha256,
            artifactDigests: { video: fileDigest(output.mediaPath), subtitles: fileDigest(output.srtPath) } },
        creativeResult: { status: 'kept_original' } };
    if (outcome === 'no_attribution_review') delete original.attributionReview;
    if (outcome.startsWith('campaign')) original.recordedAt = outcome === 'campaign' ? '2026-10-23 14:02:55' : '1999-01-01 00:00:00';
    if (outcome.startsWith('automatic_')) {
        original.enhancement = { baseline: { ...output, copy: original.copy, window: original.window } };
        original.output = { ...output, mediaPath: path.join(dir, 'automatic.mp4'), srtPath: path.join(dir, 'automatic.srt'), coverPath: path.join(dir, 'automatic.jpg') };
        for (const file of [original.output.mediaPath, original.output.srtPath, original.output.coverPath]) fs.writeFileSync(file, 'reviewed precision artifact');
        original.qaResult = { status: 'passed', digests: await require('../workflow-runtime').loadWorkflow('clipping/enhancement').artifactDigests(original) };
        if (outcome === 'automatic_copy_changed') original.copy = { title: 'unaudited claim' };
        original.audioQa = { status: 'passed' };
        original.creativeResult = { status: 'edited' };
        original.creativePlan = { sourceId: await require('./creative_source_expansion').creativeSourceIdentity({ mediaPath: source.mediaPath }, source) };
        original.editPlan = { sourceWindow: { start: 100, end: 160 }, removed: [{ start: 120, end: 125 }] };
        const oldScratch = path.join(dir, 'temp', 'original-creative');
        fs.mkdirSync(oldScratch, { recursive: true });
        fs.writeFileSync(path.join(oldScratch, 'story-response.json'), JSON.stringify({ text: '{}' }));
        fs.writeFileSync(path.join(oldScratch, 'qa-response.json'), JSON.stringify({ text: '{"approved":true}' }));
        if (outcome === 'automatic_missing_baseline') delete original.enhancement.baseline;
    }
    if (outcome === 'rebuilt') {
        const { copyDigest } = require('./actor_review');
        original.attributionRequired = true;
        original.attributionReview = { ...original.attributionReview, version: 1, status: 'passed', start: 100, end: 160,
            proposedCopy: original.copy, copyDigest: copyDigest(original.copy), artifactCopyDigest: copyDigest(original.copy), issues: [] };
        original.renderedSubtitles = { version: 1, sourceSha256: buildSubtitleEvidence(sourceCues).sourceSha256,
            sourceSnapshot: require('./source_snapshot').sourceSnapshot(original), window: { start: 100, end: 160 }, review: { note: 'Rebuilt current baseline' } };
        original.publicationReview = { status: 'passed', issues: [], technical: { passed: true }, artifactWindow: { start: 100, end: 160 },
            checks: { content: true, attribution: true, subtitles: true, visuals: true, policy: true },
            ...await require('../workflow-runtime').loadWorkflow('clipping/publicationRuntime').publicationSnapshot(original) };
    }
    fs.writeFileSync(metadataPath, JSON.stringify(original));
    const reviewPlanPath = path.join(dir, 'PLAN.json');
    fs.writeFileSync(reviewPlanPath, JSON.stringify({ clips: [outcome === 'rebuilt'
        ? { start: 1, end: 200, publicCopyPending: true } : { start: 100, end: 160 }] }));
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
    const dependencies: any = { enhance, rootConfig: { ownStreamClips: { enhancements: { enabled: true,
        roomIds: ['room'], workflow: 'creative' } } }, topic: { parseTopicSrt: file => ({ segments: file === source.srtPath
        ? sourceCues : [{ start: 1, end: 3, text: '看看这里' }] }) } };
    if (outcome.startsWith('campaign')) {
        dependencies.rootConfig.ownStreamClips.enhancements.roomIds = ['daily'];
        dependencies.rootConfig.ownStreamClips.campaigns = [{ enabled: true, roomIds: ['room'],
            startsAt: '2000-01-01T00:00:00+08:00', endsAt: '2026-11-06T00:00:00+08:00', settings: {} }];
    }
    try {
        if (outcome === 'stale_subtitles') fs.appendFileSync(output.srtPath, 'unreviewed edit');
        if (outcome === 'automatic_tampered') fs.appendFileSync(original.output.mediaPath, 'modified');
        const insetPlanPath = outcome === 'foreign_inset' ? path.join(dir, 'inset.json') : undefined;
        if (insetPlanPath) fs.writeFileSync(insetPlanPath, JSON.stringify({ version: 1, clipId: 17,
            sourceMetadataSha256: '0'.repeat(64), timelineSha256: '1'.repeat(64), insets: [] }));
        const promise = renderPrecisionRevision({ id: 17, registryPath, note: '重做精切', insetPlanPath, resumeFrom, soundLevelOverridesPath,
            coverTextPosition: outcome === 'sound_override' ? 'bottom' : undefined }, dependencies);
        if (outcome === 'campaign_wrong_date') await expect(promise).rejects.toThrow('Creative enhancement is not enabled for this room');
        else if (['source_changed', 'stale_subtitles', 'pending', 'foreign_inset', 'invalid_sound_override', 'automatic_tampered', 'automatic_copy_changed', 'automatic_missing_baseline'].includes(outcome)) await expect(promise).rejects.toThrow(/changed|active|not bound|baseline/);
        else {
            const result = await promise;
            expect(result.status).toBe(['edited', 'campaign', 'no_attribution_review', 'sound_override', 'automatic_edited'].includes(outcome) ? 'pending_review' : 'failed');
            const saved = JSON.parse(fs.readFileSync(result.metadataPath, 'utf8'));
            if (outcome === 'rebuilt') expect(enhance.mock.calls[0][1].clip).toMatchObject({ start: 100, end: 160, title: original.copy.title });
            expect(saved.uploadReady).toBe(false); expect(saved.precisionRevision.uploadAuthorized).toBe(false);
            expect(saved.precisionRevision.clipId).toBe(17);
            if (outcome === 'sound_override') {
                expect(enhance.mock.calls[0][1].options.creativeSoundLevelOverrides).toEqual([{ momentId: 'M1', levelDb: 0 }]);
                expect(enhance.mock.calls[0][1].options.creativeCoverTextPosition).toBe('bottom');
            }
            if (outcome === 'automatic_edited') {
                const resumed = enhance.mock.calls[0][1].options.creativeResumeDirectory;
                expect(fs.existsSync(path.join(resumed, 'temp', 'clip-creative', 'story-response.json'))).toBe(true);
                expect(fs.existsSync(path.join(resumed, 'temp', 'clip-creative', 'qa-response.json'))).toBe(false);
                expect(saved.precisionRevision.originalDigests.video).toBe(fileDigest(original.output.mediaPath));
                expect(saved.precisionRevision.baselineDigests.video).toBe(fileDigest(output.mediaPath));
            }
        }
        expect(fs.readFileSync(registryPath, 'utf8')).toBe(registryBefore);
        expect(fs.readFileSync(metadataPath, 'utf8')).toBe(before);
        expect(fs.readFileSync(output.mediaPath, 'utf8')).toBe('original artifact');
        expect(fs.existsSync(metadataPath + '.cut.lock')).toBe(false);
        if (['stale_subtitles', 'pending', 'foreign_inset', 'invalid_sound_override', 'automatic_tampered', 'automatic_copy_changed', 'automatic_missing_baseline'].includes(outcome)) expect(enhance).not.toHaveBeenCalled();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
