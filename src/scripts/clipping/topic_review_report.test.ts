export {};

const { createTopicReviewReport } = require('./topic_review_report');
const { buildGroundingReviewLine } = require('./selection_result');
const { topicReviewLines } = require('./topic_review_runner');
const { previewReviewLines } = require('./candidate_preview');

const report = createTopicReviewReport({
    compactNotifyText: (value, size = 80) => String(value || '').replace(/\s+/g, ' ').slice(0, size),
    toFwdSlash: value => String(value || '').replace(/\\/g, '/'),
    buildSubtitleContextLines: window => (window.contextSegments || []).map(row => row.text),
    buildGroundingReviewLine, topicReviewLines, previewReviewLines
});

const rendered = (reviewIndex, start) => ({
    reviewIndex, window: { index: `E${reviewIndex}-1`, start, end: start + 30, duration: 30 },
    copy: { title: `Topic ${reviewIndex}` }, output: { mediaPath: `D:/clips/${reviewIndex}.mp4` }, uploadReady: true,
    aiReview: { mode: 'preflight', status: 'ready', subtitleEdits: [] },
    automaticPublicationRequired: true, publicationReview: { status: 'passed', issues: [] },
    publicationDecision: { action: 'auto_queue', reasons: [] }
});

test('automatic topic lists keep stable IDs and truthful queue/review states in chronological order', () => {
    const values = [rendered(1, 100), rendered(2, 20), { ...rendered(3, 60),
        publicationReview: { status: 'needs_review', issues: ['结尾缺少回答，需要核对。', 'final_content_not_passed'] },
        publicationDecision: { action: 'needs_human', reasons: ['final_content_not_passed'] } },
    { ...rendered(4, 40), candidateId: 999, uploadReady: false, status: 'pending_preflight', output: { mediaPath: null },
        aiReview: { mode: 'preflight', status: 'needs_review', quality: { issues: ['字幕中的称呼还不确定'] }, warnings: [] } }];
    const metadata = { automaticPublication: { enabled: true, mode: 'auto' }, uploadRegistry: {
        clipIdsByReviewIndex: { 1: 101, 2: 102, 3: 103, 4: 104 }, clipStatusByReviewIndex: { 1: 'queued', 2: 'uploaded' }
    } };
    const before = JSON.stringify(values);
    const notification = report.buildTopicNotifyMarkdown(values, metadata);
    const local = report.buildTopicReviewMarkdown(values, metadata);
    expect(notification.indexOf('ID 102')).toBeLessThan(notification.indexOf('候选ID 104'));
    expect(notification.indexOf('候选ID 104')).toBeLessThan(notification.indexOf('ID 103'));
    expect(notification.indexOf('ID 103')).toBeLessThan(notification.indexOf('ID 101'));
    expect(notification).toMatch(/\n\n- ID 103/u);
    expect(notification).toMatch(/\n\n- ID 101/u);
    for (const text of ['状态: 已投稿', '状态: 已排队投稿', '状态: 待人工复核', '结尾缺少回答，需要核对。']) {
        expect(notification).toContain(text);
        expect(local).toContain(text);
    }
    expect(notification).toContain('已投稿 1 | 已排队 1');
    expect(notification).toContain('待入队 0 | 待人工复核或异常 2');
    expect(notification).not.toContain('final_content_not_passed');
    expect(notification).not.toContain('ID 999');
    expect(local).toContain('final_content_not_passed');
    expect(local).toContain('ID104 Topic 4');
    expect(local).toContain('待预审（未自动投稿）');
    expect(JSON.stringify(values)).toBe(before);
});

test('topic automatic enqueue receipts report blocked, duplicate and unknown outcomes without success links', () => {
    const values = [rendered(1, 0), rendered(2, 40), rendered(3, 80)];
    const metadata = { automaticPublication: { enabled: true, mode: 'auto', outcomeUnknown: true,
        error: 'Missing automatic enqueue receipt', results: [
            { id: 201, status: 'needs_human', error: '最终成片已变动，需重审' },
            { id: 202, status: 'duplicate', duplicateOf: 181 }
        ] }, uploadRegistry: { clipIdsByReviewIndex: { 1: 201, 2: 202, 3: 203 } } };
    for (const text of [report.buildTopicNotifyMarkdown(values, metadata), report.buildTopicReviewMarkdown(values, metadata)]) {
        expect(text).toContain('自动入队受阻（待处理）');
        expect(text).toContain('最终成片已变动，需重审');
        expect(text).toContain('与既有ID181重复，已跳过，无需处理');
        expect(text).toContain('入队结果待确认（勿重复入队）');
        expect(text).toContain('待入队 0 | 待人工复核或异常 2 | 重复已跳过 1');
        expect(text).not.toContain('成片待审核');
        expect(text).not.toContain('bilibili.com');
    }
});

test('sparse registry mappings do not borrow IDs from a differently ordered legacy list', () => {
    const values = [rendered(1, 80), rendered(2, 20)];
    const metadata = { automaticPublication: { enabled: true }, uploadRegistry: {
        clipIds: [301], clipIdsByReviewIndex: { 1: 301 }
    } };
    const local = report.buildTopicReviewMarkdown(values, metadata);
    expect(local).toContain('1. 未登记ID Topic 2');
    expect(local).toContain('2. ID301 Topic 1');
});

test('an unregistered failed result never borrows an ID from the registered result subset', () => {
    const failed = { ...rendered(1, 0), reviewIndex: undefined, uploadReady: false,
        output: { mediaPath: null, mediaError: 'encode failed' } };
    const value = { ...rendered(1, 80), copy: { title: 'Successful result' } };
    const local = report.buildTopicReviewMarkdown([failed, value], {
        automaticPublication: { enabled: true }, uploadRegistry: { clipIdsByReviewIndex: { 1: 301 } }
    });
    expect(local).toContain('1. 未登记ID Topic 1');
    expect(local).toContain('2. ID301 Successful result');
});

test('disabled topic reporting retains existing context and failure diagnostics', () => {
    const value: any = rendered(1, 20);
    value.window.contextSegments = [{ text: '保留命中上下文' }];
    const notification = report.buildTopicNotifyMarkdown([{ ...value, uploadId: 71 }], {
        failures: [{ stage: 'cover', error: 'cover renderer unavailable' }]
    });
    expect(notification).toContain('ID 71');
    expect(notification).toContain('保留命中上下文');
    expect(notification).toContain('[失败/封面生成]');
    expect(notification).toContain('cover renderer unavailable');
    expect(notification).not.toContain('自动入队');
});
