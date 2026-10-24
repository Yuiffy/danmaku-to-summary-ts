export {};
const fs = require('fs'), os = require('os'), path = require('path');
const workflow = require('./stream_game_clipper'), visual = require('./stream_game_visual');

test.each([120, 4000])('complete empty game detection over %s seconds finishes and resumes without media work', async duration => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'game-absence-'));
    const mediaPath = path.join(directory, '录制-25788785-20261015-230031-000-聊天.flv');
    const srtPath = mediaPath.replace('.flv', '.srt');
    fs.writeFileSync(mediaPath, 'fixture');
    fs.writeFileSync(srtPath, '1\n00:00:01,000 --> 00:00:04,000\n今天聊聊日常\n');
    const audit = jest.spyOn(visual, 'auditGameTimeline').mockRejectedValue(new Error('visual extraction must not run'));
    const request = jest.fn(async () => ({ text: '{"events":[]}' }));
    const options = { mediaPath, srtPath, config: { streamGameClips: { enabled: true } }, probe: async () => duration, request };
    try {
        const result = await workflow.generateStreamGames(options);
        expect(result).toMatchObject({ status: 'no_gameplay', submissions: 0, parts: 0 });
        const plan = JSON.parse(fs.readFileSync(result.planPath, 'utf8'));
        expect(plan).toMatchObject({ status: 'planned', events: [], coverage: { status: 'complete' } });
        expect(plan.coverage.windows).toHaveLength(Math.ceil(duration / 1800));
        expect(audit).not.toHaveBeenCalled();
        await workflow.generateStreamGames(options);
        expect(request).toHaveBeenCalledTimes(Math.ceil(duration / 1800));
        expect(audit).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(path.dirname(result.planPath), 'UPLOAD_MANIFEST.json'))).toBe(false);
    } finally { audit.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('missing transcripts and failed detection remain failures rather than absence', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'game-unknown-'));
    const mediaPath = path.join(directory, 'recording.flv'), srtPath = path.join(directory, 'recording.srt');
    fs.writeFileSync(mediaPath, 'fixture'); fs.writeFileSync(srtPath, '');
    const request = jest.fn(async () => { throw new Error('HTTP 502'); });
    const options = { mediaPath, srtPath, context: { roomId: '25788785' },
        config: { streamGameClips: { enabled: true } }, probe: async () => 120, request };
    try {
        await expect(workflow.generateStreamGames(options)).rejects.toThrow('coverage is unknown');
        expect(request).not.toHaveBeenCalled();
        fs.writeFileSync(srtPath, '1\n00:00:01,000 --> 00:00:04,000\n今天聊聊日常\n');
        await expect(workflow.generateStreamGames(options)).rejects.toThrow('HTTP 502');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('detected gameplay still requires the independent visual audit', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'game-present-'));
    const mediaPath = path.join(directory, 'recording.flv'), srtPath = path.join(directory, 'recording.srt');
    fs.writeFileSync(mediaPath, 'fixture');
    fs.writeFileSync(srtPath, '1\n00:00:10,000 --> 00:00:14,000\n开始玩艾尔登法环\n');
    const failure = new Error('actual visual evidence is unavailable');
    const audit = jest.spyOn(visual, 'auditGameTimeline').mockRejectedValue(failure);
    const options = { mediaPath, srtPath, context: { roomId: '25788785' },
        config: { streamGameClips: { enabled: true } }, probe: async () => 120,
        request: async () => ({ events: [{ gameId: 'elden-ring', start: 10, end: 90,
            startObserved: true, endObserved: true, evidenceIds: ['T1'], chapters: [], excludedRanges: [] }] }) };
    try {
        await expect(workflow.generateStreamGames(options)).rejects.toBe(failure);
        expect(audit).toHaveBeenCalledTimes(1);
    } finally { audit.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
});
