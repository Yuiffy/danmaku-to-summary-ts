const { buildPersonEvidenceContext } = require('./person_evidence');
const { buildSubtitleEvidence, linkClipEvidence, revalidateClipEvidence } = require('./subtitle_evidence');

const registry = {
  ai: { streamerRegistry: {
    host: { displayName: 'Host', roomIds: ['1'], searchTags: ['HostName'], aiClipName: 'HostClip' },
    guest: { displayName: 'Guest', searchTags: ['GuestName'], aiClipName: 'GuestClip',
      aliases: ['guessedName'], mentionLabels: ['looseLabel'], speakerLabels: ['speakerGuess'] },
    rhea: { displayName: 'Rhea' }
  } }
};
const people = buildPersonEvidenceContext(registry, '1');
const bounds = { start: 0, end: 10 };

function check(copy = {}, rows = [{ start: 0, end: 10, text: 'A message was left.' }],
  comments = [], refs = {}, available = {}) {
  const evidence = buildSubtitleEvidence(rows, { groupSegments: false });
  const raw = { ...copy, sourceKind: 'recount', evidenceCueIds: ['G1'], ...refs };
  const grounding = linkClipEvidence(raw, bounds, evidence, comments, { personContext: people, ...available });
  return { clip: { ...bounds, ...copy, grounding }, evidence, comments };
}

describe('person name evidence review', () => {
  test('uses explicit names and copy labels, not broad mention or ASR labels', () => {
    expect(people[1].names).toEqual(['Guest', 'GuestName', 'GuestClip']);
    expect(people[0].sourceHost).toBe(true);
    expect(buildPersonEvidenceContext(registry)[0].sourceHost).toBe(false);
    expect(buildPersonEvidenceContext({ ai: { streamerRegistry: { bad: null, partial: { searchTags: 'bad' } } } })).toEqual([]);
  });

  test('reports a name absent from cited speech without changing the copy or references', () => {
    const copy = { title: 'A message', description: 'Guest left a message.', coverText: 'GuestClip\nleft a message' };
    const { clip } = check(copy);
    expect(clip).toMatchObject(copy);
    expect(clip.grounding.subtitleIds).toEqual(['G1']);
    expect(clip.grounding.issues).toEqual(['unreferenced_person:description:Guest', 'unreferenced_person:coverText:Guest']);
    expect(clip.grounding.status).toBe('needs_review');
    expect(clip.grounding.personEvidence).toMatchObject({ identityVerified: false, checks: [{ basis: 'unreferenced' }] });
  });

  test('matches configured copy labels to cited formal names without verifying identity', () => {
    const { clip } = check({ title: 'GuestClip left a message.' }, [{ start: 0, end: 10, text: 'GuestName left it.' }]);
    expect(clip.grounding.issues).toEqual([]);
    expect(clip.grounding.personEvidence.checks[0]).toMatchObject({ basis: 'cited_subtitle_mention', subtitleIds: ['G1'] });
    expect(clip.grounding.personEvidence.identityVerified).toBe(false);
  });

  test('a room match records only source-host metadata, not a proven speaker', () => {
    const { clip } = check({ title: 'HostClip recounts a message.' });
    expect(clip.grounding.issues).toEqual([]);
    expect(clip.grounding.personEvidence.checks[0]).toMatchObject({ basis: 'source_host_metadata', subtitleIds: [] });
    expect(clip.grounding.personEvidence.identityVerified).toBe(false);
  });

  test.each(['[Guest] A message was left.', '[speaker_1] [Guest] A message was left.', 'guessedName left a message.'])
    ('does not use speaker prefixes or ASR guesses as a name citation: %s', text => {
      const { clip } = check({ description: 'Guest left a message.' }, [{ start: 0, end: 10, text }]);
      expect(clip.grounding.issues).toContain('unreferenced_person:description:Guest');
    });

  test('strips speaker labels from every item in grouped evidence', () => {
    const evidence = buildSubtitleEvidence([{ start: 0, end: 5, text: '[Guest] First sentence.' },
      { start: 5, end: 10, text: '[Guest] Second sentence.' }]);
    const grounding = linkClipEvidence({ title: 'Guest left a message', sourceKind: 'recount', evidenceCueIds: ['G1'] },
      bounds, evidence, [], { personContext: people });
    expect(evidence.cues).toHaveLength(1);
    expect(grounding.issues).toContain('unreferenced_person:title:Guest');
  });

  test.each([
    { start: 11, end: 12, available: {} },
    { start: 0, end: 10, available: { cueIds: new Set() } }
  ])('rejects out-of-range and unprovided names as support: %j', ({ start, end, available }) => {
    const { clip } = check({ title: 'Guest left a message.' }, [{ start, end, text: 'Guest said hello.' }], [], {}, available);
    expect(clip.grounding.issues).toContain('unreferenced_person:title:Guest');
  });

  test('does not silently expand references to nearby name clues', () => {
    const { clip } = check({ title: 'Guest left a message.' }, [
      { start: 0, end: 5, text: 'A message was left.' }, { start: 5, end: 10, text: 'Guest was mentioned.' }
    ], [{ time: 6, text: 'Guest' }]);
    expect(clip.grounding.issues).toContain('unreferenced_person:title:Guest');
    expect(clip.grounding.subtitleIds).toEqual(['G1']);
    expect(clip.grounding.danmakuIds).toEqual([]);
  });

  test('keeps audience mentions separate from speech', () => {
    const { clip } = check({ description: 'Guest left a message.' }, undefined, [{ time: 6, text: 'Guest' }],
      { evidenceDanmakuIds: ['D1'] });
    expect(clip.grounding.issues).toContain('person_only_in_danmaku:description:Guest');
    expect(clip.grounding.personEvidence.checks[0]).toMatchObject({ basis: 'cited_audience_mention', subtitleIds: [], danmakuIds: ['D1'] });
  });

  test.each([
    { time: 11, available: {} },
    { time: 6, available: { danmakuIds: new Set() } }
  ])('does not use an invalid audience reference: %j', ({ time, available }) => {
    const { clip } = check({ description: 'Guest left a message.' }, undefined, [{ time, text: 'Guest' }],
      { evidenceDanmakuIds: ['D1'] }, available);
    expect(clip.grounding.issues).toContain('unreferenced_person:description:Guest');
  });

  test('matches literal names, with case folding but no Latin substring or cross-cue joins', () => {
    expect(check({ title: 'diarrhea after dinner' }).clip.grounding.personEvidence).toBeUndefined();
    const { clip } = check({ title: 'RHEA spoke.' }, [{ start: 0, end: 5, text: 'diarrhea' }, { start: 5, end: 10, text: 'rhe' }]);
    expect(clip.grounding.issues).toContain('unreferenced_person:title:Rhea');
    expect(check({ title: 'RHEA spoke.' }, [{ start: 0, end: 10, text: 'rhea spoke' }]).clip.grounding.issues).toEqual([]);
  });

  test('rechecks saved warnings and newly invalidated citations across later boundary passes', () => {
    const { clip, evidence, comments } = check({ title: 'Guest left a message.' }, [
      { start: 0, end: 5, text: 'A message was left.' }, { start: 5, end: 10, text: 'Guest' }
    ], [], { evidenceCueIds: ['G1', 'G2'] });
    const trimmed = revalidateClipEvidence({ ...clip, end: 5 }, evidence, comments);
    expect(trimmed.grounding.issues).toContain('unreferenced_person:title:Guest');
    const restored = revalidateClipEvidence({ ...JSON.parse(JSON.stringify(trimmed)), end: 10 }, evidence, comments);
    expect(restored.grounding.issues).toEqual([]);
    expect(revalidateClipEvidence({ ...trimmed, title: 'A message' }, evidence, comments).grounding.personEvidence).toBeUndefined();
  });

  test('retains a changed-source warning when final copy is checked again', () => {
    const { clip, comments } = check({ title: 'Guest left a message.' });
    const changed = buildSubtitleEvidence([{ start: 0, end: 10, text: 'Changed text.' }]);
    const first = revalidateClipEvidence(clip, changed, comments, people);
    const second = revalidateClipEvidence(JSON.parse(JSON.stringify(first)), changed, comments, people);
    expect(second.grounding.issues).toEqual(expect.arrayContaining(['source_changed', 'unreferenced_person:title:Guest']));
    expect(second.grounding.issues.filter(issue => issue === 'source_changed')).toHaveLength(1);
  });

  test('does not add a person gate or change legacy callers without a registry context', () => {
    const source = buildSubtitleEvidence([{ start: 0, end: 10, text: 'A message was left.' }]);
    const grounding = linkClipEvidence({ title: 'Guest left it.', evidenceCueIds: ['G1'], sourceKind: 'recount' }, bounds, source);
    expect(grounding.status).toBe('linked');
    expect(grounding.personEvidence).toBeUndefined();
  });
});
