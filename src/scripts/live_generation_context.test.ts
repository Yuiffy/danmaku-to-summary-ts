const fs = require('fs');
const os = require('os');
const path = require('path');
const liveContext = require('./live_generation_context');

describe('live_generation_context', () => {
  test('keeps source prefix stable when the late summary and task context change', () => {
    const source = '[speaker 0.9] Original live words.';
    const early = liveContext.buildSharedLiveSourcePrefix(source, '1', {}, { liveTitle: 'Live' });
    const late = liveContext.buildSharedLiveSourcePrefix(source, '1', {}, {
      liveTitle: 'Live', liveContent: { games: ['Verified game'] }
    });
    expect(late).toBe(early);
    expect(late).toContain(source);
    expect(late).not.toContain('Verified game');
  });

  test('writes and reuses versioned source artifacts, invalidating source and normalization changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-live-source-'));
    const input = path.join(dir, 'stream_AI_HIGHLIGHT.txt');
    try {
      fs.writeFileSync(input, 'Original words.');
      const first = liveContext.prepareSharedLiveSource(input, '1', {});
      const write = jest.spyOn(fs, 'writeFileSync');
      try {
        expect(liveContext.prepareSharedLiveSource(input, '1', {})).toEqual(first);
        expect(write).not.toHaveBeenCalled();
      } finally { write.mockRestore(); }
      fs.writeFileSync(input, 'Changed words.');
      const second = liveContext.prepareSharedLiveSource(input, '1', {});
      expect(second.payload.sourceSha256).not.toBe(first.payload.sourceSha256);
      const third = liveContext.prepareSharedLiveSource(input, '1', { asr: { corrections: { safe: { Changed: 'Corrected' } } } });
      expect(third.payload.sharedPrefix).toContain('Corrected words.');
      expect(third.payload.sourceSha256).not.toBe(second.payload.sourceSha256);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  const highlightPath = 'D:\\recordings\\录制-30655190-20260801-115716-543-明日方舟代抽⭐_AI_HIGHLIGHT.txt';

  test('extracts the exact live title and China-local recording time from the filename', () => {
    expect(liveContext.parseRecordingInfo(highlightPath)).toEqual({
      roomId: '30655190',
      liveTitle: '明日方舟代抽⭐',
      recordingStartTime: '2026-08-01T03:57:16.000Z',
      recordingStartLocalTime: '2026-08-01 11:57:16 UTC+8',
      titleSource: 'recording-filename'
    });
  });

  test('prefers nearby pre-stream dynamics and excludes post-stream dynamics', () => {
    const dynamics = liveContext.filterRecentDynamics([
      {
        id: 'after',
        publishTime: '2026-08-01T05:45:32.000Z',
        content: '三周年视频征集'
      },
      {
        id: 'nearby',
        publishTime: '2026-08-01T03:53:22.000Z',
        content: '来了来了来了！代抽明日方舟咯！今天起得有点精神的！放心冲锋！'
      },
      {
        id: 'older',
        publishTime: '2026-07-31T10:21:57.000Z',
        content: '哈咯又来代抽啦！明天中午12点准时开冲！'
      }
    ], '2026-08-01T03:57:16.000Z');

    expect(dynamics).toEqual([
      expect.objectContaining({ id: 'nearby', content: expect.stringContaining('明日方舟') })
    ]);
  });

  test('formats fact precedence and treats catchphrases as conditional hints', () => {
    const formatted = liveContext.formatLiveGenerationContext({
      liveTitle: '明日方舟代抽⭐',
      recordingStartLocalTime: '2026-08-01 11:57:16 UTC+8',
      recentDynamics: [{
        publishTime: '2026-08-01T03:53:22.000Z',
        content: '代抽明日方舟咯！'
      }],
      contentHints: [
        '孤立的“启动”在没有冲突证据时可理解为“原神启动”，但不能据此判断本场游戏。'
      ]
    });

    expect(formatted).toContain('直播标题：明日方舟代抽⭐');
    expect(formatted).toContain('开播时间（北京时间）：2026-08-01 11:57:16 UTC+8');
    expect(formatted).toContain('代抽明日方舟咯');
    expect(formatted).toContain('直播标题与明确语音 > 同场弹幕 > 开播前近期动态 > 稳定人设');
    expect(formatted).toContain('至少两类证据一致确认具体游戏/活动');
    expect(formatted).toContain('不得因为人物设定中的某款游戏或口头禅');
  });

  test('uses same-recording structured activity summary to constrain game identity', () => {
    const withGame = liveContext.formatLiveGenerationContext({
      liveTitle: '早安獭獭栞！',
      recordingStartLocalTime: '2026-08-23 10:00:22 UTC+8',
      liveContent: {
        overview: '玩《魔兽世界》做任务',
        activityTypes: ['game'],
        games: ['魔兽世界'],
        songs: [],
        topics: ['任务和装备']
      }
    });
    const withoutGame = liveContext.formatLiveGenerationContext({
      liveTitle: '早安獭獭栞！',
      recordingStartLocalTime: '2026-08-23 10:00:22 UTC+8',
      liveContent: {
        overview: '早间杂谈和唱歌',
        activityTypes: ['chat', 'singing'],
        games: [],
        songs: ['心墙'],
        topics: ['设备和睡眠']
      }
    });

    expect(withGame).toContain('本场明确实际游玩的游戏（涉及游戏时只能从此列表选择）：魔兽世界');
    expect(withGame).toContain('games 非空时，涉及游戏的脚本、截图请求和画面只能使用列表中的游戏名');
    expect(withoutGame).toContain('本场明确实际游玩的游戏：无');
    expect(withoutGame).toContain('不得仅凭聊天提及、观看视频片段或孤立ASR词语猜测具体游戏界面');
  });

  test('keeps title context when the optional dynamics lookup fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-context-'));
    const tempHighlight = path.join(tempDir, '录制-30655190-20260801-115716-543-明日方舟代抽⭐_AI_HIGHLIGHT.txt');
    try {
      const prepared = await liveContext.prepareLiveGenerationContext(
        tempHighlight,
        '30655190',
        {
          webhook: { port: 12523 },
          ai: {
            roomSettings: {
              '30655190': { uid: '1789460279' }
            }
          }
        },
        {
          fetcher: async () => {
            throw new Error('simulated network failure');
          }
        }
      );

      expect(prepared.context.liveTitle).toBe('明日方舟代抽⭐');
      expect(prepared.context.sources.recentDynamics).toBe('failed');
      expect(prepared.context.sources.replyDynamic).toBe('failed');
      expect(prepared.context.replyDynamic).toBeNull();
      expect(prepared.context.recentDynamics).toEqual([]);
      expect(fs.existsSync(prepared.outputPath)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('opportunistic reply dynamic context', () => {
  const start = '2026-08-01T03:57:16.000Z';
  const end = '2026-08-01T05:33:16.000Z';
  const now = '2026-08-01T06:05:00.000Z';
  const post = (id: string, publishTime: string, content = 'Resting after the stream.') => ({ id, publishTime, content });
  const target = post('target', '2026-08-01T05:45:00.000Z', 'Going to have noodles before bed.');
  let dir: string;
  let highlight: string;
  let srt: string;
  let config: any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-dynamic-'));
    highlight = path.join(dir, '录制-30655190-20260801-115716-543-测试_AI_HIGHLIGHT.txt');
    srt = highlight.replace('_AI_HIGHLIGHT.txt', '.srt');
    fs.writeFileSync(srt, '1\n01:35:58,000 --> 01:36:00,000\nStream ended.\n', 'utf8');
    config = { webhook: { port: 12523 }, ai: { roomSettings: { '30655190': { uid: '123' } } } };
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('selects the newest eligible post by time, not pinned order or goodnight keywords', () => {
    expect(liveContext.selectReplyDynamic([
      post('pinned', '2026-07-31T06:00:00.000Z'),
      post('early', '2026-08-01T04:00:00.000Z'),
      post('future', '2026-08-01T06:06:00.000Z'),
      post('invalid', 'bad-date'),
      post('near-end', '2026-08-01T05:05:00.000Z'), target
    ], start, end, now)).toEqual(target);
    expect(liveContext.selectReplyDynamic([post('boundary', '2026-08-01T05:03:16.000Z')], start, end, now)?.id)
      .toBe('boundary');
  });

  test.each([
    ['no end', start, null], ['invalid end', start, 'bad-date'], ['future end', start, '2026-08-01T07:00:00.000Z'],
    ['no start', null, end], ['end before start', end, start]
  ])('does not guess a reply target with %s', (_label, liveStart, liveEnd) => {
    expect(liveContext.selectReplyDynamic([target], liveStart, liveEnd, now)).toBeNull();
  });

  test('does not substitute an older text post for the actual newest image-only target', () => {
    expect(liveContext.selectReplyDynamic([target, post('image', '2026-08-01T06:00:00.000Z', '  ')], start, end, now))
      .toBeNull();
    expect(liveContext.selectReplyDynamic([post('old', '2026-08-01T04:59:00.000Z')], start, end, now)).toBeNull();
    expect(liveContext.selectReplyDynamic([target], '2026-08-01T05:46:00.000Z', '2026-08-01T05:50:00.000Z', now)).toBeNull();
  });

  test('bounds dynamic text without splitting Unicode characters', () => {
    const symbol = '\u{1f31f}';
    const selected = liveContext.selectReplyDynamic([post('long', target.publishTime, symbol.repeat(1300))], start, end, now);
    expect(Array.from(selected.content)).toHaveLength(1203);
    expect(selected.content).toBe(`${symbol.repeat(1200)}...`);
  });

  test('gets pre-stream context and an already-published reply target in one request', async () => {
    const before = post('announcement', '2026-08-01T03:53:00.000Z', 'Starting the stream soon.');
    const fetcher = jest.fn().mockResolvedValue({ success: true, data: { dynamics: [target, before] } });
    const prepared = await liveContext.prepareLiveGenerationContext(highlight, '30655190', config, { fetcher, now });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:12523/api/bilibili/dynamics/123', 5000);
    expect(prepared.context.recordingEndTime).toBe(end);
    expect(prepared.context.recentDynamics).toEqual([before]);
    expect(prepared.context.replyDynamic).toEqual(target);
    expect(prepared.context.sources.replyDynamic).toBe('matched');
    expect(liveContext.loadLiveGenerationContext(highlight, '30655190', config)).toEqual(prepared.context);
    expect(liveContext.formatLiveGenerationContext(prepared.context)).not.toContain(target.content);
    expect(liveContext.formatReplyDynamicContext(prepared.context)).toContain(target.content);
  });

  test('prefers media duration over the last spoken subtitle, including speaker SRTs', () => {
    fs.writeFileSync(srt.replace('.srt', '.asr_meta.json'), JSON.stringify({ mediaDurationSeconds: 7200 }));
    expect(liveContext.resolveRecordingEndTime(highlight, start, { srtPath: srt.replace('.srt', '.speaker.srt'), now }))
      .toBe('2026-08-01T05:57:16.000Z');
    expect(liveContext.resolveRecordingEndTime(highlight, start, { liveEndTime: end, now })).toBe(end);
    fs.writeFileSync(srt.replace('.srt', '.asr_meta.json'), '{broken-json');
    expect(liveContext.resolveRecordingEndTime(highlight, start, { now })).toBe(end);
  });

  test('does not wait or poll when the post is not available yet', async () => {
    const fetcher = jest.fn().mockResolvedValue({ success: true, data: { dynamics: [] } });
    const prepared = await liveContext.prepareLiveGenerationContext(highlight, '30655190', config, { fetcher, now });
    expect(prepared.context.replyDynamic).toBeNull();
    expect(prepared.context.sources.replyDynamic).toBe('not-found');
    expect(liveContext.formatReplyDynamicContext(prepared.context)).toBe('');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('skips reply personalization when recording duration is missing instead of using file mtime', async () => {
    fs.unlinkSync(srt);
    const fetcher = jest.fn().mockResolvedValue({ success: true, data: { dynamics: [target] } });
    const prepared = await liveContext.prepareLiveGenerationContext(highlight, '30655190', config, { fetcher, now });
    expect(prepared.context.recordingEndTime).toBeNull();
    expect(prepared.context.replyDynamic).toBeNull();
    expect(prepared.context.sources.replyDynamic).toBe('skipped-no-end-time');
  });

  test.each(['disabled', 'missing-uid'])('makes no request when %s', async reason => {
    if (reason === 'disabled') config.ai.generationContext = { recentDynamics: { enabled: false } };
    else config.ai.roomSettings = {};
    const fetcher = jest.fn();
    const prepared = await liveContext.prepareLiveGenerationContext(highlight, '30655190', config, { fetcher, now });
    expect(prepared.context.replyDynamic).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('clears an earlier snapshot on lookup failure without breaking context preparation', async () => {
    const fetcher = jest.fn().mockResolvedValueOnce({ success: true, data: { dynamics: [target] } })
      .mockResolvedValueOnce({ success: false, error: 'Unavailable' });
    await liveContext.prepareLiveGenerationContext(highlight, '30655190', config, { fetcher, now });
    const prepared = await liveContext.prepareLiveGenerationContext(highlight, '30655190', config, { fetcher, now });
    expect(prepared.context.replyDynamic).toBeNull();
    expect(prepared.context.sources.replyDynamic).toBe('failed');
    expect(prepared.context.recentDynamicsError).toBe('Unavailable');
  });

  test('bounds the entire optional request even when the response keeps trickling data', async () => {
    jest.useFakeTimers();
    const { EventEmitter } = require('events');
    const http = require('http');
    const request = new EventEmitter();
    request.destroy = jest.fn(error => { request.emit('error', error); request.emit('close'); });
    const response = new EventEmitter();
    response.statusCode = 200;
    response.setEncoding = jest.fn();
    const get = jest.spyOn(http, 'get').mockImplementation((_url, _options, callback: any) => {
      callback(response);
      return request;
    });
    config.ai.generationContext = { recentDynamics: { timeoutMs: 50 } };
    const pending = liveContext.prepareLiveGenerationContext(highlight, '30655190', config, { now });
    response.emit('data', '{');
    await jest.advanceTimersByTimeAsync(40);
    response.emit('data', ' ');
    await jest.advanceTimersByTimeAsync(10);
    const prepared = await pending;
    expect(prepared.context.replyDynamic).toBeNull();
    expect(prepared.context.sources.replyDynamic).toBe('failed');
    expect(prepared.context.recentDynamicsError).toContain('50ms');
    expect(get).toHaveBeenCalledTimes(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
