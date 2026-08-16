import {
  buildResidualCandidates,
  buildResidualReview,
} from './own_stream_residual_audit';

describe('own_stream_residual_audit', () => {
  test('ranks uncovered text windows and excludes automatic clip windows', () => {
    const segments = Array.from({ length: 12 }, (_, index) => ({
      start: index * 30,
      end: index * 30 + 20,
      text: index < 4 ? '电影内容' : '显卡预算怎么一路涨价，哈哈但是还想等双十一'
    }));
    const candidates = buildResidualCandidates({
      segments,
      selectedWindows: [{ start: 120, end: 180 }],
      windowSeconds: 90,
      stepSeconds: 45,
      maxCandidates: 4,
      danmaku: [{ time: 240, text: '哈哈' }, { time: 250, text: '涨价' }]
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every(item => item.end <= 120 || item.start >= 180)).toBe(true);
    expect(candidates.some(item => item.keywordHits > 0)).toBe(true);
  });

  test('writes an explicit manual-review status', () => {
    const review = buildResidualReview({
      sourcePath: 'recording.srt',
      selectedWindows: [{ start: 0, end: 60 }],
      candidates: [{
        start: 120,
        end: 210,
        score: 42,
        subtitleChars: 120,
        danmakuCount: 8,
        keywordHits: 3,
        sample: '显卡预算一路涨价'
      }]
    });

    expect(review).toContain('残余高光审计');
    expect(review).toContain('状态: 待人工确认');
    expect(review).toContain('显卡预算一路涨价');
  });
});
