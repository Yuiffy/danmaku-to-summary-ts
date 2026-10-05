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

function writeFullContext(highlightPath: string, compactEvidence = false) {
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
    config: { fullContextDanmakuMergeWindowSeconds: 30, compactEvidence },
    info: { streamTitle: '测试直播', recordedAt: '2026-08-11 20:00:00' },
    totalDuration: 70
  });
  return fullLiveContext.saveFullLiveContextSidecar(highlightPath, context);
}

describe('live_content_summary', () => {
  test('keeps complete-source inputs and nested summary delivery scoped to the four rooms', () => {
    const production = require('./workflow-runtime').loadWorkflow('config/layers').loadConfigLayers({ env: { NODE_ENV: 'production' } });

    expect(production.ai.text.sharedPromptCache.explicitRolloutPercent).toBe(10);
    expect(production.ai.comic.storytellingExperiment.immersivePercent).toBe(60);
    expect(production.ai.roomSettings['26966466'].storytellingExperiment).toBeUndefined();
    expect(production.ai.roomSettings['25788785'].fullLiveContextExperiment).toEqual(
      expect.objectContaining({
        tasks: ['summary', 'ownStreamClips'],
        summaryDeliveryMode: 'separate',
        compactEvidence: true,
        promptCacheRolloutPercent: 100
      })
    );
    expect(production.ai.roomSettings['25788785'].fullLiveContextExperiment.cachePropagationWaitMs)
      .toBe(0);
    expect(production.ai.roomSettings['26966466'].fullLiveContextExperiment).toEqual(
      expect.objectContaining({
        tasks: ['goodnight', 'comic', 'summary'],
        summaryDeliveryMode: 'separate',
        compactEvidence: true,
        promptCacheRolloutPercent: 100,
        cachePropagationWaitMs: 3000
      })
    );
    for (const room of ['30655190', '31368705']) {
      expect(production.ai.roomSettings[room].fullLiveContextExperiment).toEqual(expect.objectContaining({
        summaryDeliveryMode: 'separate', compactEvidence: true, replySummary: expect.objectContaining({ enabled: true })
      }));
    }
  });

  test('waits after a full-source goodnight independently of comment delivery mode', () => {
    expect(liveContentSummary.getCachePropagationWaitMs(makeExperiment({
      tasks: ['goodnight', 'comic', 'summary'],
      summaryDeliveryMode: 'attach_if_ready',
      cachePropagationWaitMs: 3000
    }))).toBe(3000);

    expect(liveContentSummary.getCachePropagationWaitMs(makeExperiment({
      tasks: ['goodnight', 'comic', 'summary'],
      summaryDeliveryMode: 'separate',
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
        model: 'gpt-6-luna',
        attempts: [{
          provider: 'daiYu',
          model: 'gpt-6-luna',
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
        fallbackModelsEnabled: false,
        responseFormat: expect.objectContaining({ type: 'json_schema', strict: true,
          schema: expect.objectContaining({ additionalProperties: false,
            required: ['overview', 'activityTypes', 'songs', 'games', 'topics'],
            properties: expect.objectContaining({ songs: expect.objectContaining({ type: 'array', items: { type: 'string' } }) }) }) })
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

  test('requests typed song records separately from public song names and keeps source validation', async () => {
    const dir = makeTempDir();
    const highlightPath = path.join(dir, '测试_AI_HIGHLIGHT.txt');
    const { outputPath: fullLiveContextPath, payload } = writeFullContext(highlightPath, true);
    const speech = payload.evidence.speech.find(row => row.text.includes('小幸运'));
    const raw = { overview: '唱歌', activityTypes: ['singing'], songs: [], games: [], topics: [],
      activityTimeline: { version: 1, status: 'complete', events: [{ kind: 'song', start: 65, end: 70,
        name: null, performance: 'fragment', startObserved: false, endObserved: false,
        evidenceIds: [speech.id], titleEvidenceIds: [] }] } };
    const generateText = jest.fn().mockResolvedValue({ text: JSON.stringify(raw), meta: {} });
    try {
      const result = await liveContentSummary.generateLiveContentSummary({ highlightPath, fullLiveContextPath,
        config: {}, roomId: '25788785', experiment: makeExperiment(), includeActivityTimeline: true, generateText });
      const format = generateText.mock.calls[0][1].responseFormat;
      expect(format).toMatchObject({ type: 'json_schema', strict: true, schema: { additionalProperties: false,
        required: ['overview', 'activityTypes', 'songs', 'games', 'topics', 'activityTimeline'] } });
      const timelineSchema = format.schema.properties.activityTimeline;
      expect(timelineSchema.required).toEqual(['version', 'status', 'events']);
      const eventSchemas = timelineSchema.properties.events.items.anyOf;
      expect(eventSchemas.map(event => event.properties.kind.enum)).toEqual([['song'], ['watch']]);
      for (const eventSchema of eventSchemas) {
        expect(eventSchema.additionalProperties).toBe(false);
        expect(eventSchema.required).toEqual(Object.keys(eventSchema.properties));
        expect(eventSchema.properties.name.type).toEqual(['string', 'null']);
        expect(eventSchema.properties.evidenceIds.minItems).toBe(1);
      }
      expect(result.payload.content.songs).toEqual([]);
      expect(result.payload.activityTimeline.events).toEqual([expect.objectContaining({
        kind: 'song', name: null, performance: 'fragment', evidenceIds: [speech.id] })]);

      raw.activityTimeline.events[0].evidenceIds = ['T999999'];
      generateText.mockResolvedValue({ text: JSON.stringify(raw), meta: {} });
      const invalid = await liveContentSummary.generateLiveContentSummary({ highlightPath, fullLiveContextPath,
        outputPath: path.join(dir, 'invalid.json'), config: {}, roomId: '25788785', experiment: makeExperiment(),
        includeActivityTimeline: true, generateText });
      expect(invalid.payload).toMatchObject({ status: 'failed', error: expect.stringContaining('unseen source citations') });
      expect(invalid.payload.content).toBeUndefined();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test.each([undefined, { version: 1, status: 'incomplete', events: [] }])(
    'rejects incomplete activity evidence instead of publishing an unchecked overview: %j', async activityTimeline => {
      const dir = makeTempDir();
      const highlightPath = path.join(dir, '测试_AI_HIGHLIGHT.txt');
      const { outputPath: fullLiveContextPath } = writeFullContext(highlightPath, true);
      const responseText = JSON.stringify({ overview: '杂谈、观看电影', activityTypes: ['chat', 'watch_movie'],
        songs: [], games: [], topics: [], activityTimeline });
      const generateText = jest.fn().mockResolvedValue({ text: responseText, meta: {} });
      try {
        const result = await liveContentSummary.generateLiveContentSummary({ highlightPath, fullLiveContextPath,
          config: {}, roomId: '25788785', experiment: makeExperiment(), includeActivityTimeline: true, generateText });
        expect(result.payload).toMatchObject({ status: 'failed', error: 'Summary activity timeline is missing or incomplete',
          generation: { attempts: [expect.objectContaining({ responseText })] } });
        expect(result.payload.content).toBeUndefined();
        expect(generateText).toHaveBeenCalledTimes(1);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

  test.each(['old-prompt', 'incomplete-timeline'])('regenerates an unsafe cached overview: %s', async cacheKind => {
    const dir = makeTempDir();
    const highlightPath = path.join(dir, '测试_AI_HIGHLIGHT.txt');
    const { outputPath: fullLiveContextPath, payload } = writeFullContext(highlightPath, true);
    const outputPath = liveContentSummary.getLiveContentSummaryPath(highlightPath);
    const raw = { overview: '杂谈', activityTypes: ['chat'], songs: [], games: [], topics: [],
      activityTimeline: { version: 1, status: 'complete', events: [] } };
    fs.writeFileSync(outputPath, JSON.stringify({ schemaVersion: 1, status: 'success', source: {
      sourceSha256: payload.sourceSha256, sharedPrefixSha256: payload.sharedPrefixSha256,
      promptVersion: cacheKind === 'old-prompt' ? 1 : liveContentSummary.LIVE_CONTENT_PROMPT_VERSION,
      activityTimelineVersion: 1, inputSources: null }, content: { ...raw, overview: '未经证实的观影梗概' },
      activityTimeline: { version: 1, status: cacheKind === 'old-prompt' ? 'complete' : 'incomplete', events: [] }
    }), 'utf8');
    const generateText = jest.fn().mockResolvedValue({ text: JSON.stringify(raw), meta: {} });
    try {
      const options = { highlightPath, fullLiveContextPath, config: {}, roomId: '25788785',
        experiment: makeExperiment(), includeActivityTimeline: true, generateText };
      const result = await liveContentSummary.generateLiveContentSummary(options);
      expect(result.reused).toBe(false);
      expect(result.payload).toMatchObject({ status: 'success', content: { overview: '杂谈' },
        activityTimeline: { status: 'complete', events: [] } });
      const repeated = await liveContentSummary.generateLiveContentSummary(options);
      expect(repeated.reused).toBe(true);
      expect(generateText).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('retries with the actual evidence error and only accepts the checked draft as cache history', async () => {
    const dir = makeTempDir();
    const highlightPath = path.join(dir, '测试_AI_HIGHLIGHT.txt');
    const { outputPath: fullLiveContextPath, payload } = writeFullContext(highlightPath, true);
    const speech = payload.evidence.speech.find(row => row.text.includes('小幸运'));
    const raw = { overview: '唱歌', activityTypes: ['singing'], songs: [], games: [], topics: [],
      activityTimeline: { version: 1, status: 'complete', events: [{ kind: 'song', start: 65, end: 70,
        name: null, performance: 'fragment', startObserved: true, endObserved: true,
        evidenceIds: ['T999999'], titleEvidenceIds: [] }] } };
    const badResponse = JSON.stringify(raw);
    raw.activityTimeline.events[0].evidenceIds = [speech.id];
    const rejectedSeed = { draft: 'rejected' }, acceptedSeed = { draft: 'checked' };
    const generateText = jest.fn().mockResolvedValueOnce({ text: badResponse, meta: {}, cacheSeed: rejectedSeed })
      .mockResolvedValueOnce({ text: JSON.stringify(raw), meta: {}, cacheSeed: acceptedSeed });
    const acceptSeed = jest.spyOn(require('./text/live_cache_continuation'), 'acceptSeed').mockReturnValue(false);
    try {
      const result = await liveContentSummary.generateLiveContentSummary({ highlightPath, fullLiveContextPath,
        config: {}, roomId: '25788785', experiment: makeExperiment({ maxAttempts: 2 }),
        includeActivityTimeline: true, generateText });
      expect(result.payload.status).toBe('success');
      expect(generateText).toHaveBeenCalledTimes(2);
      expect(generateText.mock.calls[1][0]).toContain('unseen source citations: T999999');
      expect(generateText.mock.calls[1][0].startsWith(payload.sharedPrefix)).toBe(true);
      expect(result.payload.generation.attempts).toEqual([expect.objectContaining({ status: 'failure', responseText: badResponse })]);
      expect(acceptSeed).toHaveBeenCalledTimes(1);
      expect(acceptSeed).toHaveBeenCalledWith(acceptedSeed, {});
    } finally { acceptSeed.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test.each([{ name: '小幸运' }, null, 7])('retains malformed song output for diagnosis without coercing it: %j', async invalidSong => {
    const dir = makeTempDir();
    const highlightPath = path.join(dir, '测试_AI_HIGHLIGHT.txt');
    const { outputPath: fullLiveContextPath } = writeFullContext(highlightPath);
    const responseText = JSON.stringify({ overview: '唱歌', activityTypes: ['singing'], songs: [invalidSong], games: [], topics: [] });
    const generateText = jest.fn().mockResolvedValue({ text: responseText, meta: {} });
    try {
      const result = await liveContentSummary.generateLiveContentSummary({ highlightPath, fullLiveContextPath,
        config: {}, roomId: '25788785', experiment: makeExperiment(), generateText });
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(result.payload).toMatchObject({ status: 'failed', error: 'songs must contain strings only',
        generation: { attempts: [expect.objectContaining({ status: 'failure', responseText,
          responseSha256: require('crypto').createHash('sha256').update(responseText).digest('hex') })] } });
      expect(result.payload.content).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(result.outputPath, 'utf8')).generation.attempts[0].responseText).toBe(responseText);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
