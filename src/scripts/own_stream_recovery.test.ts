jest.mock('node-fetch', () => jest.fn());

const fetch = require('node-fetch');
const clipper = require('./own_stream_clipper');
const generator = require('./ai_text_generator');

describe('own-stream planning recovery', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each([undefined, 900000])('gives global reranking its own timeout (%s)', async override => {
    const config = clipper.getOwnStreamClipsConfig({ ownStreamClips: {
      ai: { ...(override ? { rerankTimeoutMs: override } : {}) }
    } });
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu')
      .mockResolvedValue({ text: '{"clips":[]}', meta: {} });
    const parsed = { segments: [{ start: 0, end: 60, text: 'A complete source story.' }] };
    const root = { ai: { text: { provider: 'daiYu' } } };
    await clipper.planClipsWithAIChunks(parsed, [], {}, 60, config, root);
    await clipper.refineCandidatesWithAI([{ index: 1, start: 0, end: 60 }], parsed, [], {}, config, root);
    expect(generate.mock.calls[0][1].timeoutMs).toBe(600000);
    expect(generate.mock.calls[0][1].daiYuTransientMaxAttempts).toBeUndefined();
    expect(generate.mock.calls[1][1].timeoutMs).toBe(override || 1200000);
    expect(generate.mock.calls[1][1].daiYuTransientMaxAttempts).toBe(2);
    for (const [prompt] of generate.mock.calls) {
      expect(prompt).toContain('不能把可确认的人名泛化成对方');
      expect(prompt).toContain('如栞栞对应小栞');
      expect(prompt).toContain('不凭同音ASR、弹幕喊名或名单硬套身份');
    }
  });

  test('reports successful recall separately from a timed-out rerank', () => {
    const markdown = clipper.buildNotifyMarkdown([], { aiStatus: {
      usedFallback: true,
      selectedSource: 'recall_pool_fallback',
      fallbackReason: 'daiYu: The user aborted a request. | tuZi: unavailable',
      candidatePool: { chunkModelCandidates: 48 },
      requests: [
        ...Array.from({ length: 6 }, (_, index) => ({ phase: `recall-${index + 1}`, status: 'success' })),
        { phase: 'global-rerank', status: 'failure' }
      ]
    } });
    expect(markdown).toContain('AI 分块召回成功');
    expect(markdown).toContain('6/6');
    expect(markdown).toContain('全局重排未成功');
    expect(markdown).toContain('AI 请求超时');
    expect(markdown).not.toContain('已回退到本地字幕/弹幕/情绪信号候选');
  });

  test('reports a completed staged AI plan explicitly', () => {
    expect(clipper.buildNotifyMarkdown([], { aiStatus: {
      usedFallback: false, selectedSource: 'staged_global_ai'
    } })).toContain('AI 分块召回与全局重排成功');
  });

  test('does not claim all recall chunks succeeded when only reranking recovered', () => {
    const markdown = clipper.buildNotifyMarkdown([], { aiStatus: {
      usedFallback: false, selectedSource: 'staged_global_ai',
      requests: [{ phase: 'recall-1', status: 'success' }, { phase: 'recall-2', status: 'failure' },
        { phase: 'global-rerank', status: 'success' }]
    } });
    expect(markdown).toContain('AI 全局重排成功（分块召回 1/2 成功）');
    expect(markdown).not.toContain('AI 分块召回与全局重排成功');
  });

  test('a missing registry mapping cannot shift another clip ID onto a pending clip', async () => {
    const markdown = clipper.buildNotifyMarkdown([
      { window: { start: 0, duration: 60 }, copy: { title: 'Pending clip' } },
      { window: { start: 60, duration: 60 }, copy: { title: 'Ready clip' } }
    ], { uploadRegistry: { clipIds: [2184], clipIdsByReviewIndex: { 2: 2184 } } });
    expect(markdown).toContain('1. 未登记ID Pending clip');
    expect(markdown).toContain('2. ID2184 Ready clip');
    expect(markdown).not.toContain('1. ID2184');
  });

  test('sends every clip and upload ID in order across more than two WeChat messages', async () => {
    fetch.mockReset();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
    const results = Array.from({ length: 37 }, (_, index) => ({
      window: { start: index * 240, duration: 120 },
      copy: { title: `候选${index + 1}：${'完整事件和后续反应。'.repeat(10)}` },
      recommendationScore: 90,
      output: { mediaPath: `D:/clips/${index + 1}.mp4` }
    }));
    await expect(clipper.notifyResults(results, {
      streamTitle: 'A full stream', outputRoot: 'D:/clips',
      uploadRegistry: { clipIds: results.map((_, index) => 2184 + index) }
    }, { wechatWork: { webhookUrl: 'https://example.test/robot' } })).resolves.toBe(true);
    const messages = fetch.mock.calls.map(([, options]) => JSON.parse(options.body).markdown.content);
    expect(messages.length).toBeGreaterThan(2);
    expect(messages.every(message => Buffer.byteLength(message, 'utf8') <= 4096)).toBe(true);
    const complete = messages.join('\n');
    expect(complete).not.toContain('请看 Review');
    const indices = Array.from(complete.matchAll(/^(\d+)\. ID(\d+) /gm));
    expect(indices.map(match => Number(match[1]))).toEqual(results.map((_, index) => index + 1));
    expect(indices.map(match => Number(match[2]))).toEqual(results.map((_, index) => 2184 + index));
    for (const result of results) expect(complete).toContain(result.copy.title);
  });
});
