const aiTextGenerator = require('./ai_text_generator');
const configLoader = require('./config-loader');
const liveGenerationContext = require('./live_generation_context');

describe('shared text prompt cache metadata', () => {
  it('extracts OpenAI-compatible prompt and cached token usage', () => {
    expect(aiTextGenerator.getPromptTokenUsage({
      prompt_tokens: 5600,
      prompt_tokens_details: { cached_tokens: 4608 }
    })).toEqual({
      promptTokens: 5600,
      cachedTokens: 4608
    });

    expect(aiTextGenerator.getPromptTokenUsage({
      input_tokens: 5600,
      input_tokens_details: { cached_tokens: 4096 }
    })).toEqual({
      promptTokens: 5600,
      cachedTokens: 4096
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
      .toBeLessThan(prompt.indexOf('【晚安回复任务】'));
    expect(prompt.match(/明日方舟代抽十连/gu)).toHaveLength(1);
    expect(prompt).toContain('[弥月Mizuki 0.91]');
    expect(prompt).toContain('[SPEAKER_04 0.57] 大家好，我是露露');
    expect(prompt).toContain('声学分离元数据');

    const cacheInfo = aiTextGenerator.getSharedPromptCacheInfo(prompt);
    expect(cacheInfo.sharedPromptCacheKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(cacheInfo.sharedPromptPrefixChars).toBeGreaterThan(100);
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
      .toBeLessThan(prompt.indexOf('【晚安回复任务】'));
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
        sharedPromptCacheKey: 'a'.repeat(64),
        sharedPromptPrefixChars: 8000
      }]
    });

    expect(frontMatter).toContain('promptTokens: 5600');
    expect(frontMatter).toContain('cachedTokens: 4608');
    expect(frontMatter).toContain(`sharedPromptCacheKey: "${'a'.repeat(64)}"`);
    expect(frontMatter).toContain('sharedPromptPrefixChars: 8000');
  });
});
