export {};
const { dialoguePrompt, parseDialogueEvidence, supportsDialogueSpeaker } = require('./dialogue_evidence');
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const { buildActorReviewPacket, validateActorReview } = require('./actor_review');
const context = { people: [{ id: 'host', label: 'Host', names: ['Host'], preferredName: 'Host', sourceHost: true },
  { id: 'guest', label: 'Guest', names: ['Guest'], preferredName: 'Guest', presence: 'planned' }] };
const source = buildSubtitleEvidence([{ start: 0, end: 4, text: 'Host, can you hear me?', speakerEvidence: { status: 'unknown', label: null } },
  { start: 4, end: 8, text: 'Guest, I can hear you.' }, { start: 8, end: 12, text: 'I asked Mimi about it.' }], { groupSegments: false });
const clip = { start: 0, end: 12, title: 'INCORRECT OLD COPY', description: 'INCORRECT EVENT', coverText: 'OLD', grounding: { sourceKind: 'recount' } };
const packet = () => buildActorReviewPacket(clip, 'c1', source, [], context);
const answer = () => ({ windows: [{ clipId: 'c1', multiSpeaker: 'yes', turns: [
  { speakerId: 'guest', cueIds: ['G3'], anchorCueIds: ['G1', 'G2'], evidenceDanmakuIds: [], confidence: 'high', reason: 'A reciprocal direct address and response establish the turns.' }
], reason: 'Direct reciprocal conversation.' }] });
const parse = (value: any, p = packet()) => parseDialogueEvidence({ text: JSON.stringify(value) }, [p], context)[0];

describe('independent text speaker inference', () => {
  test('receives original words and names, never prior copy or acoustic labels/scores', () => {
    const prompt = dialoguePrompt([packet()], context);
    expect(prompt).toContain('Host, can you hear me?');
    expect(prompt).not.toContain('INCORRECT OLD COPY');
    expect(prompt).not.toContain('INCORRECT EVENT');
    expect(prompt).not.toContain('[V=');
    expect(prompt).not.toContain('speakerEvidence');
  });
  test('strips existing speaker SRT prefixes but retains non-speaker content tags', () => {
    const evidence = buildSubtitleEvidence([{ start: 0, end: 4, text: '[Host 0.83] Original speech.' },
      { start: 4, end: 8, text: '[Music] A playback clue.' }], { groupSegments: false });
    const p = buildActorReviewPacket({ ...clip, end: 8 }, 'c1', evidence, [], context);
    const prompt = dialoguePrompt([p], context);
    expect(prompt).not.toContain('[Host 0.83]');
    expect(prompt).toContain('[Music] A playback clue.');
  });
  test('permits independent dialogue proof without requiring a voice reference', () => {
    const p = packet(); p.dialogueEvidence = parse(answer(), p);
    const claim = { fields: ['title','coverText','description'], action: 'asked', narrator: 'Guest', actor: 'Guest', target: 'Mimi',
      sourceKind: 'recount', identityBasis: 'dialogue', speakerCueIds: ['G3'], cueIds: ['G3'] };
    expect(supportsDialogueSpeaker(claim, p, 'guest')).toBe(true);
    expect(validateActorReview({ clipId: 'c1', decision: 'repair', copy: { title: 'Guest asked Mimi', coverText: 'Question', description: 'Guest recalled a question.' },
      claims: [claim], evidenceDanmakuIds: [] }, p)).toEqual([]);
  });
  test('one name mention, an audience-only name, or lower confidence cannot certify a turn', () => {
    const value = answer(); value.windows[0].turns[0].anchorCueIds = ['G1', 'G1'];
    expect(parse(value).turns[0].supported).toBe(false);
    value.windows[0].turns[0].anchorCueIds = ['G1','G2']; value.windows[0].turns[0].confidence = 'medium';
    expect(parse(value).turns[0].supported).toBe(false);
    value.windows[0].turns[0].anchorCueIds = [];
    expect(parse(value).turns[0].supported).toBe(false);
  });
  test('rejects unprovided identities/citations and marks mixed-speaker cue attribution ambiguous', () => {
    const invalid = answer(); invalid.windows[0].turns[0].speakerId = 'invented';
    expect(() => parse(invalid)).toThrow();
    invalid.windows[0].turns[0].speakerId = 'guest'; invalid.windows[0].turns[0].cueIds = ['G999'];
    expect(() => parse(invalid)).toThrow();
    const mixed = answer(); mixed.windows[0].turns.push({ ...mixed.windows[0].turns[0], speakerId: 'host' });
    const result = parse(mixed);
    expect(result.issues).toContain('mixed_dialogue_cue');
    expect(result.turns.every((turn: any) => !turn.supported)).toBe(true);
  });
  test('changed source/windows invalidate saved dialogue proof', () => {
    const p = packet(); p.dialogueEvidence = { ...parse(answer(), p), end: 15 };
    expect(supportsDialogueSpeaker({ speakerCueIds: ['G3'], cueIds: ['G3'] }, p, 'guest')).toBe(false);
  });
  test('identity anchors may differ from action citations, but the action must share a supported turn', () => {
    const p = packet(); const value = answer(); value.windows[0].turns[0].cueIds = ['G1','G3'];
    p.dialogueEvidence = parse(value,p);
    expect(supportsDialogueSpeaker({ speakerCueIds: ['G1'], cueIds: ['G3'] },p,'guest')).toBe(true);
    expect(supportsDialogueSpeaker({ speakerCueIds: ['G1'], cueIds: ['G2'] },p,'guest')).toBe(false);
    expect(supportsDialogueSpeaker({ speakerCueIds: ['G999'], cueIds: ['G3'] },p,'guest')).toBe(false);
  });
  test('conflicting direct acoustic evidence is kept for review rather than silently overwritten', () => {
    const rows = source.cues.flatMap((cue: any) => cue.items.map((item: any) => ({ ...item,
      speakerEvidence: { status: 'row_supported', label: 'Host' } })));
    const conflicting = buildSubtitleEvidence(rows, { groupSegments: false });
    const p = buildActorReviewPacket(clip, 'c1', conflicting, [], context);
    p.dialogueEvidence = parse(answer(), p);
    const claim = { fields: ['title','coverText','description'], action: 'asked', narrator: 'Guest', actor: 'Guest', target: 'Mimi',
      sourceKind: 'recount', identityBasis: 'dialogue', speakerCueIds: ['G3'], cueIds: ['G3'] };
    expect(validateActorReview({ clipId: 'c1', decision: 'repair', copy: { title: 'Guest asked Mimi', coverText: 'Question', description: 'Guest asked Mimi.' },
      claims: [claim], evidenceDanmakuIds: [] }, p)).toContain('speaker_dialogue_conflict:1');
  });
  test('a separate identity anchor cannot conceal a voice conflict on the action turn', () => {
    const rows = source.cues.flatMap((cue: any) => cue.items.map((item: any) => ({ ...item,
      speakerEvidence: { status: 'row_supported', label: cue.id === 'G3' ? 'Host' : 'Guest' } })));
    const p = buildActorReviewPacket(clip, 'c1', buildSubtitleEvidence(rows, { groupSegments: false }), [], context);
    const value = answer(); value.windows[0].turns[0].cueIds = ['G1', 'G3'];
    p.dialogueEvidence = parse(value, p);
    const claim = { fields: ['title','coverText','description'], action: 'asked', narrator: 'Guest', actor: 'Guest', target: 'Mimi',
      sourceKind: 'recount', identityBasis: 'dialogue', speakerCueIds: ['G1'], cueIds: ['G3'] };
    expect(validateActorReview({ clipId: 'c1', decision: 'repair', copy: { title: 'Guest asked Mimi', coverText: 'Question', description: 'Guest asked Mimi.' },
      claims: [claim], evidenceDanmakuIds: [] }, p)).toContain('speaker_dialogue_conflict:1');
  });
  test('discovers a literal local speaker without a preconfigured roster or voice reference', () => {
    const evidence = buildSubtitleEvidence([{ start: 0, end: 4, text: 'I am Nova. Host, can you hear me?' },
      { start: 4, end: 8, text: 'Yes, Nova, I can hear you.' }, { start: 8, end: 12, text: 'I asked about the game.' }], { groupSegments: false });
    const p = buildActorReviewPacket(clip, 'c1', evidence, [], context, { entityReferences: { enabled: true } });
    const value: any = answer();
    value.windows[0].localPeople = [{ id: 'local:1', name: 'Nova', anchorCueIds: ['G1','G2'] }];
    value.windows[0].turns[0].speakerId = 'local:1';
    p.dialogueEvidence = parse(value, p);
    expect(p.dialogueEvidence.localPeople[0]).toMatchObject({ label: 'Nova', scope: 'this_window_only', presence: 'dialogue_inferred' });
    const claim = { fields: ['title','coverText','description'], action: 'asked', actor: 'Nova', narrator: 'Nova', target: null,
      identityBasis: 'dialogue', sourceKind: 'recount', speakerCueIds: ['G3'], cueIds: ['G3'] };
    expect(validateActorReview({ clipId: 'c1', decision: 'repair', copy: { title: 'Nova asked about the game',
      coverText: 'Game question', description: 'Nova recalled a question.' }, claims: [claim], evidenceDanmakuIds: [] }, p)).toEqual([]);
  });
  test('rejects local names invented from labels, audience-only mentions, or duplicate IDs', () => {
    const p = buildActorReviewPacket(clip, 'c1', source, [{ time: 2, text: 'Nova!' }], context, { entityReferences: { enabled: true } });
    const value: any = answer(); value.windows[0].localPeople = [{ id: 'local:1', name: 'Nova', anchorCueIds: ['G1'] }];
    expect(() => parse(value, p)).toThrow('Unproven');
    value.windows[0].localPeople[0].name = 'SPEAKER_01';
    expect(() => parse(value, p)).toThrow('Unproven');
    value.windows[0].localPeople[0].name = 'Guest';
    expect(() => parse(value, p)).toThrow('duplicate');
  });
});
