const {
  mergeOverlappingEvents,
  normalizeEventManifest,
  selectNonOverlappingEvents
} = require('./event_manifest');

describe('event_manifest', () => {
  test('normalizes detector aliases into the shared event shape', () => {
    const manifest = normalizeEventManifest({
      source: { id: 'stream-a', mediaPath: 'D:/recording.flv' },
      selectedEvents: [{
        eventId: 'limiter-0001',
        firstHit: 10,
        lastHit: 12,
        peakScore: 0.91,
        evidence: ['audio', 'srt']
      }]
    });

    expect(manifest.version).toBe(1);
    expect(manifest.events[0]).toEqual({
      id: 'limiter-0001',
      sourceId: 'stream-a',
      start: 10,
      end: 12,
      duration: 2,
      score: 0.91,
      label: null,
      evidence: ['audio', 'srt'],
      metadata: {}
    });
  });

  test('merges overlapping events without losing evidence', () => {
    const merged = mergeOverlappingEvents([
      { id: 'a', start: 10, end: 12, score: 0.5, evidence: ['audio'] },
      { id: 'b', start: 11.5, end: 14, score: 0.8, evidence: ['danmaku'] }
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      id: 'b',
      sourceId: 'source-1',
      start: 10,
      end: 14,
      duration: 4,
      score: 0.8,
      label: null,
      evidence: ['audio', 'danmaku'],
      metadata: {}
    });
  });

  test('selects high-scoring non-overlapping events in timeline order', () => {
    const selected = selectNonOverlappingEvents([
      { id: 'low', start: 10, end: 14, score: 0.2 },
      { id: 'high', start: 11, end: 12, score: 0.9 },
      { id: 'later', start: 20, end: 21, score: 0.4 }
    ], { maxEvents: 2 });

    expect(selected.map(event => event.id)).toEqual(['high', 'later']);
  });

  test('rejects reversed event boundaries', () => {
    expect(() => normalizeEventManifest({
      source: { mediaPath: 'recording.flv' },
      events: [{ start: 5, end: 4 }]
    })).toThrow(/requires start < end/);
  });
});
