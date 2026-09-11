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
    for (const text of ['复核不可用', '已剔除（未切）', '成片待审核', 'No review result', 'Recorded words', 'Invalid dialogue turn evidence']) expect(message).toContain(text);
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
    for (const text of ['ID81', '复核说明: 请核对片中的问答对象和引号原话。', '原文节选: G2 Recorded words', '状态: 待复核']) {
      expect(notification).toContain(text);
      expect(local).toContain(text);
    }
    expect(JSON.stringify(held)).toBe(before);
    expect(report.uploadEligible(held)).toBe(false);
  });

  test('a missing reviewer explanation gets a short actionable message without exposing codes', () => {
    const held = clip(1, 0, true);
    held.attributionReview.reason = '';
    const message = own.buildNotifyMarkdown([held], { uploadRegistry: { clipIds: [82] } });
    expect(message).toContain('未获得可用的人物复核结果，需要人工确认片中人物和动作');
    expect(message).toContain('原文节选:');
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
    expect(message).toContain('encoder failed');
    expect(message).toContain('request failed');
    expect(message).toContain('invalid evidence [ID70]');
    expect(message).toContain('暂不可上传');
  });

  test('an entirely failed batch still sends diagnostics', async () => {
    fetch.mockReset();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
    await expect(own.notifyResults([], { fatalError: 'planning failed' }, { wechatWork: { webhookUrl: 'https://example.test/robot' } })).resolves.toBe(true);
    expect(JSON.parse(fetch.mock.calls[0][1].body).markdown.content).toContain('planning failed');
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

  test('explicit human approval resolves the hold without erasing original AI findings', () => {
    const value = { ...clip(1, 0, true), publicCopyPending: false, uploadReady: true,
      grounding: { issues: [] }, ownStreamHumanReview: { status: 'approved', note: 'Source checked' } };
    expect(report.reviewStatus(value)).toContain('人工复核通过');
    expect(report.reviewIssues(value)).toEqual([]);
    expect(value.attributionReview.issues).toEqual(['actor_review_unavailable']);
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
      changedPlan.precisionExperiment.reason = 'selection_failed';
      changedPlan.precisionExperiment.error = 'Selection transport failed';
      fs.writeFileSync(planPath, JSON.stringify(changedPlan));
      await artifacts.refreshReview(planPath, { notify: true, config });
      expect(fetch.mock.calls.length).toBeGreaterThan(delivered);
      expect(fetch.mock.calls.map(([, options]) => JSON.parse(options.body).markdown.content).join('\n')).toContain('Selection transport failed');
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
