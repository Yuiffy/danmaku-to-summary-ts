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
            { kind: 'watch', start: 1000, end: 6000, name: '测试电影', mediaKind: 'movie', startObserved: true, endObserved: true,
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
        expect(watch.copy.title).toBe('《测试电影》｜2026.10.1');
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

test('overlapping provisional watch padding preserves both candidate identities through explicit recovery', async () => {
    const f = fixture();
    const firstWatch = { ...f.raw.activityTimeline.events[1], start: 100, end: 200, name: null,
        evidenceIds: f.raw.activityTimeline.events[0].evidenceIds, titleEvidenceIds: [] };
    f.raw.activityTimeline.events = [firstWatch, { ...firstWatch, start: 220, end: 320 }];
    try {
        const provisional = await workflow.generateStreamActivities({ ...f.options, kind: 'watch', calibrate: async events => ({
            events: events.map(event => require('./stream_activity_boundaries').uncertain(event, 'HTTP 502', {}, 6104, { boundaryContextSeconds: 45 })),
            rejected: [], requests: 1, audioSeconds: 240, cacheHits: 0
        }) });
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
