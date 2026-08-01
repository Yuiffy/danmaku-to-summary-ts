const fs = require('fs');
const os = require('os');
const path = require('path');
const liveContext = require('./live_generation_context');

describe('live_generation_context', () => {
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
      expect(prepared.context.recentDynamics).toEqual([]);
      expect(fs.existsSync(prepared.outputPath)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
