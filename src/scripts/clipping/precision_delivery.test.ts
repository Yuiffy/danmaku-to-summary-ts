export {};
jest.mock('node-fetch', () => jest.fn());
const fetch = require('node-fetch');
const fs = require('fs'), os = require('os'), path = require('path');
const { completionMarkdown, notifyPrecisionDelivery } = require('./precision_delivery');
const { produceOwnClips } = require('./own_production');

test('ordinary delivery completes before the selected clip starts, stable source indices survive reordered jobs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-delivery-'));
    const calls: string[] = [];
    const clips = Array.from({ length: 3 }, (_, i) => ({ start: i * 70, end: i * 70 + 60, title: `片${i + 1}`,
        precisionExperiment: { selected: i === 1, reason: '表情反应' } }));
    const metadata: any = { aiStatus: {} };
    try {
        const result = await produceOwnClips({ clips, options: { mediaPath: 'source', srtPath: 'srt' }, config: {
            enhancements: { enabled: true, workflow: 'creative', roomIds: ['room'] }, clipConcurrency: 2, clipResourceAdaptive: { enabled: false },
            streamReviewRendering: false }, rootConfig: {}, parsed: {}, evidence: { version: 1 }, info: { roomId: 'room' }, outputRoot: dir,
            diagnostics: {}, metadata }, {
            review: async rows => rows, prepare: async rows => ({ clips: rows, summary: { selected: [{ id: 2 }], total: 3 } }),
            render: async (clip, index) => { calls.push(`render${index}`); return { window: { index: index + 1 }, title: clip.title }; },
            ordinaryReady: async rows => {
                expect(rows.map(row => row.window.index)).toEqual([1, 3]);
                expect(metadata.precisionDelivery.phase).toBe('ordinary_ready');
                expect(JSON.parse(fs.readFileSync(metadata.planPath)).status).toBe('precision_pending');
                calls.push('notify-ordinary');
            }, stats: () => ({}), planReview: () => '' });
        expect(calls).toEqual(['render0', 'render2', 'notify-ordinary', 'render1']);
        expect(result.results.map(row => row.window.index)).toEqual([1, 2, 3]);
        expect(metadata.precisionDelivery.phase).toBe('precision_complete');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('phase notifications are separate, deduplicated, and never report fallback as completion', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-notify-'));
    fetch.mockReset(); fetch.mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
    const metadata: any = { reviewPath: path.join(dir, 'REVIEW.md'), precisionDelivery: { phase: 'ordinary_ready',
        selected: [{ index: 2, title: '画面重点' }] }, uploadRegistry: { clipIdsByReviewIndex: { 2: 321 } } };
    const config = { wechatWork: { webhookUrl: 'https://example.test/robot' } };
    try {
        await notifyPrecisionDelivery([], metadata, config, () => '普通片ID320');
        await notifyPrecisionDelivery([], metadata, config, () => '普通片ID320');
        expect(fetch).toHaveBeenCalledTimes(1);
        const first = JSON.parse(fetch.mock.calls[0][1].body).markdown.content;
        expect(first).toContain('正在把候选2《画面重点》制作成精切');
        expect(first).not.toContain('精切完成');
        metadata.precisionDelivery.phase = 'precision_complete';
        const row = { window: { index: 2 }, copy: { title: '画面重点' }, creativeResult: { status: 'kept_original', reason: 'creative_qa_rejected' },
            output: { mediaPath: 'baseline.mp4' } };
        await notifyPrecisionDelivery([row], metadata, config, () => '');
        const last = JSON.parse(fetch.mock.calls[1][1].body).markdown.content;
        expect(last).toContain('ID321'); expect(last).toContain('已保留普通版'); expect(last).not.toContain('## 精切完成');
        expect(completionMarkdown([], metadata)).toContain('制作失败');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an uncertain webhook result is recorded and not automatically sent twice', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-notify-unknown-'));
    fetch.mockReset(); fetch.mockRejectedValue(new Error('timeout'));
    const metadata = { reviewPath: path.join(dir, 'REVIEW.md'), precisionDelivery: { phase: 'ordinary_ready', selected: [] } };
    try {
        await expect(notifyPrecisionDelivery([], metadata, { wechatWork: { webhookUrl: 'https://example.test' } }, () => 'text')).rejects.toThrow('timeout');
        expect(await notifyPrecisionDelivery([], metadata, { wechatWork: { webhookUrl: 'https://example.test' } }, () => 'text')).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test.each([false, true])('streaming creative reuses its baseline after ordinary delivery and preserves it on failure (%s)', async fails => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-stream-delivery-'));
    const mediaPath = path.join(dir, 'source.mp4'), srtPath = path.join(dir, 'source.srt');
    fs.writeFileSync(mediaPath, 'source'); fs.writeFileSync(srtPath, 'subtitles');
    const clips = [0, 1, 2].map(i => ({ start: i * 70, end: i * 70 + 60, title: `clip${i}` }));
    const events: string[] = [], metadata: any = { aiStatus: {} };
    let selections = 0;
    try {
        const produced = await produceOwnClips({ clips, options: { mediaPath, srtPath }, config: {
            streamReviewRendering: true, clipConcurrency: 1, clipResourceAdaptive: { enabled: false },
            enhancements: { enabled: true, workflow: 'creative', roomIds: ['room'] } }, rootConfig: {}, parsed: {},
            evidence: { version: 1 }, info: { roomId: 'room' }, diagnostics: {}, metadata, outputRoot: dir }, {
            review: async (rows, hooks) => { await hooks.onBatchReviewed(rows.map((clip, index) => ({ clip, index }))); return rows; },
            prepare: async rows => { selections++; expect(rows).toHaveLength(3); return { clips: rows.map((row, i) => ({ ...row,
                precisionExperiment: { selected: i === 1, reason: 'reaction' } })), summary: { selected: [{ id: 2 }] } }; },
            render: async (clip, index, execution) => {
                expect(execution.deferEnhancement).toBe(true); events.push(`render${index}`);
                const output = { mediaPath: path.join(dir, `${index}.mp4`), srtPath, metadataPath: path.join(dir, `${index}.json`), burnedSubtitles: true };
                fs.writeFileSync(output.mediaPath, 'ordinary media');
                const result = { window: { index: index + 1, start: clip.start, end: clip.end }, copy: { title: clip.title }, output, uploadReady: true };
                fs.writeFileSync(output.metadataPath, JSON.stringify(result)); return result;
            },
            ordinaryReady: async rows => {
                events.push('notify'); expect(rows.map(row => row.window.index)).toEqual([1, 3]);
                expect(JSON.parse(fs.readFileSync(path.join(dir, '1.json'))).uploadReady).toBe(false);
            },
            enhance: async (baseline, _clip, index) => {
                events.push('enhance'); expect(index).toBe(1); expect(events.at(-2)).toBe('notify');
                expect(fs.readFileSync(baseline.output.mediaPath, 'utf8')).toBe('ordinary media');
                if (fails) throw new Error('effect renderer unavailable');
                return { ...baseline, creativeResult: { status: 'edited' } };
            }, stats: () => ({}), planReview: () => '' });
        expect(selections).toBe(1);
        expect(events).toEqual(['render0', 'render1', 'render2', 'notify', 'enhance']);
        expect(produced.results[1].creativeResult.status).toBe(fails ? 'kept_original' : 'edited');
        expect(JSON.parse(fs.readFileSync(path.join(dir, '1.json'))).uploadReady).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
