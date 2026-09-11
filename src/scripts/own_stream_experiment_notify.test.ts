export {};
jest.mock('node-fetch', () => jest.fn());
const fetch = require('node-fetch');
const own = require('./own_stream_clipper');

test('WeChat lists only the precision marker, followed by a separate detail message with the same ID', async () => {
    fetch.mockReset();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
    const results = [
        { window: { start: 0, duration: 60 }, copy: { title: 'Ordinary' }, output: { mediaPath: 'ordinary.mp4' } },
        { window: { start: 60, duration: 55 }, copy: { title: 'Experimental' }, output: { mediaPath: 'edited.mp4' },
            precisionExperiment: { selected: true, reason: 'Clear pause' }, qaResult: { status: 'passed' },
            enhancement: { removedSeconds: 5, generationLogs: [{ stage: 'qa', status: 'success', usage: { input_tokens: 100, output_tokens: 50 } }] } }
    ];
    const metadata = { streamTitle: 'Batch', uploadRegistry: { clipIdsByReviewIndex: { 1: 101, 2: 102 } } };
    await own.notifyResults(results, metadata, { wechatWork: { webhookUrl: 'https://example.test/robot' } });
    const messages = fetch.mock.calls.map(([, options]) => JSON.parse(options.body).markdown.content);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('2. ID102 Experimental');
    expect(messages[0]).toContain(' | 精切');
    expect(messages[0]).not.toContain('input=');
    expect(messages[0]).not.toContain('Clear pause');
    expect(messages[1]).toContain('精切实验模式详情');
    expect(messages[1]).toContain('2. ID102 Experimental');
    expect(messages[1]).toContain('input=100');
    expect(messages[1]).toContain('5.00s');
});

test('zero-precision batches send a separate explanation rather than silently omitting the experiment', async () => {
    fetch.mockReset();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
    await own.notifyResults([{ window: { start: 0, duration: 60 }, copy: { title: 'Ordinary' }, output: { mediaPath: 'ordinary.mp4' } }],
        { precisionExperiment: { total: 23, eligibleCount: 0, selected: [], reason: 'no_eligible_candidates', status: 'ordinary_control' } },
        { wechatWork: { webhookUrl: 'https://example.test/robot' } });
    const messages = fetch.mock.calls.map(([, options]) => JSON.parse(options.body).markdown.content);
    expect(messages).toHaveLength(2);
    expect(messages[0]).not.toContain(' | 精切');
    expect(messages[1]).toContain('本批精切 0 条');
    expect(messages[1]).toContain('未调用 AI 抽选');
});

test('precision details keep chronological positions and the original review-index ID mapping', async () => {
    fetch.mockReset();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
    const results = [
        { window: { index: 1, start: 100, duration: 60 }, copy: { title: 'Precision' }, precisionExperiment: { selected: true, reason: 'Story' }, output: {} },
        { reviewIndex: 999, window: { start: 20, duration: 60 }, copy: { title: 'Earlier rejected' }, selectionRejection: { reason: 'overlap' }, output: {} }
    ];
    await own.notifyResults(results, { uploadRegistry: { clipIds: [123, 456] } }, { wechatWork: { webhookUrl: 'https://example.test/robot' } });
    const messages = fetch.mock.calls.map(([, options]) => JSON.parse(options.body).markdown.content);
    expect(messages[0]).toContain('2. ID123 Precision');
    expect(messages[1]).toContain('2. ID123 Precision');
    expect(messages[1]).not.toContain('ID456 Precision');
});
