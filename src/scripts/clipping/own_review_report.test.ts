import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('node-fetch', () => jest.fn());
jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), spawnSync: jest.fn() }));

const own = require('../own_stream_clipper');
const report = require('./own_review_report');
const artifacts = require('./own_review_artifacts');
const fetch = require('node-fetch');
const child = require('child_process');

function clip(index, start, pending = false) {
  return { window: { index, start, end: start + 10, duration: 10 },
    copy: { title: `Clip ${index}`, description: 'Description', coverText: 'Cover' },
    publicCopyPending: pending, uploadReady: !pending,
    ...(pending ? { attributionRequired: true, attributionReview: { status: 'needs_review', issues: ['actor_review_unavailable'], reason: 'No review result' },
      grounding: { issues: ['missing_speech_evidence'], subtitles: [{ id: 'G2', text: 'Recorded words' }] } } : {}),
    output: { mediaPath: `/clips/${index}.mp4`, srtPath: `/clips/${index}.srt` } };
}

describe('one chronological own-stream review with durable IDs', () => {
  afterEach(() => jest.restoreAllMocks());

  test('shows only final-window editorial hints without changing public copy or approval', () => {
    const value = { ...clip(1, 10, true), viewingAngles: [{ label: '角色互动', hook: '寻找伙伴' }],
      quoteEchoes: [{ start: 12, quote: '妈妈来了' }],
      candidate: { viewingAngles: [{ label: '战斗', hook: '已排除的后续战斗' }] } };
    const before = JSON.stringify(value.copy);
    const text = report.reviewDetailLines(value).join('\n');
    expect(text).toContain('看点线索（待核）: 角色互动：寻找伙伴');
    expect(text).not.toContain('已排除的后续战斗');
    expect(text).toContain('台词线索（字幕/弹幕重合）: 2.0秒 妈妈来了');
    expect(JSON.stringify(value.copy)).toBe(before);
    expect(report.uploadEligible(value)).toBe(false);
  });

  test('groups subtitle review suggestions without granting upload approval or hiding occurrences', () => {
    const value = { ...clip(1, 10, true), subtitleProofreading: { automaticEdits: [{ ruleId: 'name' }],
      reviewGroups: [{ type: 'possible_foreign_audio', occurrences: [11, 12, 13, 14, 15].map(start => ({ start, end: start + 1 })) }] } };
    const lines = report.reviewDetailLines(value);
    expect(lines.filter(line => line.includes('字幕复核建议'))).toHaveLength(1);
    expect(lines.join('\n')).toContain('5处');
    expect(lines.join('\n')).toContain('自动字幕校对: 1处');
    expect(report.uploadEligible(value)).toBe(false);
  });

  test('ready, held, and rejected entries remain in one time-ordered list with their actual IDs', () => {
    const values = [clip(1, 100), clip(2, 20, true), { ...clip(3, 60, true), selectionRejection: { reason: 'duration_out_of_bounds' } }];
    const metadata = { uploadRegistry: { clipIds: [101, 202, 303], clipIdsByReviewIndex: { 1: 101, 2: 202, 3: 303 } },
      aiStatus: { attribution: { dialogueError: 'Invalid dialogue turn evidence' } } };
    const message = own.buildNotifyMarkdown(values, metadata);
    expect(message.indexOf('1. ID202')).toBeLessThan(message.indexOf('2. ID303'));
    expect(message.indexOf('2. ID303')).toBeLessThan(message.indexOf('3. ID101'));
    expect(message).toMatch(/\n\n2\. ID303/u);
    expect(message).toMatch(/\n\n3\. ID101/u);
    for (const text of ['复核不可用', '已剔除（未切）', '成片待审核', '未获得可用的人物复核结果', 'Recorded words', '人物或对话证据未通过']) expect(message).toContain(text);
    expect(report.diagnosticLines(metadata).join('\n')).toContain('Invalid dialogue turn evidence');
    expect(message).toContain('上传短ID: 101');
    expect(message).not.toContain('未登记ID');
    expect(message).not.toContain('核对项');
    expect(message).not.toContain('actor_review_unavailable');
  });

  test('WeCom omits issue diagnostics while the local review keeps them and both preserve the useful context', () => {
    const held = clip(1, 0, true);
    held.attributionReview.issues = ['danmaku_outside_clip:D7', 'unsupported_quote:title:原话'];
    held.attributionReview.reason = '请核对片中的问答对象和引号原话。';
    const metadata = { uploadRegistry: { clipIdsByReviewIndex: { 1: 81 },
      reviewIssuesByReviewIndex: { 1: ['invalid_action_citation:1'] } } };
    const before = JSON.stringify(held);
    const notification = own.buildNotifyMarkdown([held], metadata);
    const local = own.buildReviewMarkdown([held], metadata);
    for (const detail of ['核对项:', 'danmaku_outside_clip:D7', 'unsupported_quote:title:原话', 'invalid_action_citation:1']) {
      expect(notification).not.toContain(detail);
      expect(local).toContain(detail);
    }
    for (const text of ['ID81', 'Recorded words', '状态: 待复核']) {
      expect(notification).toContain(text);
      expect(local).toContain(text);
    }
    expect(notification).toContain('理由: 引用弹幕不在本段；引号内容与原话不符');
    expect(notification).toContain('SRT: G2 “Recorded words”');
    expect(notification).toContain('弹幕: 未引用相关弹幕');
    expect(local).toContain('复核说明: 请核对片中的问答对象和引号原话。');
    expect(local).toContain('原文节选: G2 Recorded words');
    expect(JSON.stringify(held)).toBe(before);
    expect(report.uploadEligible(held)).toBe(false);
  });

  test('a missing reviewer explanation gets a short actionable message without exposing codes', () => {
    const held = clip(1, 0, true);
    held.attributionReview.reason = '';
    const message = own.buildNotifyMarkdown([held], { uploadRegistry: { clipIds: [82] } });
    expect(message).toContain('未获得可用的人物复核结果');
    expect(message).toContain('SRT:');
    expect(message).not.toContain('核对项');
    expect(message).not.toContain('actor_review_unavailable');
  });

  test('sorting never swaps legacy positional IDs or sparse explicit IDs', () => {
    const values = [clip(1, 100), clip(2, 20)];
    const legacy = own.buildNotifyMarkdown(values, { uploadRegistry: { clipIds: [40, 50] } });
    expect(legacy).toContain('1. ID50 Clip 2');
    expect(legacy).toContain('2. ID40 Clip 1');
    const sparse = own.buildNotifyMarkdown(values, { uploadRegistry: { clipIds: [40], clipIdsByReviewIndex: { 1: 40 } } });
    expect(sparse).toContain('1. 未登记ID Clip 2');
    expect(sparse).toContain('2. ID40 Clip 1');
  });

  test('exposes media failures, review failures, and skipped planning requests instead of a success-only summary', () => {
    const value = { ...clip(1, 0), uploadReady: false, output: { mediaPath: '/clip.mp4', mediaError: 'encoder failed' } };
    const message = own.buildNotifyMarkdown([value], { aiStatus: { requests: [{ phase: 'recall-1', status: 'failure', error: 'request failed' }],
      attribution: { events: [{ phase: 'dialogue-evidence', clipIds: ['c1'], error: 'invalid evidence' }] } },
      uploadRegistry: { clipIdsByReviewIndex: { 1: 70 } } });
    expect(message).toContain('制作异常');
    expect(message).toContain('理由: 视频制作失败');
    expect(own.buildReviewMarkdown([value], {}).includes('encoder failed')).toBe(true);
    expect(message).toContain('智能审核：审核未完成');
    expect(message).toContain('人物复核（编号70）：人物或对话证据未通过');
    expect(report.diagnosticLines({ aiStatus: { requests: [{ phase: 'recall-1', status: 'failure', error: 'request failed' }] } }).join('\n')).toContain('request failed');
    expect(message).toContain('暂不可上传');
  });

  test('an entirely failed batch still sends diagnostics', async () => {
    fetch.mockReset();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
    await expect(own.notifyResults([], { fatalError: 'planning failed' }, { wechatWork: { webhookUrl: 'https://example.test/robot' } })).resolves.toBe(true);
    expect(JSON.parse(fetch.mock.calls[0][1].body).markdown.content).toContain('批次处理：处理未完成');
  });

  test('ambiguous review indices cannot be registered', () => {
    expect(() => own.writeOwnUploadManifest('/unused.json', '/unused.md', [clip(1, 0), clip(1, 20)], {})).toThrow('Duplicate review indices');
  });

  test('published and active upload states are not mislabeled as awaiting review', () => {
    const message = own.buildNotifyMarkdown([clip(1, 0), clip(2, 20)], { uploadRegistry: {
      clipIdsByReviewIndex: { 1: 11, 2: 12 }, clipStatusByReviewIndex: { 1: 'uploaded', 2: 'queued' }
    } });
    expect(message).toContain('状态: 已上传');
    expect(message).toContain('状态: 已排队上传');
    expect(message).toContain('成片待审核 0');
  });

  test('editorially skipped candidates show the retained topic and no request for another approval', () => {
    const text = own.buildNotifyMarkdown([{ ...clip(1, 0, true), selectionRejection: { reason: 'public_copy_evidence_dropped' } }], {
      automaticPublication: { enabled: true }, uploadRegistry: { clipIdsByReviewIndex: { 1: 3106 },
        clipStatusByReviewIndex: { 1: 'cancelled' }, editorialExclusionsByReviewIndex: {
          1: { reason: '同属雷神理发主题，本场只保留ID3107' }
        } }
    });
    expect(text).toContain('已跳过 1');
    expect(text).toContain('待人工复核或异常 0');
    expect(text).toContain('同属雷神理发主题，本场只保留编号3107');
    expect(text).not.toContain('回复编号');
    expect(text).not.toContain('暂不可上传');
  });

  test('automatic list uses durable uploaded and queued states, and asks only unresolved clips for review', () => {
    const passed = index => ({ ...clip(index, index * 20), automaticPublicationRequired: true,
      publicationReview: { status: 'passed', issues: [] }, publicationDecision: { action: 'auto_queue', reasons: [] } });
    const values = [passed(1), passed(2), { ...passed(3), publicationReview: { status: 'needs_review',
      issues: ['片尾没有完成回答，请核对最后一句。', 'final_content_not_passed'] },
      publicationDecision: { action: 'needs_human', reasons: ['publication_review_needs_review'] } }, passed(4)];
    const metadata = { automaticPublication: { enabled: true, mode: 'auto' }, uploadRegistry: {
      clipIdsByReviewIndex: { 1: 41, 2: 42, 3: 43, 4: 44 }, clipStatusByReviewIndex: { 1: 'uploaded', 2: 'queued' },
      reviewPendingByReviewIndex: { 3: true }, bvIdsByReviewIndex: { 1: 'BV1neverInclude' }
    } };
    const message = own.buildNotifyMarkdown(values, metadata);
    expect(message).toContain('已投稿 1 | 已排队 1');
    expect(message).toContain('待入队 1 | 待人工复核或异常 1');
    expect(message).toContain('状态: 已投稿');
    expect(message).toContain('状态: 已排队投稿');
    expect(message).toContain('状态: 待人工复核');
    expect(message).toContain('片尾没有完成回答，请核对最后一句');
    expect(message).toContain('状态: AI审核通过（待入投稿队列）');
    expect(message).not.toContain('成片待审核');
    expect(message).not.toContain('BV1neverInclude');
    expect(message).not.toContain('final_content_not_passed');
    expect(message).not.toContain('上传短ID');
    expect(message).not.toContain('不代表已审核或已授权上传');
    expect(report.uploadEligible(values[2])).toBe(false);
    expect(own.buildReviewMarkdown(values, metadata)).toContain('final_content_not_passed');
  });

  test('automatic approval cannot be inferred from uploadReady, or a stale reviewer pass without an enqueue decision', () => {
    const value = { ...clip(1, 0), automaticPublicationRequired: true };
    expect(report.uploadEligible(value)).toBe(false);
    expect(report.reviewStatus(value)).toBe('最终复核不可用');
    const unavailable = own.buildNotifyMarkdown([value], { automaticPublication: { enabled: true }, uploadRegistry: { clipIds: [91] } });
    expect(unavailable).toContain('未获得可用的最终成片审核');
    expect(report.uploadEligible({ ...value, publicationReview: { status: 'passed' } })).toBe(false);
    expect(report.uploadEligible({ ...value, ownStreamHumanReview: { status: 'approved' } })).toBe(true);
  });

  test('per-ID automatic enqueue rejection and duplicate receipts replace stale waiting labels', () => {
    const values = [1, 2, 3, 4].map(index => ({ ...clip(index, index * 20), automaticPublicationRequired: true,
      publicationReview: { status: 'passed', issues: [] }, publicationDecision: { action: 'auto_queue', reasons: [] } }));
    const metadata = { automaticPublication: { enabled: true, mode: 'auto', results: [
      { id: 51, status: 'needs_human', error: 'stale error already resolved' },
      { id: 52, status: 'needs_human', error: '授权配置已变化，需要重新核对' },
      { id: 53, status: 'duplicate', duplicateOf: 51 }, { id: 54, status: 'needs_human' }
    ] }, uploadRegistry: { clipIdsByReviewIndex: { 1: 51, 2: 52, 3: 53, 4: 54 }, clipStatusByReviewIndex: { 1: 'queued' } } };
    const message = own.buildNotifyMarkdown(values, metadata);
    expect(message).toContain('待入队 0 | 待人工复核或异常 2 | 重复已跳过 1');
    expect(message).toContain('状态: 已排队投稿');
    expect(message).toContain('状态: 自动入队受阻（待处理）');
    expect(message).toContain('授权配置已变化，需要重新核对');
    expect(message).toContain('与既有ID51重复，已跳过，无需处理');
    expect(message).not.toContain('AI审核通过（待入投稿队列）');
    expect(message).not.toContain('stale error already resolved');
    expect(report.diagnosticLines(metadata).join('\n')).toContain('自动入队 ID52: 授权配置已变化');
    expect(report.diagnosticLines(metadata).join('\n')).toContain('自动投稿 ID53: 与既有ID51重复');
  });

  test.each([false, true])('automatic enqueue global errors remain visible and never hide confirmed registry status (%s)', outcomeUnknown => {
    const values = [1, 2].map(index => ({ ...clip(index, index * 20), automaticPublicationRequired: true,
      publicationReview: { status: 'passed', issues: [] }, publicationDecision: { action: 'auto_queue', reasons: [] } }));
    const metadata = { automaticPublication: { enabled: true, mode: 'auto', outcomeUnknown, error: 'Missing automatic enqueue receipt' },
      uploadRegistry: { clipIdsByReviewIndex: { 1: 61, 2: 62 }, clipStatusByReviewIndex: { 1: 'uploaded' } } };
    const message = own.buildNotifyMarkdown(values, metadata);
    expect(message).toContain('已投稿 1');
    expect(message).toContain('待入队 0 | 待人工复核或异常 1');
    expect(message).toContain('状态: 已投稿');
    expect(message).toContain(outcomeUnknown ? '状态: 入队结果待确认（勿重复入队）' : '状态: 自动入队受阻（待处理）');
    expect(message).toContain('自动入队：缺少可确认的入队回执');
    expect(report.diagnosticLines(metadata).join('\n')).toContain('Missing automatic enqueue receipt');
    expect(message).not.toContain('AI审核通过（待入投稿队列）');
  });

  test('queued automatic clips omit stale review prompts, while uploaded clips with current review changes keep the published status', () => {
    const value = clip(1, 0, true);
    const metadata: any = { automaticPublication: { enabled: true }, uploadRegistry: {
      clipIdsByReviewIndex: { 1: 91 }, clipStatusByReviewIndex: { 1: 'queued' }
    } };
    const queued = own.buildNotifyMarkdown([value], metadata);
    expect(queued).not.toContain('请确认');
    expect(queued).not.toContain('暂不可上传');
    metadata.uploadRegistry.clipStatusByReviewIndex[1] = 'uploaded';
    metadata.uploadRegistry.reviewPendingByReviewIndex = { 1: true };
    const uploaded = own.buildNotifyMarkdown([value], metadata);
    expect(uploaded).toContain('已投稿（当前资料待复核）');
    expect(uploaded).toContain('如有异常请在B站修改');
    expect(uploaded).not.toContain('暂不可上传');
  });

  test('explicit human approval resolves the hold without erasing original AI findings', () => {
    const value = { ...clip(1, 0, true), publicCopyPending: false, uploadReady: true,
      grounding: { issues: [] }, ownStreamHumanReview: { status: 'approved', note: 'Source checked' } };
    expect(report.reviewStatus(value)).toContain('人工复核通过');
    expect(report.reviewIssues(value)).toEqual([]);
    expect(value.attributionReview.issues).toEqual(['actor_review_unavailable']);
  });

  test('quick review prioritizes plain questions, actual time and stable ID without showing internal codes', () => {
    const held = { ...clip(4, 50, true), preRenderHold: true, attributionReview: { status: 'needs_review',
      issues: ['model_requires_review'], humanChecks: [{ question: '这是在转述朋友吗？', suggestion: '标题注明回忆',
        evidence: [{ id: 'G9', start: 52, end: 54, text: '朋友当时和我说。' }] }] } };
    const metadata = { uploadRegistry: { clipIdsByReviewIndex: { 4: 912 } } };
    const text = report.quickReviewLines([held, clip(5, 80)], metadata).join('\n');
    expect(text).toContain('ID912');
    expect(text).toContain('片内0:02（录播0:52）');
    expect(text).toContain('这是在转述朋友吗');
    expect(text).not.toContain('model_requires_review');
    expect(text).not.toContain('Clip 5');
    expect(report.uploadEligible(held)).toBe(false);
  });

  test('pending subtitle revisions cannot reuse an old human-approved display status', () => {
    const value = { ...clip(1, 0), uploadReady: true, rebuildRequired: true,
      ownStreamHumanReview: { status: 'approved', note: 'Old review' },
      renderedSubtitles: { revision: 2, path: '/revisions/r2.srt' },
      durationApproval: { note: 'Complete conversation' } };
    expect(report.uploadEligible(value)).toBe(false);
    expect(report.reviewStatus(value)).toContain('待重压');
    expect(report.reviewDetailLines(value).join('\n')).toContain('Complete conversation');
    expect(report.reviewDetailLines(value).join('\n')).toContain('r2');
  });

  test('refresh reserves held/rejected IDs without calling models or cutting media, and is notification-idempotent', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'own-review-refresh-'));
    const cut = jest.spyOn(require('../topic_clipper'), 'cutClipMedia');
    const model = jest.spyOn(require('../ai_text_generator'), 'generateTextWithDaiYu');
    fetch.mockReset();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
    try {
      const mediaPath = path.join(directory, 'source.flv');
      const srtPath = path.join(directory, 'source.srt');
      fs.writeFileSync(mediaPath, 'source');
      fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:10,000\nFirst source.\n\n2\n00:00:20,000 --> 00:00:30,000\nSecond source.\n');
      const source = { mediaPath, srtPath };
      const results = [clip(1, 0), clip(2, 20, true)].map(result => {
        const metadataPath = path.join(directory, `source_fun_${result.window.index}.json`);
        const value = { ...result, source, roomId: '25788785', output: { ...result.output, metadataPath } };
        fs.writeFileSync(metadataPath, JSON.stringify(value));
        return value;
      });
      const planPath = path.join(directory, 'PLAN.json');
      fs.writeFileSync(planPath, JSON.stringify({ source, clips: results.map(result => result.window), config: { maxClipSeconds: 15 },
        precisionExperiment: { total: 2, maxSelected: 0, eligibleCount: 2, selected: [], status: 'ordinary_control', reason: 'batch_below_minimum' },
        aiStatus: { validation: { rejected: [{ candidateIndex: 9, title: 'Long source', startCueId: 'G1', endCueId: 'G2', reason: 'duration_out_of_bounds' }] } } }));
      const ids = new Map();
      child.spawnSync.mockImplementation((_python, args) => {
        expect(args).toContain('--include-pending');
        expect(args).not.toContain('enqueue');
        const manifest = JSON.parse(fs.readFileSync(args[args.indexOf('--manifest') + 1], 'utf8'));
        for (const item of manifest.clips) if (!ids.has(item.metadataPath)) ids.set(item.metadataPath, 100 + ids.size);
        return { status: 0, stdout: 'REGISTRY_RESULT: ' + JSON.stringify({ clipIds: manifest.clips.map(item => ids.get(item.metadataPath)),
          clipIdsByReviewIndex: Object.fromEntries(manifest.clips.map(item => [item.reviewIndex, ids.get(item.metadataPath)])) }), stderr: '' };
      });
      const config = { wechatWork: { webhookUrl: 'https://example.test/robot' } };
      const first = await artifacts.refreshReview(planPath, { notify: true, config });
      const delivered = fetch.mock.calls.length;
      expect(fetch.mock.calls.map(([, options]) => JSON.parse(options.body).markdown.content).join('\n')).toContain('本批精切 0 条');
      const second = await artifacts.refreshReview(planPath, { notify: true, config });
      expect(first.totalEntries).toBe(3);
      expect(first.rendered).toBe(2);
      expect(first.rejected).toBe(1);
      expect(second.clipIds).toEqual(first.clipIds);
      expect(fetch).toHaveBeenCalledTimes(delivered);
      const changedPlan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
      const statePath = path.join(directory, 'REVIEW_STATE.json');
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      saved.metadata.aiStatus.ranking = { sourceSha256: 'original', skipped: [{ candidateIndex: 77,
        title: '没找到奶茶', start: 40, end: 50, score: 60, reason: '看点偏弱' }] };
      fs.writeFileSync(statePath, JSON.stringify(saved));
      changedPlan.precisionExperiment.reason = 'selection_failed';
      changedPlan.precisionExperiment.error = 'Selection transport failed';
      fs.writeFileSync(planPath, JSON.stringify(changedPlan));
      await artifacts.refreshReview(planPath, { notify: true, config });
      expect(fetch.mock.calls.length).toBeGreaterThan(delivered);
      expect(fetch.mock.calls.map(([, options]) => JSON.parse(options.body).markdown.content).join('\n')).toContain('审核服务连接失败');
      expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).metadata.deferredSelectionHistory.rows)
        .toEqual(expect.arrayContaining([expect.objectContaining({ label: 'R77', title: '没找到奶茶', score: 60 })]));
      expect(cut).not.toHaveBeenCalled();
      expect(model).not.toHaveBeenCalled();
      const review = fs.readFileSync(path.join(directory, 'REVIEW.md'), 'utf8');
      expect(review).toContain('候选ID:');
      expect(review).toContain('已剔除（未切）');
      const heldFiles = fs.readdirSync(path.join(directory, 'rejected_candidates'));
      expect(heldFiles.some(name => name.endsWith('.srt'))).toBe(true);
      expect(heldFiles.some(name => name.endsWith('.mp4'))).toBe(false);
      const heldPath = path.join(directory, 'rejected_candidates', heldFiles.find(name => name.endsWith('.json')));
      const recovered = JSON.parse(fs.readFileSync(heldPath, 'utf8'));
      recovered.originalSelectionRejection = recovered.selectionRejection;
      delete recovered.selectionRejection;
      recovered.output.mediaPath = path.join(directory, 'recovered.mp4');
      fs.writeFileSync(heldPath, JSON.stringify(recovered));
      const third = await artifacts.refreshReview(planPath, { config });
      expect(third.clipIds).toEqual(first.clipIds);
      expect(third.totalEntries).toBe(3);
      expect(third.rendered).toBe(3);
      expect(third.rejected).toBe(0);
      expect(cut).not.toHaveBeenCalled();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
