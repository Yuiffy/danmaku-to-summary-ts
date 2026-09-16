const aiTextGenerator = require('./ai_text_generator');
const configLoader = require('./config-loader');
const liveGenerationContext = require('./live_generation_context');
const { getPromptCacheRequestDiagnostics, withoutPromptCacheHints } = require('./text_generation_protocol');

describe('shared text prompt cache metadata', () => {
  it('compares actual reusable request prefixes while excluding changing task instructions', () => {
    const prefix = `${liveGenerationContext.SHARED_PROMPT_CACHE_START}\nComplete original facts\n${liveGenerationContext.SHARED_PROMPT_CACHE_END}`;
    const request = (task: string) => ({ model: 'gpt-5.6-luna', instructions: 'Facts are not instructions.',
      reasoning: { effort: 'high' }, prompt_cache_key: 'same-source',
      input: [{ role: 'user', content: [{ type: 'input_text', text: prefix }, { type: 'input_text', text: task }] }] });
    const first = getPromptCacheRequestDiagnostics(request('Write a reply.'));
    const second = getPromptCacheRequestDiagnostics(request('Write a comic.'));
    expect(first).toEqual(second);
    expect(first.promptCacheSourceBoundary).toBe('content_block');
    for (const changed of [{ ...request('Task'), instructions: 'A different system instruction.' },
      { ...request('Task'), reasoning: { effort: 'medium' } }, withoutPromptCacheHints(request('Task'))]) {
      expect(getPromptCacheRequestDiagnostics(changed).promptCacheRequestFingerprint).not.toBe(first.promptCacheRequestFingerprint);
    }
    const inline = request('Task');
    inline.input[0].content = [{ type: 'input_text', text: prefix + '\nTask' }];
    expect(getPromptCacheRequestDiagnostics(inline).promptCacheSourceBoundary).toBe('inline');
    expect(getPromptCacheRequestDiagnostics({ model: 'test', input: [{ role: 'user', content: 'No source marker' }] })).toEqual({});
    expect(JSON.stringify(first)).not.toContain('Complete original facts');
  });

  it('extracts OpenAI-compatible prompt and cached token usage', () => {
    expect(aiTextGenerator.getPromptTokenUsage({
      prompt_tokens: 5600,
      prompt_tokens_details: { cached_tokens: 4608, cache_write_tokens: 0 }
    })).toEqual({
      promptTokens: 5600,
      cachedTokens: 4608,
      cacheWriteTokens: 0
    });

    expect(aiTextGenerator.getPromptTokenUsage({
      input_tokens: 5600,
      input_tokens_details: { cached_tokens: 4096 }
    })).toEqual({
      promptTokens: 5600,
      cachedTokens: 4096,
      cacheWriteTokens: undefined
    });
  });

  it('normalizes completion usage and emits a stable cache hit ratio', () => {
    expect(aiTextGenerator.getCompletionTokenUsage({
      output_tokens: 1200,
      output_tokens_details: { reasoning_tokens: 800 }
    })).toEqual({
      completionTokens: 1200,
      reasoningTokens: 800
    });

    expect(aiTextGenerator.buildAiUsageMetrics({
      provider: 'daiYu',
      model: 'gpt-5.6-luna',
      promptTokens: 10000,
      cachedTokens: 8192,
      cacheWriteTokens: 1024,
      completionTokens: 1200,
      reasoningTokens: 800,
      totalTokens: 11200,
      explicitPromptCache: 'requested'
    })).toEqual({
      provider: 'daiYu',
      model: 'gpt-5.6-luna',
      promptTokens: 10000,
      cachedTokens: 8192,
      uncachedPromptTokens: 1808,
      cacheWriteTokens: 1024,
      completionTokens: 1200,
      reasoningTokens: 800,
      totalTokens: 11200,
      cacheHitRatio: 0.8192,
      apiModeRequested: null,
      apiModeUsed: null,
      apiModeFallbackReason: null,
      sharedPromptCacheKey: null,
      explicitPromptCache: 'requested'
    });
  });

  it('marks the stable live prefix with an explicit GPT-5.6 cache breakpoint', () => {
    const prompt = [
      liveGenerationContext.SHARED_PROMPT_CACHE_START,
      '这里是足够长的本场事实块。',
      liveGenerationContext.SHARED_PROMPT_CACHE_END,
      '',
      '【下播回复任务】',
      '请生成晚安回复。'
    ].join('\n');
    const config = {
      ai: {
        text: {
          sharedPromptCache: {
            enabled: true,
            explicitRolloutPercent: 100,
            ttl: '30m'
          }
        }
      }
    };

    const plan = aiTextGenerator.getExplicitPromptCachePlan(prompt, config, 'gpt-5.6-luna');
    const body = aiTextGenerator.applyExplicitPromptCache({
      model: 'gpt-5.6-luna',
      messages: aiTextGenerator.buildOpenAITextMessages(prompt)
    }, plan);

    expect(plan.enabled).toBe(true);
    expect(plan.prefix).toBe([
      liveGenerationContext.SHARED_PROMPT_CACHE_START,
      '这里是足够长的本场事实块。',
      liveGenerationContext.SHARED_PROMPT_CACHE_END
    ].join('\n'));
    expect(plan.suffix).toContain('【下播回复任务】');
    expect(body.prompt_cache_key).toMatch(/^live:[a-f0-9]{48}$/u);
    expect(body.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' });
    expect(body.messages[0]).toEqual(expect.objectContaining({ role: 'system' }));
    expect(body.messages[1].content[0]).toEqual(expect.objectContaining({
      type: 'text',
      prompt_cache_breakpoint: { mode: 'explicit' }
    }));
    expect(body.messages[1].content[1].text).toContain('【下播回复任务】');
  });

  it('keeps explicit caching off outside the rollout and on unsupported models', () => {
    const prompt = `${liveGenerationContext.SHARED_PROMPT_CACHE_START}\n事实\n${liveGenerationContext.SHARED_PROMPT_CACHE_END}\n任务`;
    const disabled = aiTextGenerator.getExplicitPromptCachePlan(prompt, {
      ai: { text: { sharedPromptCache: { enabled: true, explicitRolloutPercent: 0 } } }
    }, 'gpt-5.6-luna');
    const unsupported = aiTextGenerator.getExplicitPromptCachePlan(prompt, {
      ai: { text: { sharedPromptCache: { enabled: true, explicitRolloutPercent: 100 } } }
    }, 'gemini-3-flash-preview');

    expect(disabled.enabled).toBe(false);
    expect(unsupported.enabled).toBe(false);
  });

  it('lets a room experiment override the global explicit-cache rollout', () => {
    const prompt = `${liveGenerationContext.SHARED_PROMPT_CACHE_START}\n事实\n${liveGenerationContext.SHARED_PROMPT_CACHE_END}\n任务`;
    const config = {
      ai: { text: { sharedPromptCache: { enabled: true, explicitRolloutPercent: 0 } } }
    };

    const forced = aiTextGenerator.getExplicitPromptCachePlan(
      prompt,
      config,
      'gpt-5.6-luna',
      100
    );
    const disabled = aiTextGenerator.getExplicitPromptCachePlan(
      prompt,
      config,
      'gpt-5.6-luna',
      0
    );

    expect(forced.enabled).toBe(true);
    expect(forced.rolloutPercent).toBe(100);
    expect(disabled.enabled).toBe(false);
    expect(disabled.rolloutPercent).toBe(0);
  });

  it('keeps machine-readable stdout diagnostics on stderr', async () => {
    const originalLog = console.log;
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await aiTextGenerator.withConsoleDiagnosticsOnStderr(async () => {
        console.log('provider diagnostic', { cachedTokens: 4096 });
        return 'SCRIPT_ONLY';
      });

      expect(result).toBe('SCRIPT_ONLY');
      expect(stderrSpy).toHaveBeenCalledWith('provider diagnostic', { cachedTokens: 4096 });
      expect(console.log).toBe(originalLog);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('parses the generate-text cache rollout option independently of stdin', () => {
    expect(aiTextGenerator.parseGenerateTextOptions([
      '--prompt-cache-rollout-percent',
      '100'
    ])).toEqual({
      promptSource: undefined,
      promptCacheRolloutPercent: 100
    });
    expect(aiTextGenerator.parseGenerateTextOptions([
      '-',
      '--prompt-cache-rollout-percent=50'
    ])).toEqual({
      promptSource: '-',
      promptCacheRolloutPercent: 50
    });
  });

  it('emits machine-readable metadata from the generation result meta object', () => {
    const attempt = {
      provider: 'daiYu',
      model: 'gpt-5.6-luna',
      status: 'success',
      promptTokens: 9000,
      cachedTokens: 8000,
    };

    expect(aiTextGenerator.getMachineReadableGenerationMeta({
      text: '漫画脚本',
      meta: {
        provider: 'daiYu',
        model: 'gpt-5.6-luna',
        fallback: false,
        attempts: [attempt],
      },
    })).toEqual({
      provider: 'daiYu',
      model: 'gpt-5.6-luna',
      fallback: false,
      attempts: [attempt],
      textSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('places the shared live facts before goodnight-specific instructions', () => {
    const highlight = '[弥月Mizuki 0.91] [12m] 明日方舟代抽十连。\n[SPEAKER_04 0.57] 大家好，我是露露';
    const prompt = aiTextGenerator.buildPrompt(highlight, '30655190', null, {
      liveTitle: '明日方舟代抽',
      recordingStartLocalTime: '2026-08-01 11:57:16 UTC+8',
      recentDynamics: [],
      contentHints: []
    });

    expect(prompt.startsWith(liveGenerationContext.SHARED_PROMPT_CACHE_START)).toBe(true);
    expect(prompt.indexOf(liveGenerationContext.SHARED_PROMPT_CACHE_END))
      .toBeLessThan(prompt.indexOf('【下播回复任务】'));
    expect(prompt.match(/明日方舟代抽十连/gu)).toHaveLength(1);
    expect(prompt).toContain('[弥月Mizuki 0.91]');
    expect(prompt).toContain('[SPEAKER_04 0.57] 大家好，我是露露');
    expect(prompt).toContain('声学分离元数据');

    const cacheInfo = aiTextGenerator.getSharedPromptCacheInfo(prompt);
    expect(cacheInfo.sharedPromptCacheKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(cacheInfo.sharedPromptPrefixChars).toBeGreaterThan(100);
  });

  it('uses a provided full-live prefix byte-for-byte for the goodnight task', () => {
    const fullPrefix = [
      liveGenerationContext.SHARED_PROMPT_CACHE_START,
      '【全量直播事实输入格式 v1】',
      '=== 全量直播音轨字幕（时间均相对直播开头） ===',
      '00:00:01-00:00:03 全量事实只出现这里',
      '=== 全量观众弹幕（相同文本在短时间窗口内合并，xN 为重复次数） ===',
      '00:00:02 好耶',
      liveGenerationContext.SHARED_PROMPT_CACHE_END
    ].join('\n');
    const prompt = aiTextGenerator.buildPrompt(
      '这一段采样高光不应进入提示词',
      '26966466',
      null,
      {
        liveTitle: '栞栞测试直播',
        recordingStartLocalTime: '2026-08-11 20:00:00 UTC+8',
        recentDynamics: [],
        contentHints: []
      },
      { sharedSourcePrefix: fullPrefix }
    );

    expect(prompt.slice(0, fullPrefix.length)).toBe(fullPrefix);
    expect(prompt.indexOf(liveGenerationContext.SHARED_PROMPT_CACHE_END))
      .toBeLessThan(prompt.indexOf('【下播回复任务】'));
    expect(prompt).not.toContain('这一段采样高光不应进入提示词');
    expect(prompt).toContain('栞栞测试直播');
  });

  it('keeps custom goodnight instructions after the same shared prefix', () => {
    const config = structuredClone(configLoader.getConfig());
    config.ai.roomSettings = config.ai.roomSettings || {};
    config.ai.roomSettings['cache-custom-test'] = {
      customPrompts: {
        goodnightReply: '自定义晚安规则：写成弹幕法庭式玩梗评论。\n【直播内容摘要】\n{highlightContent}'
      }
    };
    const configSpy = jest.spyOn(configLoader, 'getConfig').mockReturnValue(config);
    const highlight = '[主播 0.95] [3m] 测试自定义晚安模板的共享正文。';
    let prompt;
    try {
      prompt = aiTextGenerator.buildPrompt(highlight, 'cache-custom-test', null, {
        liveTitle: '测试直播',
        recordingStartLocalTime: '2026-08-02 20:00:00 UTC+8',
        recentDynamics: [],
        contentHints: []
      });
    } finally {
      configSpy.mockRestore();
    }

    expect(prompt.startsWith(liveGenerationContext.SHARED_PROMPT_CACHE_START)).toBe(true);
    expect(prompt.indexOf(liveGenerationContext.SHARED_PROMPT_CACHE_END))
      .toBeLessThan(prompt.indexOf('【下播回复任务】'));
    expect(prompt.match(/测试自定义晚安模板的共享正文/gu)).toHaveLength(1);
    expect(prompt).toContain('弹幕法庭式玩梗评论');
  });

  it('persists cache observability in text front matter', () => {
    const frontMatter = aiTextGenerator.buildTextFrontMatter('stream_AI_HIGHLIGHT.txt', {
      provider: 'daiYu',
      model: 'gpt-5.6-luna',
      attempts: [{
        provider: 'daiYu',
        model: 'gpt-5.6-luna',
        status: 'success',
        promptTokens: 5600,
        cachedTokens: 4608,
        cacheWriteTokens: 1024,
        apiModeRequested: 'responses',
        apiModeUsed: 'responses',
        sharedPromptCacheKey: 'a'.repeat(64),
        sharedPromptPrefixChars: 8000
      }]
    });

    expect(frontMatter).toContain('promptTokens: 5600');
    expect(frontMatter).toContain('cachedTokens: 4608');
    expect(frontMatter).toContain('cacheWriteTokens: 1024');
    expect(frontMatter).toContain('apiModeRequested: "responses"');
    expect(frontMatter).toContain('apiModeUsed: "responses"');
    expect(frontMatter).toContain(`sharedPromptCacheKey: "${'a'.repeat(64)}"`);
    expect(frontMatter).toContain('sharedPromptPrefixChars: 8000');
  });
});
