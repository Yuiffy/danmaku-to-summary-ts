const fs = require('fs');
const os = require('os');
const path = require('path');

const fullLiveContext = require('./full_live_context');
const liveContentSummary = require('./live_content_summary');
const liveGenerationContext = require('./live_generation_context');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'live-content-summary-'));
}

function makeExperiment(overrides = {}) {
  return {
    enabled: true,
    tasks: ['summary'],
    summaryDeliveryMode: 'separate',
    promptCacheRolloutPercent: 100,
    maxAttempts: 1,
    ...overrides
  };
}

function writeFullContext(highlightPath: string) {
  const context = fullLiveContext.buildFullLiveSharedContext({
    parsed: {
      segments: [
        { start: 1, end: 4, text: '今天先聊妈妈做的火烧云' },
        { start: 65, end: 70, text: '接下来唱一首小幸运' }
      ]
    },
    danmaku: [
      { time: 2, text: '火烧云是什么', uid: 'a' },
      { time: 66, text: '好听', uid: 'b' }
    ],
    config: { fullContextDanmakuMergeWindowSeconds: 30 },
    info: { streamTitle: '测试直播', recordedAt: '2026-08-11 20:00:00' },
    totalDuration: 70
  });
  return fullLiveContext.saveFullLiveContextSidecar(highlightPath, context);
}

describe('live_content_summary', () => {
  test('scopes the two full-input experiments without widening the global cache rollout', () => {
    const production = require('../../config/production.json');

    expect(production.ai.text.sharedPromptCache.explicitRolloutPercent).toBe(10);
    expect(production.ai.comic.storytellingExperiment.immersivePercent).toBe(60);
    expect(production.ai.roomSettings['26966466'].storytellingExperiment).toBeUndefined();
    expect(production.ai.roomSettings['25788785'].fullLiveContextExperiment).toEqual(
      expect.objectContaining({
        tasks: ['summary', 'ownStreamClips'],
        summaryDeliveryMode: 'separate',
        promptCacheRolloutPercent: 100
      })
    );
    expect(production.ai.roomSettings['25788785'].fullLiveContextExperiment.cachePropagationWaitMs)
      .toBeUndefined();
    expect(production.ai.roomSettings['26966466'].fullLiveContextExperiment).toEqual(
      expect.objectContaining({
        tasks: ['goodnight', 'comic', 'summary'],
        summaryDeliveryMode: 'attach_if_ready',
        promptCacheRolloutPercent: 100,
        cachePropagationWaitMs: 3000
      })
    );
  });

  test('waits for cache propagation only in the attached goodnight-summary mode', () => {
    expect(liveContentSummary.getCachePropagationWaitMs(makeExperiment({
      tasks: ['goodnight', 'comic', 'summary'],
      summaryDeliveryMode: 'attach_if_ready',
      cachePropagationWaitMs: 3000
    }))).toBe(3000);

    expect(liveContentSummary.getCachePropagationWaitMs(makeExperiment({
      tasks: ['summary', 'ownStreamClips'],
      summaryDeliveryMode: 'separate',
      cachePropagationWaitMs: 3000
    }))).toBe(0);

    expect(liveContentSummary.getCachePropagationWaitMs(makeExperiment({
      tasks: ['goodnight', 'summary'],
      summaryDeliveryMode: 'attach_if_ready'
    }))).toBe(0);
  });

  test('keeps the byte-identical full-live prefix before its task suffix', () => {
    const sharedPrefix = [
      liveGenerationContext.SHARED_PROMPT_CACHE_START,
      '完整字幕和弹幕',
      liveGenerationContext.SHARED_PROMPT_CACHE_END
    ].join('\n');
    const prompt = liveContentSummary.buildLiveContentSummaryPrompt(sharedPrefix);

    expect(prompt.slice(0, sharedPrefix.length)).toBe(sharedPrefix);
    expect(prompt.indexOf(liveGenerationContext.SHARED_PROMPT_CACHE_END))
      .toBeLessThan(prompt.indexOf('【本场直播极简梗概任务'));
  });

  test('normalizes arrays and rejects unsupported activity types', () => {
    expect(liveContentSummary.normalizeLiveContent({
      overview: ' 杂谈、唱歌 ',
      activityTypes: ['chat', 'singing', 'chat'],
      songs: ['小幸运', '小幸运'],
      games: [],
      topics: ['妈妈做火烧云', '男人打架']
    })).toEqual({
      overview: '杂谈、唱歌',
      activityTypes: ['chat', 'singing'],
      songs: ['小幸运'],
      games: [],
      topics: ['妈妈做火烧云', '男人打架']
    });

    expect(() => liveContentSummary.normalizeLiveContent({
      overview: '测试',
      activityTypes: ['made_up'],
      songs: [],
      games: [],
      topics: []
    })).toThrow('unsupported activity type');
  });

  test('writes a canonical sidecar with cache usage and reuses the same source hash', async () => {
    const dir = makeTempDir();
    const highlightPath = path.join(dir, '录制-25788785-20260811-200000-1-测试_AI_HIGHLIGHT.txt');
    fs.writeFileSync(highlightPath, 'sampled highlight', 'utf8');
    const { outputPath: fullLiveContextPath } = writeFullContext(highlightPath);
    const generateText = jest.fn().mockResolvedValue({
      text: JSON.stringify({
        overview: '杂谈、唱歌',
        activityTypes: ['chat', 'singing'],
        songs: ['小幸运'],
        games: [],
        topics: ['妈妈做火烧云']
      }),
      meta: {
        provider: 'daiYu',
        model: 'gpt-5.6-luna',
        attempts: [{
          provider: 'daiYu',
          model: 'gpt-5.6-luna',
          status: 'success',
          promptTokens: 10000,
          cachedTokens: 8000,
          cacheWriteTokens: 0,
          completionTokens: 200,
          reasoningTokens: 100,
          sharedPromptCacheKey: 'a'.repeat(64),
          sharedPromptPrefixChars: 9000
        }]
      }
    });

    try {
      const first = await liveContentSummary.generateLiveContentSummary({
        highlightPath,
        fullLiveContextPath,
        roomId: '25788785',
        experiment: makeExperiment(),
        generateText
      });
      const second = await liveContentSummary.generateLiveContentSummary({
        highlightPath,
        fullLiveContextPath,
        roomId: '25788785',
        experiment: makeExperiment(),
        generateText
      });
      const saved = JSON.parse(fs.readFileSync(first.outputPath, 'utf8'));

      expect(generateText).toHaveBeenCalledTimes(1);
      expect(generateText.mock.calls[0][0]).toContain('=== 全量直播音轨字幕');
      expect(generateText.mock.calls[0][1]).toEqual(expect.objectContaining({
        promptCacheRolloutPercent: 100,
        maxTokens: 2000,
        thinkingBudgetTokens: 2000,
        fallbackModelsEnabled: false
      }));
      expect(saved.status).toBe('success');
      expect(saved.source.coverage).toBe('full_srt_and_merged_danmaku');
      expect(saved.content.games).toEqual([]);
      expect(saved.generation).toEqual(expect.objectContaining({
        promptTokens: 10000,
        cachedTokens: 8000,
        cacheWriteTokens: 0,
        completionTokens: 200,
        reasoningTokens: 100,
        cacheHitRatio: 0.8
      }));
      expect(second.reused).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('persists terminal generation failure without throwing into the main pipeline', async () => {
    const dir = makeTempDir();
    const highlightPath = path.join(dir, '录制-26966466-20260811-200000-1-测试_AI_HIGHLIGHT.txt');
    fs.writeFileSync(highlightPath, 'sampled highlight', 'utf8');
    const { outputPath: fullLiveContextPath } = writeFullContext(highlightPath);

    const generateText = jest.fn().mockResolvedValue({ text: 'not-json', meta: { attempts: [] } });

    try {
      const result = await liveContentSummary.generateLiveContentSummary({
        highlightPath,
        fullLiveContextPath,
        roomId: '26966466',
        experiment: makeExperiment(),
        generateText
      });
      const repeated = await liveContentSummary.generateLiveContentSummary({
        highlightPath,
        fullLiveContextPath,
        roomId: '26966466',
        experiment: makeExperiment(),
        generateText
      });
      const saved = JSON.parse(fs.readFileSync(result.outputPath, 'utf8'));

      expect(generateText).toHaveBeenCalledTimes(1);
      expect(repeated.reused).toBe(true);
      expect(saved.status).toBe('failed');
      expect(saved.error).toContain('AI did not return a JSON object');
      expect(saved.content).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
