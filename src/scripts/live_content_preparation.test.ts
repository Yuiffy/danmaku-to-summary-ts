export {};

const fs = require('fs'), os = require('os'), path = require('path');
const { createHash } = require('crypto');
const loader = require('./config-loader');
const summary = require('./live_content_summary');
const own = require('./own_stream_clipper');
const runner = require('./background_clip_runner');

afterEach(() => jest.restoreAllMocks());

test.each([{ games: ['芙娅之魂'] }, { games: [] }])('campaign without room summary settings waits for source-bound evidence ($games)', async ({ games }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-prerequisite-'));
    const media = path.join(dir, '录制-1967216004-20261023-160324-272-我魂！.flv');
    const base = media.slice(0, -4), srt = base + '.srt', xml = base + '.xml';
    const payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:04,000\n开始游戏\n');
    fs.writeFileSync(xml, '<i><d p="2,1,25,16777215,1,0,test,1">游戏名：芙娅之魂</d></i>');
    fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: media, srtPath: srt, xmlPath: xml, roomId: '1967216004' }));
    const root = { clipTopics: { enabled: false }, ownStreamClips: { enabled: true,
        campaigns: [{ id: 'fuya', enabled: true, roomIds: ['1967216004'], requiredGames: ['芙娅之魂'],
            startsAt: '2026-01-01T00:00:00+08:00', endsAt: '2100-01-01T00:00:00+08:00' }] } };
    jest.spyOn(loader, 'getConfig').mockReturnValue(root);
    jest.spyOn(require('./clipping/stream_activity_clipper'), 'generateStreamActivities').mockResolvedValue({ status: 'disabled' });
    jest.spyOn(require('./clipping/stream_game_clipper'), 'generateStreamGames').mockResolvedValue({ status: 'disabled' });
    const produce = jest.spyOn(own, 'generateOwnStreamClips').mockResolvedValue([]);
    let ready!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const generate = jest.spyOn(summary, 'generateLiveContentSummary').mockImplementation(async (options: any) => {
        ready(); await gate;
        const context = JSON.parse(fs.readFileSync(options.fullLiveContextPath, 'utf8'));
        const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        expect(context.inputSources).toMatchObject({ srtSha256: hash(srt), xmlSha256: hash(xml) });
        expect(options.experiment).toMatchObject({ enabled: true, tasks: ['summary'] });
        fs.writeFileSync(options.outputPath, JSON.stringify({ schemaVersion: 1, roomId: '1967216004', status: 'success',
            source: { promptVersion: 2, coverage: 'full_srt_and_merged_danmaku',
                sourceSha256: context.sourceSha256, sharedPrefixSha256: context.sharedPrefixSha256 }, content: { games } }));
    });
    const task = runner.runBackgroundClipsFromPayload(payloadPath);
    try {
        await started;
        expect(produce).not.toHaveBeenCalled();
        release(); await task;
        expect(produce).toHaveBeenCalledTimes(games.length ? 1 : 0);
        expect(root).not.toHaveProperty('ai');
        await runner.runBackgroundClipsFromPayload(payloadPath);
        expect(generate).toHaveBeenCalledTimes(1);
    } finally { release(); await task.catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed campaign summary leaves a retryable task and keeps the source', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-unavailable-'));
    const media = path.join(dir, '录制-1967216004-20261023-160324-272-我魂！.flv');
    const srt = media + '.srt', xml = media + '.xml', payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(media, 'source'); fs.writeFileSync(srt, 'srt'); fs.writeFileSync(xml, 'xml');
    fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: media, srtPath: srt, xmlPath: xml,
        roomId: '1967216004', videoPathToDelete: media }));
    jest.spyOn(loader, 'getConfig').mockReturnValue({ clipTopics: { enabled: false }, ownStreamClips: { enabled: true,
        campaigns: [{ id: 'fuya', enabled: true, roomIds: ['1967216004'], requiredGames: ['芙娅之魂'],
            startsAt: '2026-01-01T00:00:00+08:00', endsAt: '2100-01-01T00:00:00+08:00' }] } });
    jest.spyOn(require('./live_content_preparation'), 'prepareCampaignContentSummary').mockRejectedValue(new Error('provider unavailable'));
    const produce = jest.spyOn(own, 'generateOwnStreamClips');
    try {
        await expect(runner.runBackgroundClipsFromPayload(payloadPath)).rejects.toThrow('provider unavailable');
        expect(produce).not.toHaveBeenCalled();
        expect(fs.readFileSync(media, 'utf8')).toBe('source');
        expect(JSON.parse(fs.readFileSync(payloadPath + '.progress.json', 'utf8')).status).toBe('failed');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
