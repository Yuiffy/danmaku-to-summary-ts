export {};
const fs = require('fs'), os = require('os'), path = require('path');
const full = require('../full_live_context'), summary = require('../live_content_summary');
const a = require('./stream_activity_summary'), workflow = require('./stream_activity_clipper');
const asr = require('../asr/asr_backends'), { fileDigest } = require('./source_snapshot');

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-summary-'));
    const base = path.join(directory, '录制-25788785-20261001-200000-000-测试');
    const mediaPath = `${base}.flv`, srtPath = `${base}.srt`, highlightPath = `${base}_AI_HIGHLIGHT.txt`;
    fs.writeFileSync(mediaPath, 'recording');
    fs.writeFileSync(srtPath, '1\n00:01:30,000 --> 00:01:35,000\n唱一首测试曲\n\n2\n00:01:40,000 --> 00:06:40,000\n真实完整的演唱歌词\n\n3\n00:16:30,000 --> 00:16:35,000\n现在来看测试电影\n\n4\n01:39:58,000 --> 01:40:00,000\n电影看完了\n\n5\n01:41:40,000 --> 01:41:44,000\n晚安\n');
    const context = full.buildFullLiveSharedContext({ parsed: asr.parseSrt(srtPath), danmaku: [], config: { compactEvidence: true },
        info: { roomId: '25788785', streamerName: '岁己', streamTitle: '测试' }, totalDuration: 6104 });
    full.saveFullLiveContextSidecar(highlightPath, context, { inputSources: a.sourceInputs(srtPath, null) });
    const byText = text => context.evidence.speech.find(r => r.text.includes(text)).id;
    const raw = { overview: '唱歌、看电影', activityTypes: ['singing', 'watch_movie'], songs: ['测试曲'], games: [], topics: [],
        activityTimeline: { version: 1, status: 'complete', events: [
            { kind: 'song', start: 100, end: 400, name: '测试曲', performance: 'full', startObserved: true, endObserved: true,
                evidenceIds: [byText('唱一首'), byText('演唱歌词')], titleEvidenceIds: [byText('唱一首')] },
            { kind: 'watch', start: 1000, end: 6000, name: '测试电影', publicName: '企鹅老板打工记', mediaKind: 'movie', startObserved: true, endObserved: true,
                evidenceIds: [byText('来看'), byText('看完了')], titleEvidenceIds: [byText('来看')] }
        ] } };
    const generateText = jest.fn(async () => ({ text: JSON.stringify(raw), meta: {} }));
    const calibrate = jest.fn(async events => ({ events: events.map(e => ({ ...e, verification: { decision: 'keep' } })),
        rejected: [], requests: 1, audioSeconds: 240, cacheHits: 0 }));
    const renderPart = jest.fn(async (_source, part, out) => { fs.writeFileSync(out, 'rendered');
        return { ...part, mediaPath: out, bytes: fs.statSync(out).size, sha256: fileDigest(out), actualDuration: part.duration }; });
    const options = { mediaPath, srtPath, probe: async () => 6104, config: { streamActivityClips: { enabled: true,
        songs: { collection: { sectionId: 111, seasonId: 11 } }, watch: { collection: { sectionId: 222, seasonId: 22 } } } },
        generateSummary: opts => summary.generateLiveContentSummary({ ...opts, generateText }),
        calibrate, renderPart, cover: async (_part, out) => fs.writeFileSync(out, 'cover'), registerUpload: false,
        request: () => { throw new Error('A full-stream scan must never run in daily mode'); },
        scheduler: () => ({ acquire: async () => ({ release() {}, profile: {} }) }) };
    return { directory, raw, context, options, generateText, calibrate, renderPart };
}
test('the existing summary request also supplies timestamps, while clips reuse it without rescanning or re-ASR', async () => {
    const f = fixture();
    try {
        const result = await workflow.generateStreamActivities(f.options);
        expect(result).toMatchObject({ submissions: 2, parts: 5, pendingReview: true });
        const plan = JSON.parse(fs.readFileSync(result.planPath, 'utf8'));
        expect(plan.efficiency).toMatchObject({ fullScanRequests: 0, wholeRecordingAsrRuns: 0, boundaryRequests: 1 });
        expect(plan.coverage.method).toBe('summary_shared_input');
        expect(f.generateText).toHaveBeenCalledTimes(1); expect(f.calibrate).toHaveBeenCalledTimes(1);
        const prompt = f.generateText.mock.calls[0][0];
        expect(prompt).toContain('activityTimeline');
        expect(prompt.startsWith(f.context.sharedPrefix)).toBe(true);
        await workflow.generateStreamActivities(f.options);
        expect(f.generateText).toHaveBeenCalledTimes(1); expect(f.calibrate).toHaveBeenCalledTimes(1);
        expect(f.renderPart).toHaveBeenCalledTimes(5);
        expect(JSON.parse(fs.readFileSync(result.songsPath, 'utf8')).songs[0]).toMatchObject({ name: '测试曲', part: 1 });
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('new song packages research names before review and a resumed package never repeats the external research', async () => {
    const f = fixture();
    try {
        f.options.config.streamActivityClips.songs['identifyNames'] = true;
        const evidencePath = path.join(f.directory, 'names.json');
        const identifySongs = jest.fn(async ({ metadataPath }) => {
            const row = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            expect(row.uploadReady).toBe(false);
            fs.writeFileSync(evidencePath, JSON.stringify({ items: [{ activityId: row.activities[0].id, name: '测试曲',
                sourceAlias: '测试曲', segmentIndices: [1], note: '原文明确报幕' }] }));
            return { status: 'identified', evidencePath, identified: [{ name: '测试曲' }], unresolved: [] };
        });
        const options = { ...f.options, kind: 'songs', identifySongs };
        const result = await workflow.generateStreamActivities(options);
        const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
        const row = JSON.parse(fs.readFileSync(manifest.clips[0].metadataPath, 'utf8'));
        expect(row.songResearch.status).toBe('identified');
        expect(row.presentation.titleEvidence.items[0].name).toBe('测试曲');
        expect(row.uploadReady).toBe(false);
        await workflow.generateStreamActivities(options);
        expect(identifySongs).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('opt-in black alignment changes rendering boundaries, persists evidence and resumes without extra scanning', async () => {
    const f = fixture();
    const blackScanRun = jest.fn(async () => ({ stderr: 'black_start:351 black_end:352 black_duration:1' }));
    f.options.config.streamActivityClips.watch['blackAlignment'] = { cadence: { enabled: false } };
    try {
        const options = { ...f.options, kind: 'watch', watchBlackRegion: '.27,.25,.58,.55', blackScanRun };
        const result = await workflow.generateStreamActivities(options);
        const plan = JSON.parse(fs.readFileSync(result.planPath, 'utf8'));
        expect(plan.parts.watch[0].end).toBe(2300.5);
        expect(plan.parts.watch[0].splitBoundary.method).toBe('movie_region_black');
        expect(fs.existsSync(plan.parts.watch[0].blackAlignmentEvidence.path)).toBe(true);
        expect(f.renderPart.mock.calls[0][1].end).toBe(2300.5);
        expect(plan.parts.watch.at(-1).end).toBe(6000);
        const scans = blackScanRun.mock.calls.length;
        await workflow.generateStreamActivities(options);
        expect(blackScanRun).toHaveBeenCalledTimes(scans); expect(f.renderPart).toHaveBeenCalledTimes(4);
        await expect(workflow.generateStreamActivities({ ...options, watchBlackRegion: '.3,.25,.5,.55' }))
            .rejects.toThrow('parameters or shared summary changed');
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('a movie named only in the shared overview is recovered from its original session citation without another request', async () => {
    const f = fixture();
    f.raw.overview = '唱歌并观看《测试电影》';
    f.raw.activityTimeline.events[1].name = null;
    f.raw.activityTimeline.events[1].titleEvidenceIds = [];
    try {
        const result = await workflow.generateStreamActivities(f.options);
        const plan = JSON.parse(fs.readFileSync(result.planPath, 'utf8'));
        expect(plan.events.find(event => event.kind === 'watch')).toMatchObject({ name: '测试电影', titleEvidenceIds: [f.context.evidence.speech.find(row => row.text.includes('来看')).id] });
        const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
        const watch = JSON.parse(fs.readFileSync(manifest.clips[1].metadataPath, 'utf8'));
        expect(watch.copy.title).toBe('《企鹅老板打工记》｜2026.10.1');
        expect(f.generateText).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('first-package boundary recovery aligns the corrected movie range before any video exists', async () => {
    const f = fixture();
    f.options.config.streamActivityClips.watch['blackAlignment'] = { cadence: { enabled: false } };
    const blackScanRun = jest.fn(async () => ({ stderr: 'black_start:351 black_end:352 black_duration:1' }));
    f.calibrate.mockImplementationOnce(async events => ({ events: events.map(e => ({ ...e,
        verification: { decision: 'uncertain', reason: 'opening missing' },
        reviewIssues: ['watch_boundary_provisional'] })), rejected: [], requests: 1, audioSeconds: 120, cacheHits: 0 }));
    try {
        const options = { ...f.options, kind: 'watch', watchBlackRegion: '.27,.25,.58,.55', blackScanRun };
        await expect(workflow.generateStreamActivities(options)).rejects.toThrow('Viewing boundaries remain unresolved');
        expect(f.renderPart).not.toHaveBeenCalled();
        const firstScans = blackScanRun.mock.calls.length;
        f.calibrate.mockImplementationOnce(async events => ({ events: events.map(e => ({ ...e, start: e.start - 50,
            verification: { decision: 'keep' } })), rejected: [], requests: 1, audioSeconds: 180, cacheHits: 0 }));
        const result = await workflow.generateStreamActivities({ ...options, retryBoundaries: true });
        const plan = JSON.parse(fs.readFileSync(result.planPath, 'utf8'));
        expect(plan.parts.watch[0].start).toBe(950);
        expect(plan.parts.watch[0].splitBoundary?.method).toBe('movie_region_black');
        expect(blackScanRun.mock.calls.length).toBeGreaterThan(firstScans);
        expect(plan.efficiency.boundaryRequests).toBe(2);
        expect(f.generateText).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
test('a missing summary timeline stays incomplete and does not trigger retries or a costly alternate detector', async () => {
    const f = fixture();
    delete f.raw.activityTimeline;
    try {
        await expect(workflow.generateStreamActivities(f.options)).rejects.toThrow('missing or incomplete');
        await expect(workflow.generateStreamActivities(f.options)).rejects.toThrow('missing or incomplete');
        expect(f.generateText).toHaveBeenCalledTimes(1); expect(f.calibrate).not.toHaveBeenCalled(); expect(f.renderPart).not.toHaveBeenCalled();
        const paths = workflow.pathsFor(f.options.mediaPath, f.options.config, require('./stream_activity_plan').getActivityConfig(f.options.config));
        expect(JSON.parse(fs.readFileSync(paths.songs, 'utf8'))).toMatchObject({ status: 'failed', coverage: { status: 'incomplete' } });
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
test('source changes invalidate a reused summary timeline', async () => {
    const f = fixture();
    try {
        await workflow.generateStreamActivities({ ...f.options, planOnly: true });
        fs.appendFileSync(f.options.srtPath, '\n6\n01:41:45,000 --> 01:41:46,000\n新的源文字\n');
        await workflow.generateStreamActivities({ ...f.options, planOnly: true, probe: async () => 6106 });
        expect(f.generateText).toHaveBeenCalledTimes(2); expect(f.calibrate).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('cache-only song recovery reuses a watch-created summary and never generates one when missing', async () => {
    const f = fixture();
    try {
        await expect(workflow.generateStreamActivities({ ...f.options, kind: 'songs', reuseSummaryOnly: true }))
            .rejects.toMatchObject({ code: 'ACTIVITY_SUMMARY_NOT_READY' });
        expect(f.generateText).not.toHaveBeenCalled();
        await workflow.generateStreamActivities({ ...f.options, kind: 'watch' });
        const result = await workflow.generateStreamActivities({ ...f.options, kind: 'songs', reuseSummaryOnly: true });
        expect(f.generateText).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fs.readFileSync(result.songsPath, 'utf8')).songs).toHaveLength(1);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('overlapping provisional watch intervals fail before encoding any video', async () => {
    const f = fixture();
    try {
        await expect(workflow.generateStreamActivities({ ...f.options, kind: 'watch', calibrate: async events => ({
            events: [events[0], { ...events[0], id: 'other-work', name: '另一个作品', start: 5990, end: 6100 }],
            rejected: [], requests: 1, cacheHits: 0, audioSeconds: 240 }) })).rejects.toThrow('overlapping');
        expect(f.renderPart).not.toHaveBeenCalled();
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
test('an explicit context path cannot reuse altered timestamp evidence', async () => {
    const f = fixture();
    try {
        const file = path.join(f.directory, 'custom-context.json');
        const payload = full.createFullLiveContextSidecar(f.context, { inputSources: a.sourceInputs(f.options.srtPath, null) });
        payload.evidence.speech[1].start += 10;
        fs.writeFileSync(file, JSON.stringify(payload));
        await expect(workflow.generateStreamActivities({ ...f.options, fullLiveContextPath: file })).rejects.toThrow('evidence hash mismatch');
        expect(f.generateText).not.toHaveBeenCalled(); expect(f.calibrate).not.toHaveBeenCalled();
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('songs finish before watch calibration, preserving their approved bundle and manifest ID on resume', async () => {
    const f = fixture();
    try {
        const songs = await workflow.generateStreamActivities({ ...f.options, kind: 'songs' });
        expect(f.calibrate.mock.calls[0][0].map(event => event.kind)).toEqual(['song']);
        expect(f.renderPart).toHaveBeenCalledTimes(1);
        const firstManifest = JSON.parse(fs.readFileSync(songs.manifestPath, 'utf8'));
        expect(firstManifest.clips).toHaveLength(1);
        const metadataPath = firstManifest.clips[0].metadataPath;
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        metadata.activityReview.status = 'approved'; metadata.uploadReady = true;
        const approved = JSON.stringify(metadata); fs.writeFileSync(metadataPath, approved);
        const beforeSongRecord = JSON.parse(fs.readFileSync(songs.songsPath, 'utf8')).songs;
        const watch = await workflow.generateStreamActivities({ ...f.options, kind: 'watch' });
        expect(watch.manifestPath).toBe(songs.manifestPath);
        expect(f.generateText).toHaveBeenCalledTimes(1);
        expect(f.calibrate.mock.calls[1][0].map(event => event.kind)).toEqual(['watch']);
        expect(f.calibrate.mock.calls[1][1].usedRequests).toBe(1);
        expect(f.renderPart).toHaveBeenCalledTimes(5);
        const combined = JSON.parse(fs.readFileSync(watch.manifestPath, 'utf8'));
        expect(combined.clips).toHaveLength(2);
        expect(combined.clips[0]).toEqual(firstManifest.clips[0]);
        expect(fs.readFileSync(metadataPath, 'utf8')).toBe(approved);
        expect(JSON.parse(fs.readFileSync(watch.songsPath, 'utf8')).songs).toEqual(beforeSongRecord);
        const plan = JSON.parse(fs.readFileSync(watch.planPath, 'utf8'));
        expect(plan.calibratedKinds).toEqual(['songs', 'watch']);
        expect(plan.efficiency.boundaryRequests).toBe(2);
        await workflow.generateStreamActivities(f.options);
        expect(f.calibrate).toHaveBeenCalledTimes(2); expect(f.renderPart).toHaveBeenCalledTimes(5);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('a failed later watch stage preserves songs and retries only watch against the same summary', async () => {
    const f = fixture();
    try {
        const songs = await workflow.generateStreamActivities({ ...f.options, kind: 'songs' });
        const manifest = fs.readFileSync(songs.manifestPath, 'utf8');
        await expect(workflow.generateStreamActivities({ ...f.options, kind: 'watch',
            calibrate: async () => { throw new Error('watch boundary unavailable'); } })).rejects.toThrow('watch boundary unavailable');
        expect(fs.readFileSync(songs.manifestPath, 'utf8')).toBe(manifest);
        expect(JSON.parse(fs.readFileSync(songs.songsPath, 'utf8'))).toMatchObject({ status: 'planned', songs: [{ name: '测试曲' }] });
        await workflow.generateStreamActivities({ ...f.options, kind: 'watch' });
        expect(f.generateText).toHaveBeenCalledTimes(1);
        expect(f.calibrate.mock.calls.map(call => call[0].map(event => event.kind))).toEqual([['song'], ['watch']]);
        expect(f.renderPart).toHaveBeenCalledTimes(5);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('watch-first resume preserves its existing index and does not report deferred songs as absent', async () => {
    const f = fixture();
    try {
        const watch = await workflow.generateStreamActivities({ ...f.options, kind: 'watch' });
        const firstManifest = JSON.parse(fs.readFileSync(watch.manifestPath, 'utf8'));
        expect(JSON.parse(fs.readFileSync(watch.songsPath, 'utf8')).status).toBe('awaiting_songs');
        await workflow.generateStreamActivities({ ...f.options, kind: 'songs' });
        const combined = JSON.parse(fs.readFileSync(watch.manifestPath, 'utf8'));
        expect(combined.clips[0]).toEqual(firstManifest.clips[0]);
        expect(combined.clips[1].reviewIndex).toBe(2);
        expect(combined.clips[1].metadataPath).toMatch(/songs\.json$/);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('a watch activity before songs cannot renumber already rendered song identities', async () => {
    const f = fixture();
    f.raw.activityTimeline.events.unshift({ kind: 'watch', start: 90, end: 95, name: null, mediaKind: 'video',
        startObserved: true, endObserved: true, evidenceIds: [f.raw.activityTimeline.events[0].evidenceIds[0]], titleEvidenceIds: [] });
    try {
        const songs = await workflow.generateStreamActivities({ ...f.options, kind: 'songs' });
        const firstSong = JSON.parse(fs.readFileSync(songs.songsPath, 'utf8')).songs[0];
        expect(firstSong).toMatchObject({ activityId: 'activity-2', part: 1 });
        const firstManifest = JSON.parse(fs.readFileSync(songs.manifestPath, 'utf8'));
        const metadataPath = firstManifest.clips[0].metadataPath;
        const metadata = fs.readFileSync(metadataPath, 'utf8');
        await workflow.generateStreamActivities({ ...f.options, kind: 'watch' });
        expect(JSON.parse(fs.readFileSync(songs.songsPath, 'utf8')).songs[0]).toEqual(firstSong);
        const plan = JSON.parse(fs.readFileSync(songs.planPath, 'utf8'));
        expect(plan.parts.songs[0].activityId).toBe(firstSong.activityId);
        expect(fs.readFileSync(metadataPath, 'utf8')).toBe(metadata);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test.each(['source', 'plan source', 'metadata source', 'parameters'])('later watch processing preserves completed songs when %s changes', async change => {
    const f = fixture();
    try {
        const songs = await workflow.generateStreamActivities({ ...f.options, kind: 'songs' });
        const manifest = JSON.parse(fs.readFileSync(songs.manifestPath, 'utf8'));
        const metadataPath = manifest.clips[0].metadataPath;
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        metadata.activityReview.status = 'approved'; metadata.uploadReady = true;
        if (change === 'metadata source') metadata.sourceSnapshot.srtSha256 = 'corrupt';
        fs.writeFileSync(metadataPath, JSON.stringify(metadata));
        if (change === 'source') fs.appendFileSync(f.options.srtPath, '\n6\n01:41:45,000 --> 01:41:46,000\n源已改变\n');
        if (change === 'plan source') {
            const plan = JSON.parse(fs.readFileSync(songs.planPath, 'utf8'));
            plan.source.srtSha256 = 'corrupt';
            fs.writeFileSync(songs.planPath, JSON.stringify(plan));
        }
        if (change === 'parameters') Object.assign(f.options.config.streamActivityClips.songs, { paddingSeconds: 3 });
        const protectedPaths = [songs.planPath, songs.songsPath, songs.manifestPath, metadataPath];
        const before = protectedPaths.map(file => fs.readFileSync(file, 'utf8'));
        await expect(workflow.generateStreamActivities({ ...f.options, kind: 'watch' })).rejects.toThrow(/revision|differs/);
        expect(protectedPaths.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
        expect(f.calibrate).toHaveBeenCalledTimes(1);
        expect(f.renderPart).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

async function unresolvedSongs(f) {
    return workflow.generateStreamActivities({ ...f.options, kind: 'songs', calibrate: async events => ({
        events: events.map(event => ({ ...event, startObserved: false, endObserved: false,
            provisionalWindow: { start: event.start - 10, end: event.end + 10 },
            reviewIssues: ['media_verification_unconfirmed'], verification: { decision: 'uncertain', reason: 'HTTP 403' } })),
        rejected: [], requests: 1, audioSeconds: 120, cacheHits: 0
    }) });
}

test('explicit boundary recovery retains IDs and originals, rebuilds changed media and leaves completed watch intact', async () => {
    const f = fixture();
    try {
        const songs = await unresolvedSongs(f);
        await workflow.generateStreamActivities({ ...f.options, kind: 'watch' });
        const manifestBefore = fs.readFileSync(songs.manifestPath, 'utf8');
        const manifest = JSON.parse(manifestBefore);
        const metadataPath = manifest.clips[0].metadataPath, watchPath = manifest.clips[1].metadataPath;
        const before = JSON.parse(fs.readFileSync(metadataPath, 'utf8')), watchBefore = fs.readFileSync(watchPath, 'utf8');
        const oldVideo = fs.readFileSync(before.output.mediaPath);
        const calibrate = jest.fn(async events => ({ events: events.map(event => ({ ...event, start: 98, end: 402,
            verification: { decision: 'keep', reason: 'heard intro and final note' } })), rejected: [], requests: 1, audioSeconds: 120, cacheHits: 0 }));
        await workflow.generateStreamActivities({ ...f.options, kind: 'songs', retryBoundaries: true, calibrate, readRegistry: () => ({ clips: {
            '3065': { id: 3065, status: 'needs_review', metadataPath }
        } }) });
        const plan = JSON.parse(fs.readFileSync(songs.planPath, 'utf8')), after = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        expect(calibrate.mock.calls[0][0].map(event => event.id)).toEqual([before.activities[0].id]);
        expect(calibrate.mock.calls[0][1]).toMatchObject({ usedRequests: 2, retryId: plan.boundaryRetry.id });
        expect(plan.efficiency.boundaryRequests).toBe(3);
        expect(after.output.mediaPath).not.toBe(before.output.mediaPath);
        expect(after.output.parts[0]).toMatchObject({ start: 96, end: 404 });
        expect(after).toMatchObject({ uploadReady: false, activityReview: { status: 'pending' } });
        expect(fs.readFileSync(before.output.mediaPath)).toEqual(oldVideo);
        expect(fs.readFileSync(watchPath, 'utf8')).toBe(watchBefore);
        expect(fs.readFileSync(songs.manifestPath, 'utf8')).toBe(manifestBefore);
        expect(JSON.parse(fs.readFileSync(path.join(plan.boundaryRetry.backupDirectory, 'submissions', 'songs.json'), 'utf8'))).toEqual(before);
        expect(JSON.parse(fs.readFileSync(path.join(plan.boundaryRetry.backupDirectory, 'SONGS.json'), 'utf8')).type).toBe('sui_stream_song_record');
        expect(f.generateText).toHaveBeenCalledTimes(1);
        const rendered = f.renderPart.mock.calls.length;
        await workflow.generateStreamActivities({ ...f.options, kind: 'songs' });
        expect(f.renderPart).toHaveBeenCalledTimes(rendered);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('explicit boundary plus publication retry retains automatic eligibility only for its existing unpublished unavailable review', async () => {
    const f = fixture();
    try {
        const result = await unresolvedSongs(f);
        const metadataPath = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')).clips[0].metadataPath;
        const row = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        row.activityAutomaticPublicationRequired = true;
        row.activityReview = { status: 'pending', authority: 'automatic', issues: ['automatic_activity_review_unavailable: invalid intervals'] };
        fs.writeFileSync(metadataPath, JSON.stringify(row));
        f.options.config.streamActivityClips.roomIds = ['25788785'];
        f.options.config.streamActivityClips.automaticPublication = { mode: 'auto', policyVersion: 'stream-activity-v1',
            roomIds: ['25788785'], activatedAt: '2026-01-01T00:00:00Z', authorizationNote: 'configured stream publication' };
        const check = jest.fn(async () => { throw new Error('fixture final review retained as pending'); });
        const retry = { ...f.options, kind: 'songs', retryBoundaries: true, retryPublication: true, revisionNote: 'Repair independent boundary evidence',
            publicationAdapters: { check }, readRegistry: () => ({ clips: { '42': { id: 42, status: 'needs_review', metadataPath } } }) };
        await workflow.generateStreamActivities(retry);
        expect(check).toHaveBeenCalledTimes(1);
        const after = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        expect(after).toMatchObject({ activityAutomaticPublicationRequired: true, uploadReady: false, activityReview: { status: 'pending' } });
        expect(after.output.mediaPath).not.toBe(row.output.mediaPath);
        expect(fs.existsSync(row.output.mediaPath)).toBe(true);
        expect(JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')).clips[0].metadataPath).toBe(metadataPath);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('a failed final watch partition can request new boundary evidence without rescanning or inheriting approval', async () => {
    const f = fixture();
    try {
        const result = await workflow.generateStreamActivities({ ...f.options, kind: 'watch' });
        const metadataPath = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')).clips[0].metadataPath;
        const row = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const proofPath = path.join(f.directory, 'final-failed.json'), checks = { boundaries: false, titles: true };
        fs.writeFileSync(proofPath, JSON.stringify({ status: 'needs_review', evidenceVersion: 3, checks,
            responses: [{ checks, issues: ['末尾包含后续选择'], reviewScope: { partNumbers: [4] } }] }));
        row.activityAutomaticPublicationRequired = true;
        row.activityReview = { status: 'pending', authority: 'automatic', checks, proofPath };
        fs.writeFileSync(metadataPath, JSON.stringify(row));
        f.options.config.streamActivityClips.roomIds = ['25788785'];
        f.options.config.streamActivityClips.automaticPublication = { mode: 'auto', policyVersion: 'stream-activity-v1',
            roomIds: ['25788785'], activatedAt: '2026-01-01T00:00:00Z', authorizationNote: 'configured stream publication' };
        const check = jest.fn(async () => { throw new Error('new final review required'); });
        const calibrate = jest.fn(async events => {
            expect(events).toHaveLength(1);
            expect(events[0].boundaryFeedback).toMatchObject({ previousEnd: 6000, issues: ['末尾包含后续选择'] });
            return { events: events.map(event => ({ ...event, end: 6001, verification: { decision: 'keep' } })),
                rejected: [], requests: 1, audioSeconds: 120, cacheHits: 0 };
        });
        await workflow.generateStreamActivities({ ...f.options, kind: 'watch', retryBoundaries: true, retryPublication: true,
            reviewBoundaryIds: [row.activities[0].id], revisionNote: '重新核实原结束点', calibrate,
            publicationAdapters: { check }, readRegistry: () => ({ clips: { '42': { id: 42, status: 'needs_review', metadataPath } } }) });
        expect(calibrate).toHaveBeenCalledTimes(1);
        expect(check).toHaveBeenCalledTimes(1);
        expect(f.generateText).toHaveBeenCalledTimes(1);
        const after = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        expect(after.activityReview.status).toBe('pending');
        expect(after.activities[0].end).toBe(6001);
        const plan = JSON.parse(fs.readFileSync(result.planPath, 'utf8'));
        expect(plan.efficiency.boundaryRequests).toBe(2);
        expect(plan.boundaryRetry.feedback[0].proofPath).toBe(proofPath);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test.each(['approved', 'queued', 'uploading', 'uploaded', 'budget', 'confirmed', 'lost identity'])('boundary retry refuses %s without requests or plan changes', async state => {
    const f = fixture();
    try {
        const result = state === 'confirmed' ? await workflow.generateStreamActivities({ ...f.options, kind: 'songs' }) : await unresolvedSongs(f);
        const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')), metadataPath = manifest.clips[0].metadataPath;
        if (state === 'approved') {
            const row = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); row.activityReview.status = 'approved';
            fs.writeFileSync(metadataPath, JSON.stringify(row));
        }
        if (state === 'budget') {
            const plan = JSON.parse(fs.readFileSync(result.planPath, 'utf8')); plan.efficiency.boundaryRequests = 3;
            fs.writeFileSync(result.planPath, JSON.stringify(plan));
        }
        if (state === 'lost identity') {
            const plan = JSON.parse(fs.readFileSync(result.planPath, 'utf8'));
            plan.rawEvents.push({ ...plan.rawEvents[0], id: 'activity-lost' });
            plan.contentSha256 = require('./stream_activity_summary_plan').digest(plan);
            fs.writeFileSync(result.planPath, JSON.stringify(plan));
        }
        const before = [result.planPath, result.songsPath, metadataPath, result.manifestPath].map(file => fs.readFileSync(file, 'utf8'));
        const calibrate = jest.fn();
        await expect(workflow.generateStreamActivities({ ...f.options, kind: 'songs', retryBoundaries: true, calibrate,
            readRegistry: () => ({ clips: { '3065': { id: 3065, status: ['queued', 'uploading', 'uploaded'].includes(state) ? state : 'needs_review', metadataPath } } })
        })).rejects.toThrow(/Approved|not pending|budget|No unresolved|merged or lost/);
        expect(calibrate).not.toHaveBeenCalled();
        expect([result.planPath, result.songsPath, metadataPath, result.manifestPath].map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('a retry excluding every candidate invalidates the pending package and retains its numeric identity', async () => {
    const f = fixture();
    try {
        const result = await unresolvedSongs(f), manifestBefore = fs.readFileSync(result.manifestPath, 'utf8');
        const metadataPath = JSON.parse(manifestBefore).clips[0].metadataPath;
        const old = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        await workflow.generateStreamActivities({ ...f.options, kind: 'songs', retryBoundaries: true,
            calibrate: async events => ({ events: [], rejected: events.map(event => ({ ...event, verification: { decision: 'exclude' } })),
                requests: 1, audioSeconds: 120, cacheHits: 0 }) });
        const row = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        expect(row).toMatchObject({ activities: [], uploadReady: false, activityReview: { status: 'pending', reason: expect.stringContaining('excluded') } });
        expect(row.output.mediaPath).toBe(old.output.mediaPath);
        expect(fs.existsSync(old.output.mediaPath)).toBe(true);
        expect(fs.readFileSync(result.manifestPath, 'utf8')).toBe(manifestBefore);
        expect(JSON.parse(fs.readFileSync(result.planPath, 'utf8')).rejectedActivities).toHaveLength(1);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('an explicit verifier revision retains pending IDs and the spent budget while changing only the evidenced route', async () => {
    const f = fixture(), p = require('./stream_activity_plan');
    f.options.config.streamActivityClips.verification = { ...p.LEGACY_NATIVE_VERIFICATION, evidenceMethod: 'native_audio' };
    try {
        const result = await unresolvedSongs(f);
        const before = JSON.parse(fs.readFileSync(result.planPath, 'utf8'));
        before.efficiency.boundaryRequests = 3;
        fs.writeFileSync(result.planPath, JSON.stringify(before));
        const manifestBefore = fs.readFileSync(result.manifestPath, 'utf8');
        const metadataPath = JSON.parse(manifestBefore).clips[0].metadataPath;
        delete f.options.config.streamActivityClips.verification;
        const calibrate = jest.fn(async events => ({ events: events.map(event => ({ ...event, verification: { decision: 'keep' } })),
            rejected: [], requests: 1, audioSeconds: 120, cacheHits: 0 }));
        await workflow.generateStreamActivities({ ...f.options, kind: 'songs', retryBoundaries: true, reviseVerifier: true,
            revisionNote: 'User requested local ASR plus DaiYu, replacing failed native audio', calibrate,
            readRegistry: () => ({ clips: { '3065': { id: 3065, status: 'needs_review', metadataPath } } }) });
        const after = JSON.parse(fs.readFileSync(result.planPath, 'utf8'));
        expect(after.signature).toBe(before.signature);
        expect(after.verificationSignature).not.toBe(before.signature);
        expect(after.efficiency).toMatchObject({ boundaryRequests: 4, maxBoundaryRequests: 6 });
        expect(after.verifierRevisions[0]).toMatchObject({ spentRequests: 3, additionalRequests: 3 });
        expect(calibrate.mock.calls[0][1]).toMatchObject({ usedRequests: 3, maxRequests: 6 });
        expect(fs.readFileSync(result.manifestPath, 'utf8')).toBe(manifestBefore);
        await workflow.generateStreamActivities({ ...f.options, kind: 'songs', calibrate });
        expect(calibrate).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fs.readFileSync(metadataPath, 'utf8')).planSignature).toBe(before.signature);
        f.options.config.streamActivityClips.verification = { boundaryTimeoutMs: 123456 };
        await workflow.generateStreamActivities({ ...f.options, kind: 'songs', calibrate });
        expect(calibrate).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('an unresolved viewing boundary saves evidence but never begins encoding a doomed package', async () => {
    const f = fixture();
    try {
        await expect(workflow.generateStreamActivities({ ...f.options, kind: 'watch', calibrate: async events => ({
            events: events.map(event => ({ ...event, verification: { decision: 'uncertain', reason: 'film continues beyond the excerpt' } })),
            rejected: [], requests: 1, audioSeconds: 120, cacheHits: 0
        }) })).rejects.toThrow('Viewing boundaries remain unresolved before rendering');
        expect(f.renderPart).not.toHaveBeenCalled();
        const files = workflow.pathsFor(f.options.mediaPath, f.options.config, require('./stream_activity_plan').getActivityConfig(f.options.config));
        expect(JSON.parse(fs.readFileSync(files.plan, 'utf8'))).toMatchObject({ status: 'planned', efficiency: { boundaryRequests: 1 } });
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('run binds reviewed viewing names before encoding and preserves the original unknown detection', async () => {
    const f = fixture();
    f.raw.activityTimeline.events[1].name = null;
    f.raw.activityTimeline.events[1].titleEvidenceIds = [];
    const titleEvidencePath = path.join(f.directory, 'names.json');
    fs.writeFileSync(titleEvidencePath, JSON.stringify({ items: [{ activityId: 'activity-2', name: '测试电影',
        sourceAlias: '测试电影', segmentIndices: [3], note: '原话明确说明现在来看测试电影' }] }));
    try {
        const result = await workflow.generateStreamActivities({ ...f.options, kind: 'watch', titleEvidencePath });
        const metadataPath = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')).clips[0].metadataPath;
        const row = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        expect(row.copy.title).toBe('《企鹅老板打工记》｜2026.10.1');
        expect(row.presentation.titleEvidence.items[0].transcriptSha256).toBe(row.transcript.sha256);
        expect(row.activities[0].name).toBeNull();
        expect(row.uploadReady).toBe(false);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('route revision cannot change rendered padding or reuse the same route to grant more requests', async () => {
    for (const change of ['padding', 'same']) {
        const f = fixture();
        try {
            const result = await unresolvedSongs(f), original = fs.readFileSync(result.planPath, 'utf8');
            if (change === 'padding') f.options.config.streamActivityClips.songs.paddingSeconds = 3;
            const calibrate = jest.fn();
            await expect(workflow.generateStreamActivities({ ...f.options, kind: 'songs', retryBoundaries: true, reviseVerifier: true,
                revisionNote: 'explicit route migration', calibrate })).rejects.toThrow(/change only a pending/);
            expect(calibrate).not.toHaveBeenCalled();
            expect(fs.readFileSync(result.planPath, 'utf8')).toBe(original);
        } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
    }
});

test('watch boundary recovery can render its first bundle while preserving an already rendered song bundle', async () => {
    const f = fixture(), watch = { ...f.raw.activityTimeline.events[1],
        evidenceIds: [f.raw.activityTimeline.events[1].evidenceIds[0]] };
    f.raw.activityTimeline.events = [f.raw.activityTimeline.events[0],
        { ...watch, start: 1000, end: 1100 }, { ...watch, start: 1120, end: 1220 }];
    try {
        const songs = await workflow.generateStreamActivities({ ...f.options, kind: 'songs' });
        const songPath = JSON.parse(fs.readFileSync(songs.manifestPath, 'utf8')).clips[0].metadataPath;
        const original = fs.readFileSync(songPath, 'utf8');
        await expect(workflow.generateStreamActivities({ ...f.options, kind: 'watch', calibrate: async events => ({
            events: events.map(event => require('./stream_activity_boundaries').uncertain(event, 'HTTP 502', {}, 6104, { boundaryContextSeconds: 45 })),
            rejected: [], requests: 1, audioSeconds: 240, cacheHits: 0
        }) })).rejects.toThrow('overlapping');
        const calibrate = jest.fn(async events => ({ events: events.map(event => ({ ...event, verification: { decision: 'keep' } })),
            rejected: [], requests: 1, audioSeconds: 240, cacheHits: 0 }));
        f.options.config.streamActivityClips.roomIds = ['25788785'];
        f.options.config.streamActivityClips.automaticPublication = { mode: 'auto', policyVersion: 'stream-activity-v1',
            roomIds: ['25788785'], activatedAt: '2026-01-01T00:00:00Z', authorizationNote: 'configured stream publication' };
        const check = jest.fn(async () => { throw new Error('fixture final review retained as pending'); });
        await workflow.generateStreamActivities({ ...f.options, kind: 'watch', retryBoundaries: true, retryPublication: true,
            revisionNote: 'Resume first watch bundle after service outage', calibrate, publicationAdapters: { check }, readRegistry: () => ({ clips: {} }) });
        expect(calibrate.mock.calls[0][0].map(event => event.id)).toEqual(['activity-2', 'activity-3']);
        expect(calibrate.mock.calls[0][1].usedRequests).toBe(2);
        expect(fs.readFileSync(songPath, 'utf8')).toBe(original);
        expect(JSON.parse(fs.readFileSync(songs.manifestPath, 'utf8')).clips).toHaveLength(2);
        expect(check).toHaveBeenCalledTimes(1);
        const watchPath = JSON.parse(fs.readFileSync(songs.manifestPath, 'utf8')).clips[1].metadataPath;
        expect(JSON.parse(fs.readFileSync(watchPath, 'utf8'))).toMatchObject({
            activityAutomaticPublicationRequired: true, uploadReady: false, activityReview: { status: 'pending' } });
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('overlapping provisional watch padding preserves both candidate identities through explicit recovery', async () => {
    const f = fixture();
    const firstWatch = { ...f.raw.activityTimeline.events[1], start: 100, end: 200, name: null,
        evidenceIds: f.raw.activityTimeline.events[0].evidenceIds, titleEvidenceIds: [] };
    f.raw.activityTimeline.events = [firstWatch, { ...firstWatch, start: 220, end: 320 }];
    try {
        await expect(workflow.generateStreamActivities({ ...f.options, kind: 'watch', calibrate: async events => ({
            events: events.map(event => require('./stream_activity_boundaries').uncertain(event, 'HTTP 502', {}, 6104, { boundaryContextSeconds: 45 })),
            rejected: [], requests: 1, audioSeconds: 240, cacheHits: 0
        }) })).rejects.toThrow('overlapping');
        expect(f.renderPart).not.toHaveBeenCalled();
        const provisional = { planPath: workflow.pathsFor(f.options.mediaPath, f.options.config,
            require('./stream_activity_plan').getActivityConfig(f.options.config)).plan };
        const before = JSON.parse(fs.readFileSync(provisional.planPath, 'utf8'));
        expect(before.events.map(event => event.id)).toEqual(['activity-1', 'activity-2']);
        expect(before.events[0].end).toBeGreaterThan(before.events[1].start);
        const calibrate = jest.fn(async events => ({ events: events.map(event => ({ ...event, verification: { decision: 'keep' } })),
            rejected: [], requests: 1, audioSeconds: 240, cacheHits: 0 }));
        await workflow.generateStreamActivities({ ...f.options, kind: 'watch', retryBoundaries: true, calibrate });
        expect(calibrate.mock.calls[0][0].map(event => event.id)).toEqual(['activity-1', 'activity-2']);
        const after = JSON.parse(fs.readFileSync(provisional.planPath, 'utf8'));
        expect(after.events.map(event => [event.id, event.start, event.end])).toEqual([['activity-1', 100, 200], ['activity-2', 220, 320]]);
        expect(after.parts.watch.map(part => part.activityId)).toEqual(['activity-1', 'activity-2']);
        expect(f.generateText).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
