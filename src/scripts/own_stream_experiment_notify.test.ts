export {};
jest.mock('node-fetch', () => jest.fn());
const fetch = require('node-fetch');
const own = require('./own_stream_clipper');

test('WeChat combines the precision result with the same-ID list and keeps usage details locally', async () => {
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
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('2. ID102 Experimental');
    expect(messages[0]).toContain(' | 精切');
    expect(messages[0]).not.toContain('input=');
    expect(messages[0]).not.toContain('Clear pause');
    expect(messages[0]).toContain('精切实验模式详情');
    expect(messages[0]).toContain('2. ID102 Experimental：质检通过');
    const local = require('./workflow-runtime').loadWorkflow('clipping/experiment').experimentDetailMarkdown(results, metadata);
    expect(local).toContain('input=100');
    expect(local).toContain('5.00s');
});

test('zero-precision batches explain the retained ordinary mode inside the same list', async () => {
    fetch.mockReset();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
    await own.notifyResults([{ window: { start: 0, duration: 60 }, copy: { title: 'Ordinary' }, output: { mediaPath: 'ordinary.mp4' } }],
        { precisionExperiment: { total: 23, eligibleCount: 0, selected: [], reason: 'no_eligible_candidates', status: 'ordinary_control' } },
        { wechatWork: { webhookUrl: 'https://example.test/robot' } });
    const messages = fetch.mock.calls.map(([, options]) => JSON.parse(options.body).markdown.content);
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain(' | 精切');
    expect(messages[0]).toContain('本批精切 0 条');
    expect(messages[0]).toContain('未调用抽选模型');
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
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('2. ID123 Precision：');
    expect(messages[0]).not.toContain('ID456 Precision');
});
