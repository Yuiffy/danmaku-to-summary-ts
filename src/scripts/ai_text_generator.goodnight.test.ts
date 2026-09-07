jest.mock('node-fetch', () => jest.fn());
jest.mock('./config-loader', () => ({
  getConfig: jest.fn(), getNames: jest.fn(), getWordLimit: jest.fn(), getByPath: jest.fn(),
  getDaiYuApiKey: jest.fn(() => 'test-key'), isDaiYuTextConfigured: jest.fn(() => true),
  getTuZiTextApiKey: jest.fn(() => 'test-key'), isTuZiTextConfigured: jest.fn(() => true),
  isGeminiConfigured: jest.fn(() => true), isTuZiConfigured: jest.fn(() => true)
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const fetchMock = require('node-fetch');
const loader = require('./config-loader');
const { generateGoodnightReply, inspectGeneratedReply } = require('./ai_text_generator');
const sentence = '今天从一开始摸不清方向到最后配合越来越顺畅，认真研究机制的过程也很有意思，感谢大家陪伴';
const valid = `${sentence}！${sentence}。`;
const pendingResponse = status => ({ ok: true, status: 200, headers: { get: () => 'synthetic-request' },
  json: async () => ({ id: 'synthetic-pending', status, output_text: 'An unfinished response.',
    usage: { input_tokens: 100, output_tokens: 5 } }) });
const completedResponse = text => ({ ok: true, status: 200, headers: { get: () => 'synthetic-request' },
  json: async () => ({ id: 'synthetic-complete', status: 'completed', output_text: text,
    usage: { input_tokens: 100, output_tokens: 25 } }) });

describe('goodnight generator entry point', () => {
  let directory;
  let highlight;
  let config;
  let warnings;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    fetchMock.mockReset();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goodnight-entry-'));
    highlight = path.join(directory, 'fixture_AI_HIGHLIGHT.txt');
    fs.writeFileSync(highlight, 'Synthetic source: the host practiced a game and finished the stream.');
    config = { timeouts: { aiApiTimeout: 1000 }, ai: { text: { enabled: true, provider: 'daiYu',
      sharedPromptCache: { enabled: false }, gemini: { enabled: false },
      daiYu: { enabled: true, apiMode: 'responses', baseUrl: 'https://provider.invalid', model: 'gpt-5.6-luna',
        maxTokens: 100000, fallbackModels: [], fallbackProvider: 'none', thinking: { enabled: true, effort: 'high' } },
      tuZi: { enabled: true, apiMode: 'responses', baseUrl: 'https://fallback.invalid', model: 'gpt-5.6-luna' }
    } } };
    loader.getConfig.mockReturnValue(config);
    loader.getNames.mockReturnValue({ anchor: 'Host', fan: 'Fans' });
    loader.getWordLimit.mockReturnValue(250);
    loader.getByPath.mockReturnValue(250);
    warnings = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test.each(['！', '？', '!', '?', '。'])('counts %s between substantive sentences without changing text', punctuation => {
    const text = `${sentence}${punctuation}${sentence}。`;
    expect(inspectGeneratedReply(text, 250, 'fixture')).toMatchObject({ ok: true, cleaned: text, sentenceCount: 2 });
  });

  test.each(['！', '？！', '！？？', '，', '、', '！”', '。」', '？~'])('one sentence or a punctuation run does not satisfy the two-sentence gate: %s', punctuation => {
    const text = `${sentence.repeat(3)}${punctuation}`;
    expect(inspectGeneratedReply(text, 250, 'fixture')).toMatchObject({ ok: false, sentenceCount: 1 });
  });

  test('accepts a two-sentence Chinese reply once, without changing provider settings or adding a rewrite', async () => {
    expect(valid.length).toBeGreaterThanOrEqual(80);
    fetchMock.mockResolvedValue(completedResponse(valid));
    const output = generateGoodnightReply(highlight, 'fixture');
    await jest.runAllTimersAsync();
    const file = await output;
    expect(file).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('gpt-5.6-luna');
    expect(body.reasoning.effort).toBe('high');
    expect(body.background).toBeUndefined();
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(100000);
    expect(fs.readFileSync(file, 'utf8').endsWith(valid)).toBe(true);
    expect(fs.readdirSync(directory).filter(name => name.includes('ATTEMPT'))).toEqual([]);
    expect(await generateGoodnightReply(highlight, 'fixture')).toBe(file);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([['daiYu', 'queued'], ['daiYu', 'in_progress'], ['tuZi', 'queued'], ['tuZi', 'in_progress']])
    ('does not resubmit a %s %s response at the outer retry boundary', async (provider, status) => {
      config.ai.text.provider = provider;
      config.ai.text.daiYu.fallbackModels = ['gpt-5.6-sol'];
      config.ai.text.daiYu.fallbackProvider = 'tuZi';
      fetchMock.mockResolvedValue(pendingResponse(status));
      const output = generateGoodnightReply(highlight, 'fixture');
      await jest.runAllTimersAsync();
      expect(await output).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(directory).filter(name => name.endsWith('.md') || name.endsWith('.lock'))).toEqual([]);
      const line = warnings.mock.calls.flat().find(value => String(value).startsWith('[GOODNIGHT_OUTCOME_UNKNOWN] '));
      expect(line).toBeDefined();
      const diagnostic = JSON.parse(line.slice('[GOODNIGHT_OUTCOME_UNKNOWN] '.length));
      expect(diagnostic).toMatchObject({ attempt: 1, outcomeUnknown: true, attempts: [
        { provider, responseId: 'synthetic-pending', requestId: 'synthetic-request', outcomeUnknown: true,
          usageFinal: false, usageUnknown: true, promptTokens: 100, completionTokens: 5 }
      ] });
    });

  test('continues a genuine quality retry after a complete single-sentence result', async () => {
    fetchMock.mockResolvedValueOnce(completedResponse(`${sentence.repeat(3)}。`)).mockResolvedValueOnce(completedResponse(valid));
    const output = generateGoodnightReply(highlight, 'fixture');
    await jest.runAllTimersAsync();
    const file = await output;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(file, 'utf8').endsWith(valid)).toBe(true);
    expect(fs.readdirSync(directory).filter(name => name.includes('ATTEMPT'))).toHaveLength(1);
    expect(JSON.stringify(JSON.parse(fetchMock.mock.calls[1][1].body).input)).toContain('失败重试纠错');
  });

  test('does not confuse a terminal HTTP failure with an explicitly pending response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, headers: { get: () => 'synthetic-error' }, text: async () => 'Bad gateway' })
      .mockResolvedValueOnce(completedResponse(valid));
    const output = generateGoodnightReply(highlight, 'fixture');
    await jest.runAllTimersAsync();
    expect(await output).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnings.mock.calls.flat().some(value => String(value).startsWith('[GOODNIGHT_OUTCOME_UNKNOWN] '))).toBe(false);
  });
});
