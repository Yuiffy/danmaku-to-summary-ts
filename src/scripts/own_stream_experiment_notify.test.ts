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
