import { candidateDeathScore, clusterCandidates, histogramDistance, summarize } from './stream_game_local_cv';

describe('stream game local visual evidence', () => {
  test('scores a dark red overlay as a candidate without declaring death', () => {
    const score = candidateDeathScore({ meanLuma: 0.25, redRatio: 0.08, whiteRatio: 0.15, edgeRatio: 0.02 });
    expect(score).toBeGreaterThan(0.5);
  });

  test('clusters nearby candidate samples and keeps separated attempts distinct', () => {
    const rows = [
      { index: 1, time: 100, deathScore: 0.8 },
      { index: 2, time: 104, deathScore: 0.7 },
      { index: 3, time: 130, deathScore: 0.9 },
      { index: 4, time: 131, deathScore: 0.1 },
    ];
    expect(clusterCandidates(rows)).toEqual([
      { start: 100, end: 104, score: 0.8, samples: [1, 2] },
      { start: 130, end: 130, score: 0.9, samples: [3] },
    ]);
  });

  test('reports scene changes and summary counts', () => {
    expect(histogramDistance({ meanLuma: 0.1, darkRatio: 0.9, redRatio: 0, edgeRatio: 0.01 },
      { meanLuma: 0.8, darkRatio: 0.1, redRatio: 0, edgeRatio: 0.5 })).toBeGreaterThan(0.48);
    expect(summarize({ method: 'local_frame_metrics', sampleCount: 10, sceneCuts: [{ time: 1 }], deathCandidates: [{ start: 2, end: 3, score: 0.8 }] }))
      .toEqual({ method: 'local_frame_metrics', sampleCount: 10, sceneCutCount: 1, deathCandidateCount: 1, deathCandidates: [{ start: 2, end: 3, score: 0.8 }] });
  });
});
