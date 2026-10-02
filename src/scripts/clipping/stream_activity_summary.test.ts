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
