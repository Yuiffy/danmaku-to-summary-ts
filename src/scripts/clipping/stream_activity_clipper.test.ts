export {};
const fs = require('fs'), os = require('os'), path = require('path');
const workflow = require('./stream_activity_clipper');
const { sha } = require('./stream_activity_plan');
const { songStatistics } = require('../stream_activity_clips');

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-activities-'));
    const mediaPath = path.join(dir, '录制-25788785-20261001-200000-000-测试.flv'), srtPath = path.join(dir, 'source.srt');
    fs.writeFileSync(mediaPath, 'recording');
    fs.writeFileSync(srtPath, '1\n00:01:40,000 --> 00:06:40,000\n唱一下测试曲\n\n2\n00:16:40,000 --> 01:40:00,000\n现在来看测试电影\n');
    const config = { streamActivityClips: { enabled: true, detectionMode: 'standalone_scan', songs: { collection: { sectionId: 111, seasonId: 11 } },
        watch: { collection: { sectionId: 222, seasonId: 22 } } } };
    const scheduler = () => ({ acquire: async () => ({ release() {}, profile: { mode: 'idle', ffmpegThreads: 4 } }) });
    const renderPart = jest.fn(async (_source, part, out) => { fs.writeFileSync(out, `render:${part.start}-${part.end}`);
        return { ...part, mediaPath: out, actualDuration: part.duration, bytes: fs.statSync(out).size, sha256: sha(fs.readFileSync(out).toString()) }; });
    const cover = jest.fn(async (_part, out) => { fs.writeFileSync(out, 'cover'); });
    const request = jest.fn(async (prompt: string) => {
        const [coreStart, coreEnd] = prompt.match(/Core window ([\d.]+)-([\d.]+)/)!.slice(1).map(Number);
        const [from, to] = prompt.match(/context ([\d.]+)-([\d.]+)/)!.slice(1).map(Number);
        const events = [];
        if (coreStart < 400) events.push({ kind: 'song', start: 100, end: 400, name: '测试曲', performance: 'full',
            startObserved: true, endObserved: true, evidenceIds: ['T1'], titleEvidenceIds: ['T1'] });
        if (coreEnd >= 1000) events.push({ kind: 'watch', start: Math.max(1000, from), end: Math.min(6000, to),
            name: '测试电影', mediaKind: 'movie', startObserved: from <= 1000, endObserved: to >= 6000,
            evidenceIds: ['T2'], titleEvidenceIds: ['T2'] });
        return { text: JSON.stringify({ events }), meta: {} };
    });
    return { dir, options: { config, mediaPath, srtPath, probe: async () => 6100, request, renderPart, cover, scheduler,
        verify: async event => ({ decision: 'keep', events: [{ ...event, verification: { decision: 'keep', reason: 'fixture media check' } }] }),
        registerUpload: false }, renderPart, request };
}
test('one archive per kind, full song JSON, complete multipart rendering and restart reuse', async () => {
    const f = fixture();
    try {
        const result = await workflow.generateStreamActivities(f.options);
        expect(result).toMatchObject({ status: 'rendered', submissions: 2, parts: 5, pendingReview: true });
        const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
        const metadata = manifest.clips.map(row => JSON.parse(fs.readFileSync(row.metadataPath, 'utf8')));
        expect(metadata.map(row => row.output.parts.length)).toEqual([1, 4]);
        expect(metadata.map(row => row.upload.collectionSectionId)).toEqual([111, 222]);
        expect(metadata.every(row => row.uploadReady === false && row.activityReview.status === 'pending')).toBe(true);
        const songs = JSON.parse(fs.readFileSync(result.songsPath, 'utf8'));
        expect(songs.songs).toHaveLength(1); expect(songs.songs[0]).toMatchObject({ name: '测试曲', part: 1 });
        expect(songStatistics(f.dir)).toMatchObject({ inspectedSessions: 1, performances: 1, unknownPerformances: 0 });
        expect(fs.readFileSync(result.reviewPath, 'utf8')).toContain('一个投稿，4 P');
        await workflow.generateStreamActivities(f.options);
        expect(f.renderPart).toHaveBeenCalledTimes(5); expect(f.request).toHaveBeenCalledTimes(4);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('AI failure persists incomplete coverage and does not masquerade as a songless stream', async () => {
    const f = fixture();
    try {
        await expect(workflow.generateStreamActivities({ ...f.options, request: async () => { throw new Error('upstream down'); } })).rejects.toThrow('upstream down');
        const files = workflow.pathsFor(f.options.mediaPath, f.options.config, require('./stream_activity_plan').getActivityConfig(f.options.config));
        expect(JSON.parse(fs.readFileSync(files.songs, 'utf8'))).toMatchObject({ status: 'failed', coverage: { status: 'incomplete' } });
        expect(songStatistics(f.dir)).toMatchObject({ inspectedSessions: 0, incompleteSessions: 1 });
        expect(f.renderPart).not.toHaveBeenCalled(); expect(fs.existsSync(files.lock)).toBe(false);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('one malformed boundary response is repaired from the complete original window', async () => {
    const f = fixture(); let malformed = true;
    try {
        const request = async (prompt, ...args) => {
            if (malformed) { malformed = false; return { text: JSON.stringify({ events: [{ kind: 'watch', start: -1, end: 1900 }] }) }; }
            return f.request(prompt, ...args);
        };
        const result = await workflow.generateStreamActivities({ ...f.options, request, planOnly: true });
        const plan = JSON.parse(fs.readFileSync(result.planPath, 'utf8'));
        expect(plan.coverage.status).toBe('complete');
        expect(f.request.mock.calls[0][0]).toContain('FORMAT/BOUNDARY REPAIR');
        expect(plan.events).toHaveLength(2);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('a hallucinated citation is repaired without losing the genuine in-core song', async () => {
    const f = fixture(); let malformed = true;
    try {
        const request = async (prompt, ...args) => {
            const response = await f.request(prompt, ...args);
            if (malformed) {
                malformed = false;
                const raw = JSON.parse(response.text); raw.events[0].evidenceIds.push('T999');
                return { text: JSON.stringify(raw) };
            }
            return response;
        };
        const result = await workflow.generateStreamActivities({ ...f.options, request, planOnly: true });
        expect(f.request.mock.calls[1][0]).toContain('unseen source citations: T999');
        expect(f.request.mock.calls[1][0]).toContain('numbers from a D row cannot be cited as T');
        expect(JSON.parse(fs.readFileSync(result.songsPath, 'utf8')).songs).toHaveLength(1);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('unverified singing candidates remain reviewable but do not become confirmed song statistics', async () => {
    const f = fixture();
    try {
        const result = await workflow.generateStreamActivities({ ...f.options, planOnly: true,
            verify: async event => ({ decision: 'uncertain', events: [{ ...event, reviewIssues: ['media_verification_unconfirmed'] }] }) });
        expect(JSON.parse(fs.readFileSync(result.songsPath, 'utf8')).songs[0].verificationStatus).toBe('uncertain');
        expect(songStatistics(f.dir)).toMatchObject({ inspectedSessions: 1, performances: 0, unverifiedPerformances: 1 });
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('restyling legacy pending packages reuses every video and detector result and is cached on restart', async () => {
    const f = fixture();
    try {
        const result = await workflow.generateStreamActivities(f.options);
        const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
        const originals = manifest.clips.map(row => JSON.parse(fs.readFileSync(row.metadataPath, 'utf8')));
        for (const row of originals) {
            delete row.presentation;
            row.copy.title = '旧版标题'; row.upload.prefix = '【小岁】';
            fs.writeFileSync(row.output.metadataPath, JSON.stringify(row));
        }
        const restyleOptions = { ...f.options, manifestPath: result.manifestPath };
        expect(await workflow.restyleStreamActivities(restyleOptions)).toMatchObject({ status: 'restyled', updated: 2 });
        const updated = manifest.clips.map(row => JSON.parse(fs.readFileSync(row.metadataPath, 'utf8')));
        expect(updated.map(row => row.upload.prefix)).toEqual(['【岁己歌切】', '【岁己同步视听】']);
        expect(updated.map(row => row.output.parts.map(part => [part.mediaPath, part.sha256, part.start, part.end])))
            .toEqual(originals.map(row => row.output.parts.map(part => [part.mediaPath, part.sha256, part.start, part.end])));
        expect(updated.every(row => !row.uploadReady && row.activityReview.status === 'pending')).toBe(true);
        expect(f.renderPart).toHaveBeenCalledTimes(5); expect(f.request).toHaveBeenCalledTimes(4);
        expect(f.options.cover).toHaveBeenCalledTimes(4);
        expect(await workflow.restyleStreamActivities(restyleOptions)).toMatchObject({ updated: 0 });
        expect(f.options.cover).toHaveBeenCalledTimes(4);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('restyling an approved package stops before generating covers or changing metadata', async () => {
    const f = fixture();
    try {
        const result = await workflow.generateStreamActivities(f.options);
        const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
        const metadataPath = manifest.clips[0].metadataPath;
        const row = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        row.activityReview.status = 'approved'; row.uploadReady = true;
        const original = JSON.stringify(row); fs.writeFileSync(metadataPath, original);
        await expect(workflow.restyleStreamActivities({ ...f.options, manifestPath: result.manifestPath }))
            .rejects.toThrow('explicit reviewed revision');
        expect(fs.readFileSync(metadataPath, 'utf8')).toBe(original);
        expect(f.options.cover).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
