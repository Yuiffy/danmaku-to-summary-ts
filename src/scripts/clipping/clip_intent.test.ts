import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const selection = require('./own_selection');
const { buildCandidateCards, packCandidateCards, unpackCandidateCards } = require('./ranked_editorial');
const { prepareReviewResults } = require('./own_review_state');
const report = require('./own_review_report');

test('a sparse viewer request recalls the preceding story and reaches ranking with independent source evidence', () => {
  const parsed = { segments: [{ start: 80, end: 90, text: '完整原话' }] };
  const audience = [{ time: 100, text: '@鹿饼 我要这段' }];
  const config = { prePaddingSeconds: 10, postPaddingSeconds: 20, windowSeconds: 60,
    minClipSeconds: 10, maxClipSeconds: 180, mergeGapSeconds: 0, maxCandidates: 10, minDanmakuCount: 999, reactionKeywords: [], subtitleKeywords: [] };
  const candidates = selection.buildCandidateWindows(parsed, audience, config, 300);
  expect(candidates).toEqual([expect.objectContaining({ start: 40, end: 120, reason: 'danmaku_clip_intent',
    scoreComponents: expect.objectContaining({ intent: 100 }) })]);
  const packet = buildCandidateCards(candidates, parsed, audience, { ai: {} });
  expect(unpackCandidateCards(packCandidateCards(packet.cards))[0].clipIntent).toMatchObject({ needsHumanReview: false,
    signals: [{ source: 'danmaku', action: 'request', text: audience[0].text }] });
});

test('a detail-generation rejection keeps the no-clip evidence and is presented as awaiting human judgment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-intent-'));
  try {
    const parsed = { segments: [{ start: 10, end: 15, text: '这个别切了' }] };
    const plan = { source: { mediaPath: 'fixture.mp4' }, aiStatus: { validation: { rejected: [
      { candidateIndex: 1, start: 10, end: 20, reason: 'detail_generation_failed' } ] } } };
    const [held] = prepareReviewResults([], plan, parsed, root, [{ time: 17, text: '@鹿饼 这段别切' }]);
    expect(held.clipIntent).toMatchObject({ needsHumanReview: true, signals: [{ source: 'asr' }, { source: 'danmaku' }] });
    expect(report.reviewStatus(held)).toBe('别切意图待人工核对');
    expect(report.reviewIssues(held)[0]).toContain('ASR疑似');
    expect(report.reviewIssues(held)).toContain('selection_rejected:detail_generation_failed');
    expect(report.summaryLines([held])[0]).toContain('待复核或异常 1 | 剔除 0');
    expect(report.uploadEligible(held)).toBe(false);
    expect(report.uploadEligible({ ...held, selectionRejection: null, publicCopyPending: false, uploadReady: true })).toBe(false);
    expect(JSON.parse(fs.readFileSync(held.output.metadataPath, 'utf8')).clipIntent.needsHumanReview).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
