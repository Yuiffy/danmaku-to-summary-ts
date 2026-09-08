export {};
const { packActorEvidence, unpackActorEvidence } = require('./actor_evidence_encoding');
const { actorReviewPrompt, buildActorReviewPacket, validateActorReview } = require('./actor_review');
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const make = (id: string, audience: any[]) => ({ id, sourceSha256: 'same', data: {
  clipId: id, start: .001, end: 9.999, sourceKind: 'recount', inRangeCueIds: ['G1'],
  copy: { title: 'A title', description: 'A description', coverText: 'First\nSecond' },
  speech: 'G1 0-10 [V=?] Literal words, quotes " and lines\nG2 10-12 Another speaker.', audience
} });

describe('compact actor evidence', () => {
  test('round trips every speech character, comment occurrence, time and allowed reference', () => {
    const comments = [{ id: 'D1', time: .00123, text: 'A long repeated identity correction with a name and a complete sentence.' },
      { id: 'D2', time: .00234, text: '{"ref":"T1"}' },
      { id: 'D3', time: 1.234567, text: 'A long repeated identity correction with a name and a complete sentence.' }];
    const packets = [make('c1', comments), make('c2', [comments[2]])];
    const original = JSON.stringify(packets);
    const packed = packActorEvidence(packets);
    expect(packed.audienceRows).toHaveLength(3);
    expect(packed.textDictionary).toHaveLength(1);
    expect(unpackActorEvidence(JSON.parse(JSON.stringify(packed)))).toEqual(packets.map(packet => packet.data));
    expect(packed.clips[1].audienceIds).toEqual(['D3']);
    expect(JSON.stringify(packets)).toBe(original);
  });
  test('does not conflate identical text at different timestamps or literal reference-looking strings', () => {
    const rows = [{ id: 'D1', time: 1, text: 'ha' }, { id: 'D2', time: 1.001, text: 'ha' },
      { id: 'D3', time: 2, text: 'T1' }, { id: 'D4', time: 3, text: '\n{}[]\\"' }];
    expect(unpackActorEvidence(packActorEvidence([make('c1', rows)]))[0].audience).toEqual(rows);
  });
  test('rejects mismatched sources, duplicate clip IDs and conflicting D-ID records', () => {
    const first = make('c1', [{ id: 'D1', time: 1, text: 'same' }]);
    expect(() => packActorEvidence([first, { ...make('c2', []), sourceSha256: 'changed' }])).toThrow('one source');
    expect(() => packActorEvidence([first, first])).toThrow('unique');
    expect(() => packActorEvidence([first, make('c2', [{ id: 'D1', time: 1, text: 'changed' }])])).toThrow('Conflicting');
  });
  test('format changes do not expand per-clip citation permissions', () => {
    const evidence = buildSubtitleEvidence([{ start: 0, end: 10, text: 'A startup failure.' }]);
    const clip = { start: 0, end: 10, title: 'A startup failure', description: 'A startup failure.', coverText: 'Startup\nFailure' };
    const packet = buildActorReviewPacket(clip, 'c1', evidence, [{ time: 11, text: 'Outside!' }], { people: [] });
    actorReviewPrompt([packet], { people: [] });
    const issues = validateActorReview({ clipId: 'c1', decision: 'accept', copy: clip,
      claims: [{ fields: ['title', 'coverText', 'description'], action: 'Startup failure', narrator: null, actor: null,
        target: null, sourceKind: 'live_speech', identityBasis: 'unresolved', cueIds: ['G1'] }], evidenceDanmakuIds: ['D1'] }, packet);
    expect(issues).toContain('unseen_danmaku:D1');
    expect(issues).toContain('danmaku_outside_clip:D1');
  });
  test('supports an explicit legacy control without silently accepting unknown encodings', () => {
    const packets = [make('c1', [])];
    expect(actorReviewPrompt(packets, {}, { evidenceEncoding: 'legacy' })).toContain(JSON.stringify(packets[0].data));
    expect(() => actorReviewPrompt(packets, {}, { evidenceEncoding: 'invalid' })).toThrow();
  });
});
