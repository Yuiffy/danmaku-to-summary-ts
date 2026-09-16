export {};
jest.mock('node-fetch', () => jest.fn());
const fs = require('fs');
const os = require('os');
const path = require('path');
const fetchMock = require('node-fetch');
const topic = require('../topic_clipper');
const { buildTopicDedupeFailures } = require('./topic_failure_details');
const { persistPreflightPlan, preflightRequestOptions } = require('./preflight_runner');

const clip = (index, start, end, title = index) => ({
  window: { index, start, end, contextSegments: [] }, aiTitle: title, editorial: { event: title, score: 80 },
  preflight: { status: 'ready' }
});

describe('topic failure visibility', () => {
  test('identifies a fully covered suppressed candidate and its retained replacement', () => {
    const kept = clip('E5-2', 7288.449, 7414.949, '保留的完整事件');
    const dropped = clip('E6-1', 7293.689, 7414.949, '重复事件');
    const failures = buildTopicDedupeFailures([kept, dropped], [kept]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: 'overlap_suppressed', candidateId: 'E6-1',
      title: '重复事件', retainedClips: [{ candidateId: 'E5-2' }], uncoveredRanges: [], uncoveredSeconds: 0 });
    const markdown = topic.buildTopicNotifyMarkdown([{ ...kept, copy: { title: kept.aiTitle },
      output: { mediaPath: 'kept.mp4' }, uploadId: 2225 }], { failures });
    expect(markdown).toContain('E6-1');
    expect(markdown).toContain('E5-2');
    expect(markdown).toContain('2225');
    expect(markdown).toContain('时间区间已被保留候选完全覆盖');
    expect(markdown).not.toContain('请核对 TOPIC_PLAN');
  });

  test('lists unique time and source text lost by overlap suppression', () => {
    const dropped = clip('old', 10, 100, '完整铺垫和反应');
    dropped.window.contextSegments.push({ start: 15, end: 20, text: 'Only this candidate has the setup.' });
    const kept = clip('new', 60, 150, '保留片段');
    const failures = buildTopicDedupeFailures([dropped, kept], [kept]);
    expect(failures[0]).toMatchObject({ uncoveredRanges: [{ start: 10, end: 60 }], uncoveredSeconds: 50 });
    const markdown = topic.buildTopicNotifyMarkdown([], { failures });
    expect(markdown).toContain('00:00:10-00:01:00');
    expect(markdown).toContain('50秒');
    expect(markdown).toContain('Only this candidate has the setup.');
    expect(markdown).toContain('存在漏片风险');
  });

  test('subtracts all retained intervals without double-counting overlap', () => {
    const dropped = clip('dropped', 0, 100);
    const kept = [clip('a', 0, 40), clip('b', 30, 50), clip('c', 70, 120)];
    expect(buildTopicDedupeFailures([dropped, ...kept], kept)[0])
      .toMatchObject({ uncoveredRanges: [{ start: 50, end: 70 }], uncoveredSeconds: 20 });
  });

  test('does not say every candidate was rendered when only human review is pending', () => {
    const markdown = topic.buildTopicNotifyMarkdown([{
      window: { index: 'E4-1', start: 2470.05, end: 2541.434 },
      status: 'pending_preflight', candidateId: 712, copy: { title: '人见人爱但人人叫错名字' }, output: { mediaPath: null },
      aiReview: { mode: 'preflight', status: 'needs_review', quality: { issues: ['unsupported_number:description:67'] },
        warnings: ['字幕未能确认投票百分比。'] }
    }]);
    expect(markdown).toContain('成功生成 **0** 段');
    expect(markdown).toContain('待预审 **1** 段');
    expect(markdown).toContain('E4-1');
    expect(markdown).toContain('候选ID 712');
    expect(markdown).toContain('00:41:10-00:42:21');
    expect(markdown).toContain('简介中的数字缺少证据：67');
    expect(markdown).toContain('字幕未能确认投票百分比。');
    expect(markdown).not.toContain('已分别切为切片');
  });

  test('sends all held candidates and reasons even without a separate error record', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
    const pending = Array.from({ length: 30 }, (_, index) => ({
      window: { index: `E${index + 1}`, start: index * 300, end: index * 300 + 60,
        matchSegments: [{ start: index * 300, end: index * 300 + 2, text: `命中原话${index + 1}` }] },
      status: 'pending_preflight', copy: { title: `待审候选${index + 1}` }, output: { mediaPath: null },
      aiReview: { mode: 'preflight', status: 'needs_review',
        quality: { issues: ['Model requests human review or identity remains uncertain'] },
        warnings: [`核查说明${index + 1}：${'缺少独立字幕证据。'.repeat(10)}`] }
    }));
    await topic.notifyTopicClipResults(pending, {}, { clipTopics: { notify: { enabled: true } },
      wechatWork: { webhookUrl: 'https://example.test/robot' } });
    const parts = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).markdown.content);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every(part => Buffer.byteLength(part, 'utf8') <= 4096)).toBe(true);
    const text = parts.join('\n');
    for (let i = 1; i <= 30; i++) {
      expect(text).toContain(`待审候选${i}`);
      expect(text).toContain(`核查说明${i}：`);
      expect(text).toContain(`命中原话${i}`);
    }
  });

  test('persists suppressed candidates alongside selected ones for recovery', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-suppressed-'));
    const kept = clip('kept', 0, 100), dropped = clip('dropped', 10, 80);
    try {
      const file = path.join(dir, 'plan.json');
      persistPreflightPlan(file, 'source.mp4', 'source-hash', [], [kept, dropped],
        { requests: [], failures: [] }, [kept]);
      const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(plan.candidates.map(item => [item.window.index, item.selected])).toEqual([
        ['kept', true], ['dropped', false]
      ]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('opts preflight into one bounded daiYu retry without changing model or reasoning', () => {
    const options = preflightRequestOptions({ review: { model: 'gpt-5.6-sol', reasoningEffort: 'high' } });
    expect(options).toMatchObject({ primaryModel: 'gpt-5.6-sol', reasoningEffort: 'high',
      daiYuTransientMaxAttempts: 2, allowProviderFallback: false });
    expect(preflightRequestOptions({ review: { transientMaxAttempts: 1 } }).daiYuTransientMaxAttempts).toBe(1);
  });
});
