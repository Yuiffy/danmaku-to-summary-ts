const coverage = require('./stream_game_coverage');

const plan = (spans: Array<[number, number]>) => ({
  sessionId: 'fixture-session',
  duration: 8 * 3600,
  source: { mediaPath: 'recording.flv' },
  rawEvents: spans.map(([start, end], index) => ({ id: `e${index + 1}`, gameId: 'g1', start: start * 60, end: end * 60 }))
});

/** A timeline that keeps exactly the supplied minute ranges at a two-minute cadence. */
const timeline = (ranges: Array<[number, number]>, duration = 8 * 3600) => {
  const samples: Array<{ index: number; time: number }> = [];
  for (let time = 0, index = 1; time < duration - .5; time += 120, index++) samples.push({ index, time });
  const rows: any[] = [];
  for (const sample of samples) {
    const kind = ranges.some(([from, to]) => sample.time >= from * 60 && sample.time <= to * 60) ? 'gameplay' : 'other';
    const last = rows.at(-1);
    if (last && last.kind === kind) last.last = sample.index;
    else rows.push({ first: sample.index, last: sample.index, kind, gameId: kind === 'gameplay' ? 'g1' : null, note: kind });
  }
  return { samples, ranges: rows };
};

describe('game clip coverage guard', () => {
  test('reports a long claimed window that is only partly kept', () => {
    // 2026-11-01 before the repair: a 229 minute claim kept as 133 minutes.
    const report = coverage.coverageReport(plan([[163, 392]]), timeline([[163, 296]]), {});
    expect(report.alert).toBe(true);
    expect(Math.round(report.claimSeconds / 60)).toBe(229);
    // Sample cadence bounds the last kept minute, so the kept side is one sample short.
    expect(Math.round(report.keptSeconds / 60)).toBe(132);
    expect(Math.round(report.droppedSeconds / 60)).toBe(97);
    expect(report.windows).toHaveLength(1);
    const parts = report.windows[0].droppedParts;
    expect(parts.reduce((total: number, part: any) => total + part.end - part.start, 0)).toBeGreaterThan(95 * 60);
  });

  test('stays quiet when the claimed window is kept whole', () => {
    const report = coverage.coverageReport(plan([[163, 392]]), timeline([[163, 392]]), {});
    expect(report.alert).toBe(false);
    expect(report.droppedSeconds).toBeLessThan(120);
  });

  test('never raises a fully dropped claim: boundary review already has to justify it', () => {
    const report = coverage.coverageReport(plan([[75, 93], [402, 444]]), timeline([[163, 392]]), {});
    expect(report.alert).toBe(false);
    expect(report.windows).toHaveLength(0);
    expect(report.untouched.map((row: any) => Math.round(row.seconds / 60))).toEqual([18, 42]);
  });

  test('keeps sub-threshold losses in the report without calling them out', () => {
    const report = coverage.coverageReport(plan([[100, 160]]), timeline([[100, 145]]), { minDroppedSeconds: 1200, ratio: .15 });
    expect(report.alert).toBe(false);
    expect(report.droppedSeconds).toBeGreaterThan(14 * 60);
    expect(report.droppedSeconds).toBeLessThan(17 * 60);
  });

  test('computes the gaps left by a keep range in the middle of a claim', () => {
    const parts = coverage.droppedParts({ start: 0, end: 100 }, [{ start: 20, end: 40 }, { start: 60, end: 80 }]);
    expect(parts).toEqual([{ start: 0, end: 20 }, { start: 40, end: 60 }, { start: 80, end: 100 }]);
  });
});
