const configLoader = require('./config-loader');
const topicClipper = require('./topic_clipper');
const backgroundClipRunner = require('./background_clip_runner');

describe('background_clip_runner', () => {
  afterEach(() => {
    jest.restoreAllMocks();
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

  test.each(['25788785', '22470216'])('automatic publication retains only its allowlisted source (%s)', async roomId => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const activity = require('./clipping/stream_activity_clipper');
    const games = require('./clipping/stream_game_clipper');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-publication-'));
    const media = path.join(dir, 'recording.flv'), payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(media, 'source');
    fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: media, srtPath: 'source.srt', roomId, videoPathToDelete: media }));
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({ clipTopics: { enabled: false },
      ownStreamClips: { enabled: false, automaticPublication: { mode: 'auto', roomIds: ['25788785'] } } });
    jest.spyOn(activity, 'generateStreamActivities').mockResolvedValue({ status: 'empty' });
    jest.spyOn(games, 'generateStreamGames').mockResolvedValue({ status: 'empty' });
    try {
      await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
      expect(fs.existsSync(media)).toBe(roomId === '25788785');
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
