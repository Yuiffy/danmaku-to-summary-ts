const configLoader = require('./config-loader');
const topicClipper = require('./topic_clipper');
const backgroundClipRunner = require('./background_clip_runner');

describe('background_clip_runner', () => {
  test('absent archive kinds complete once and remain completed on a later invocation', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-absent-'));
    const payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: 'source.flv', srtPath: 'source.srt', roomId: '1' }));
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({ clipTopics: { enabled: false }, ownStreamClips: { enabled: false } });
    const activities = jest.spyOn(require('./clipping/stream_activity_clipper'), 'generateStreamActivities')
      .mockResolvedValue({ status: 'no_activities', submissions: 0, parts: 0 });
    const games = jest.spyOn(require('./clipping/stream_game_clipper'), 'generateStreamGames')
      .mockResolvedValue({ status: 'no_gameplay', submissions: 0, parts: 0 });
    try {
      await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
      const state = JSON.parse(fs.readFileSync(`${payloadPath}.progress.json`, 'utf8'));
      expect(state.status).toBe('completed');
      expect(state.completed.games.status).toBe('no_gameplay');
      expect(state.completed.songs.status).toBe('no_activities');
      expect(state.completed.watch.status).toBe('no_activities');
      await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
      expect(activities).toHaveBeenCalledTimes(2); expect(games).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('repairs final campaign coverage before reservation and stops selection when repair fails', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'background-map-preflight-'));
    const media = path.join(root, 'recording_merged.flv'), xml = path.join(root, 'recording.xml');
    fs.writeFileSync(xml, '<i/>');
    const own = require('./own_stream_clipper');
    const coverage = require('../core/media/RecordingCoverage.ts');
    const campaign = require('./workflow-runtime').loadWorkflow('clipping/ownCampaign');
    const repair = jest.spyOn(require('./recording_map_recovery.ts'), 'ensureRecordingMap').mockResolvedValue(undefined);
    const reserve = jest.spyOn(coverage, 'reserveFinalCampaign').mockImplementation(() => {});
    jest.spyOn(coverage, 'filterCampaignCoverage').mockImplementation((clips: unknown) => clips);
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({ ownStreamClips: { campaigns: [{ id: 'game', earlyTrigger: { enabled: true } }] } });
    jest.spyOn(own, 'getOwnStreamClipsConfig').mockReturnValue({ enabled: true, roomIds: ['1'], campaignContentGate: { id: 'game' } });
    jest.spyOn(campaign, 'ensureCampaignContent').mockResolvedValue({ allowed: true });
    const generate = jest.spyOn(own, 'generateOwnStreamClips').mockResolvedValue([]);
    try {
      await backgroundClipRunner.generateOwnStreamClipsForMedia(media, 'source.srt', xml, '1');
      expect(repair).toHaveBeenCalledWith(media);
      expect(repair.mock.invocationCallOrder[0]).toBeLessThan(reserve.mock.invocationCallOrder[0]);
      repair.mockRejectedValueOnce(new Error('source packets do not match'));
      await expect(backgroundClipRunner.generateOwnStreamClipsForMedia(media, 'source.srt', xml, '1')).rejects.toThrow('source packets');
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('each recording job refreshes saved mode settings before loading its config snapshot', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-mode-settings-'));
    const clear = jest.spyOn(configLoader, 'clearCache');
    const get = jest.spyOn(configLoader, 'getConfig').mockReturnValue({ clipTopics: { enabled: true,
      editorialStyles: { enabled: true, mode: 'ordinary' } }, ownStreamClips: { enabled: false } });
    const topic = jest.spyOn(topicClipper, 'generateTopicClips').mockResolvedValue([]);
    jest.spyOn(require('./clipping/stream_activity_clipper'), 'generateStreamActivities').mockResolvedValue({ status: 'empty' });
    jest.spyOn(require('./clipping/stream_game_clipper'), 'generateStreamGames').mockResolvedValue({ status: 'empty' });
    try {
      for (const mode of ['ordinary', 'precision']) {
        get.mockReturnValue({ clipTopics: { enabled: true, editorialStyles: { enabled: true, mode } }, ownStreamClips: { enabled: false } });
        const payloadPath = path.join(dir, `${mode}.json`);
        fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: 'source.mp4', srtPath: 'source.srt', roomId: '12' }));
        await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
        expect(topic.mock.calls.at(-1)[0].config.clipTopics.editorialStyles.mode).toBe(mode);
      }
      expect(clear).toHaveBeenCalledTimes(2);
      expect(clear.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('expired game campaign stops only own highlights and still executes the original keyword stage', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-campaign-keywords-'));
    const media = path.join(dir, 'recording.flv'), payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(media, 'source');
    fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: media, srtPath: 'source.srt', roomId: 'event' }));
    const root = { clipTopics: { enabled: true, keywords: ['岁己'] }, ownStreamClips: { enabled: true, roomIds: ['regular'],
      campaigns: [{ enabled: true, roomIds: ['event'], startsAt: '2000-01-01T00:00:00Z', endsAt: '2000-01-02T00:00:00Z' }] } };
    jest.spyOn(configLoader, 'getConfig').mockReturnValue(root);
    const keyword = jest.spyOn(topicClipper, 'generateTopicClips').mockResolvedValue([]);
    const own = jest.spyOn(require('./own_stream_clipper'), 'generateOwnStreamClips');
    jest.spyOn(require('./clipping/stream_activity_clipper'), 'generateStreamActivities').mockResolvedValue({ status: 'empty' });
    jest.spyOn(require('./clipping/stream_game_clipper'), 'generateStreamGames').mockResolvedValue({ status: 'empty' });
    try {
      expect(backgroundClipRunner.shouldRunAnyClipper('event', null)).toBe(true);
      await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
      expect(keyword).toHaveBeenCalledTimes(1);
      expect(own).not.toHaveBeenCalled();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test.each([[], ['其他游戏']].map(games => ({ games })))('a non-game campaign skips own selection and notifications while keyword clips continue ($games)', async ({ games }) => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const { createHash } = require('crypto');
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-game-campaign-'));
    const media = path.join(dir, '录制-1967216004-20261023-160324-272-我魂！.flv'), srt = path.join(dir, 'recording.srt'), xml = path.join(dir, 'recording.xml');
    const payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(srt, 'srt'); fs.writeFileSync(xml, 'xml');
    fs.writeFileSync(path.join(dir, 'recording_FULL_LIVE_CONTEXT.json'), JSON.stringify({ schemaVersion: 1, roomId: 'event',
      sourceText: 'source', sharedPrefix: 'prefix', sourceSha256: hash('source'), sharedPrefixSha256: hash('prefix'),
      inputSources: { srtSha256: hash('srt'), xmlSha256: hash('xml') } }));
    fs.writeFileSync(path.join(dir, 'recording_LIVE_CONTENT.json'), JSON.stringify({ schemaVersion: 1, status: 'success', roomId: 'event',
      source: { promptVersion: 2, coverage: 'full_srt_and_merged_danmaku', sourceSha256: hash('source'), sharedPrefixSha256: hash('prefix') },
      content: { games, overview: '明天玩芙娅之魂，今天唱歌', topics: ['芙娅之魂'] } }));
    fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: media, srtPath: srt, xmlPath: xml, roomId: 'event',
      fullLiveContextPath: path.join(dir, 'recording_FULL_LIVE_CONTEXT.json'), liveContentSummaryPath: path.join(dir, 'recording_LIVE_CONTENT.json') }));
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({ clipTopics: { enabled: true }, ownStreamClips: { enabled: true,
      campaigns: [{ id: 'fuya', enabled: true, roomIds: ['event'], requiredGames: ['芙娅之魂'],
        startsAt: '2026-01-01T00:00:00+08:00', endsAt: '2100-01-01T00:00:00+08:00' }] } });
    const keyword = jest.spyOn(topicClipper, 'generateTopicClips').mockResolvedValue([]);
    const own = jest.spyOn(require('./own_stream_clipper'), 'generateOwnStreamClips');
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(require('./clipping/stream_activity_clipper'), 'generateStreamActivities').mockResolvedValue({ status: 'empty' });
    jest.spyOn(require('./clipping/stream_game_clipper'), 'generateStreamGames').mockResolvedValue({ status: 'empty' });
    try {
      await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
      expect(keyword).toHaveBeenCalledTimes(1);
      expect(own).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join('\n')).toContain('本场未实际游玩活动游戏');
      expect(log.mock.calls.flat().join('\n')).not.toContain('开始岁己直播有趣切片');
      expect(fs.existsSync(path.join(dir, 'own_stream_fun_clips'))).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a recording-scoped job replaces ordinary stages, keeps source, and is not repeated after completion', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const jobs = require('./recording_clip_job.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-scoped-'));
    const media = path.join(dir, 'recording.flv'), payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(media, 'source');
    fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: media, roomId: '12', videoPathToDelete: media }));
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({ clipTopics: { enabled: true } });
    jest.spyOn(jobs, 'resolveRecordingClipJob').mockReturnValue({ id: 'test' });
    const execute = jest.spyOn(jobs, 'executeRecordingClipJob').mockRejectedValueOnce(new Error('adapter failed')).mockResolvedValue(undefined);
    const ordinary = jest.spyOn(topicClipper, 'generateTopicClips');
    try {
      await expect(backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath)).rejects.toThrow('adapter failed');
      expect(fs.existsSync(media)).toBe(true);
      expect(ordinary).not.toHaveBeenCalled();
      await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
      await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(ordinary).not.toHaveBeenCalled();
      expect(fs.existsSync(media)).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('song/viewing workflow triggers for Sui even when highlight clippers and XML are absent', () => {
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({
      clipTopics: { enabled: false }, ownStreamClips: { enabled: false },
      streamActivityClips: { enabled: true, roomIds: ['25788785'] }
    });
    expect(backgroundClipRunner.shouldRunAnyClipper('25788785', null)).toBe(true);
    expect(backgroundClipRunner.shouldRunAnyClipper('22470216', null)).toBe(false);
  });

  test('activity failure preserves the recording while existing stages continue', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const activity = require('./clipping/stream_activity_clipper');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-activity-'));
    const media = path.join(dir, 'recording.flv'), payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(media, 'source');
    fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: media, srtPath: 'source.srt', roomId: '25788785', videoPathToDelete: media }));
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({ clipTopics: { enabled: false }, ownStreamClips: { enabled: false } });
    jest.spyOn(activity, 'generateStreamActivities').mockRejectedValue(new Error('activity detection unavailable'));
    try {
      await expect(backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath)).rejects.toThrow('Archive stages incomplete');
      expect(fs.existsSync(media)).toBe(true);
      expect(fs.existsSync(payloadPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(`${payloadPath}.progress.json`, 'utf8')).status).toBe('failed');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('successful activity rendering preserves its source until human review', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const activity = require('./clipping/stream_activity_clipper');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-activity-review-'));
    const media = path.join(dir, 'recording.flv'), payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(media, 'source');
    fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: media, srtPath: 'source.srt', roomId: '25788785', videoPathToDelete: media }));
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({ clipTopics: { enabled: false }, ownStreamClips: { enabled: false } });
    jest.spyOn(activity, 'generateStreamActivities').mockResolvedValue({ status: 'rendered', submissions: 2, pendingReview: true });
    try {
      await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
      expect(fs.readFileSync(media, 'utf8')).toBe('source');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test.each(['25788785', '22470216', 'event'])('automatic publication retains only its allowlisted source (%s)', async roomId => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const activity = require('./clipping/stream_activity_clipper');
    const games = require('./clipping/stream_game_clipper');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-publication-'));
    const media = path.join(dir, 'recording.flv'), payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(media, 'source');
    fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: media, srtPath: 'source.srt', roomId, videoPathToDelete: media }));
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({ clipTopics: { enabled: false },
      ownStreamClips: { enabled: false, automaticPublication: { mode: 'auto', roomIds: ['25788785'] },
        campaigns: [{ enabled: true, roomIds: ['event'], startsAt: '2000-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z',
          settings: { automaticPublication: { mode: 'auto', roomIds: ['event'] } } }] } });
    jest.spyOn(activity, 'generateStreamActivities').mockResolvedValue({ status: 'empty' });
    jest.spyOn(games, 'generateStreamGames').mockResolvedValue({ status: 'empty' });
    try {
      await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
      expect(fs.existsSync(media)).toBe(roomId !== '22470216');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test.each([
    ['22470216', true, 'auto', true],
    ['25788785', true, 'auto', false],
    ['22470216', false, 'auto', false],
    ['22470216', true, 'off', false]
  ])('keyword publication preserves its eligible source (%s, enabled=%s, mode=%s)', async (roomId, enabled, mode, retained) => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const activity = require('./clipping/stream_activity_clipper');
    const games = require('./clipping/stream_game_clipper');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-topic-publication-'));
    const media = path.join(dir, 'recording.flv'), payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(media, 'source');
    fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: media, srtPath: 'source.srt', roomId, videoPathToDelete: media }));
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({
      clipTopics: { enabled, keywords: ['岁己'], ignoredRoomIds: ['25788785'],
        automaticPublication: { mode, scope: 'configured_keywords', policyVersion: 'topic-v1' } },
      ownStreamClips: { enabled: false }
    });
    jest.spyOn(topicClipper, 'generateTopicClips').mockResolvedValue([]);
    jest.spyOn(activity, 'generateStreamActivities').mockResolvedValue({ status: 'empty' });
    jest.spyOn(games, 'generateStreamGames').mockResolvedValue({ status: 'empty' });
    try {
      await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
      expect(fs.existsSync(media)).toBe(retained);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('finishes ordinary clips before songs, games and viewing, continuing after a song failure', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const activity = require('./clipping/stream_activity_clipper');
    const games = require('./clipping/stream_game_clipper');
    const own = require('./own_stream_clipper');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-priority-'));
    const media = path.join(dir, 'recording.flv'), xml = path.join(dir, 'recording.xml');
    const payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(media, 'source'); fs.writeFileSync(xml, '<i/>');
    fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: media, srtPath: 'source.srt',
      xmlPath: xml, roomId: '25788785', videoPathToDelete: media }));
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({ clipTopics: { enabled: true },
      ownStreamClips: { enabled: true, roomIds: ['25788785'] } });
    const order: string[] = [];
    let releaseOrdinary!: () => void;
    const ordinaryGate = new Promise<void>(resolve => { releaseOrdinary = resolve; });
    let releaseGame!: () => void;
    const gameGate = new Promise<void>(resolve => { releaseGame = resolve; });
    let startedGame!: () => void;
    const gameStarted = new Promise<void>(resolve => { startedGame = resolve; });
    jest.spyOn(topicClipper, 'generateTopicClips').mockImplementation(async () => {
      order.push('topic'); return [];
    });
    jest.spyOn(own, 'generateOwnStreamClips').mockImplementation(async () => {
      order.push('ordinary-start'); await ordinaryGate; order.push('ordinary-finished'); return [];
    });
    jest.spyOn(activity, 'generateStreamActivities').mockImplementation(async (...args: unknown[]) => {
      const kind = (args[0] as { kind: string }).kind;
      order.push(kind);
      if (kind === 'songs') throw new Error('Song timeline unavailable');
      return { status: 'empty' };
    });
    jest.spyOn(games, 'generateStreamGames').mockImplementation(async () => {
      order.push('games-start'); startedGame(); await gameGate; order.push('games-finished');
      return { status: 'empty' };
    });
    const task = backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(order).toEqual(['topic', 'ordinary-start']);
      releaseOrdinary();
      await gameStarted;
      expect(order).toEqual(['topic', 'ordinary-start', 'ordinary-finished', 'songs', 'games-start']);
      releaseGame();
      await expect(task).rejects.toThrow('Archive stages incomplete');
      expect(order).toEqual(['topic', 'ordinary-start', 'ordinary-finished', 'songs', 'games-start', 'games-finished', 'watch']);
      expect(fs.readFileSync(media, 'utf8')).toBe('source');
      expect(fs.existsSync(payloadPath)).toBe(true);
      const retry = jest.spyOn(activity, 'generateStreamActivities').mockResolvedValue({ status: 'empty' });
      retry.mockClear();
      await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(retry.mock.calls[0][0].kind).toBe('songs');
      expect(order.filter(value => value === 'topic')).toHaveLength(1);
      retry.mockClear();
      await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
      expect(retry).not.toHaveBeenCalled();
    } finally {
      releaseOrdinary(); releaseGame(); await task.catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('failed own selection remains resumable while successful archives are reused on retry', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-own-retry-'));
    const media = path.join(dir, 'recording.flv'), xml = path.join(dir, 'recording.xml');
    const payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(media, 'source'); fs.writeFileSync(xml, '<i/>');
    fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: media, srtPath: 'source.srt',
      xmlPath: xml, roomId: '25788785', videoPathToDelete: media }));
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({ clipTopics: { enabled: true },
      ownStreamClips: { enabled: true, roomIds: ['25788785'] } });
    const topic = jest.spyOn(topicClipper, 'generateTopicClips').mockResolvedValue([]);
    const own = jest.spyOn(require('./own_stream_clipper'), 'generateOwnStreamClips')
      .mockRejectedValueOnce(new Error('Invalid ranked selection size')).mockResolvedValue([]);
    const activity = jest.spyOn(require('./clipping/stream_activity_clipper'), 'generateStreamActivities')
      .mockResolvedValue({ status: 'empty' });
    const games = jest.spyOn(require('./clipping/stream_game_clipper'), 'generateStreamGames')
      .mockResolvedValue({ status: 'empty' });
    try {
      await expect(backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath)).rejects.toThrow('Invalid ranked selection size');
      const failed = JSON.parse(fs.readFileSync(`${payloadPath}.progress.json`, 'utf8'));
      expect(failed.status).toBe('failed');
      expect(failed.completed).not.toHaveProperty('own');
      expect(failed.completed).toEqual({ topics: [], songs: { status: 'empty' },
        games: { status: 'empty' }, watch: { status: 'empty' } });
      expect(fs.readFileSync(media, 'utf8')).toBe('source');
      expect(activity.mock.calls.map(call => call[0].kind)).toEqual(['songs', 'watch']);
      expect(games).toHaveBeenCalledTimes(1);

      await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
      const completed = JSON.parse(fs.readFileSync(`${payloadPath}.progress.json`, 'utf8'));
      expect(completed.status).toBe('completed');
      expect(completed).not.toHaveProperty('lastError');
      expect(completed.completed.own).toEqual([]);
      expect(own).toHaveBeenCalledTimes(2);
      expect(topic).toHaveBeenCalledTimes(1);
      expect(activity).toHaveBeenCalledTimes(2);
      expect(games).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('direct own selection keeps its fallback while early campaign failures still propagate', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-own-direct-'));
    const media = path.join(dir, 'recording.flv'), xml = path.join(dir, 'recording.xml');
    fs.writeFileSync(xml, '<i/>');
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({ ownStreamClips: { enabled: true, roomIds: ['25788785'] } });
    jest.spyOn(require('./own_stream_clipper'), 'generateOwnStreamClips').mockRejectedValue(new Error('selection failed'));
    try {
      await expect(backgroundClipRunner.generateOwnStreamClipsForMedia(media, 'source.srt', xml, '25788785')).resolves.toEqual([]);
      await expect(backgroundClipRunner.generateOwnStreamClipsForMedia(media, 'source.srt', xml, '25788785',
        { earlyCampaign: true })).rejects.toThrow('selection failed');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('notifies a fatal topic clipping failure and resolves so later stages can continue', async () => {
    const config = {
      clipTopics: {
        enabled: true,
        outputDirName: 'topic_clips',
        notify: { enabled: true }
      },
      ai: {
        roomSettings: {
          '26966466': { anchorName: '小栞' }
        }
      }
    };
    jest.spyOn(configLoader, 'getConfig').mockReturnValue(config);
    jest.spyOn(topicClipper, 'generateTopicClips').mockRejectedValue(new Error('fatal topic failure'));
    const notifyTopicClipFailure = jest
      .spyOn(topicClipper, 'notifyTopicClipFailure')
      .mockResolvedValue(true);

    await expect(backgroundClipRunner.generateTopicClipsForMedia(
      'D:\\recordings\\录制-26966466-20260805-102031-440-早安獭獭栞！.flv',
      null,
      'D:\\recordings\\recording.srt',
      '26966466',
      {}
    )).resolves.toEqual([]);

    expect(notifyTopicClipFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'fatal topic failure' }),
      expect.objectContaining({
        streamerName: '小栞',
        roomId: '26966466',
        stage: 'topic_clipper'
      }),
      config
    );
  });
});
