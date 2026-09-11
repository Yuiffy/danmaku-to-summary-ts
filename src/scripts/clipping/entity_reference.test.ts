export {};
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const { buildParticipantContext } = require('./participant_context');
const { buildActorReviewPacket, validateActorReview, applyActorReview, attributionRisk } = require('./actor_review');
const { entityDigest, referenceHintsFor, matchesNameMention } = require('./entity_context');
const { validateRoleReference } = require('./role_reference');
const { postProcessAiClipMetadata } = require('../ai_clip_metadata');

const settings = { entityReferences: { enabled: true } };
const root = { ownStreamClips: { attribution: settings }, ai: { streamerRegistry: {
  host: { displayName: 'Host', aiClipName: 'Host', roomIds: ['1'] },
  person: { displayName: 'Lin Lan', roomIds: ['2'], aliases: ['Lyn'] }
}, roomSettings: { '2': { anchorName: 'LanLan' } } } };
const voice = { status: 'row_supported', label: 'Host', observations: [{ scope: 'row', label: 'Host', row: { accepted: true } }] };
const rows = [
  { start: 40, end: 44, text: 'A previous topic.' },
  { start: 100, end: 104, text: 'LanLan laughed at my story.', speakerEvidence: voice },
  { start: 105, end: 109, text: 'I asked LanLan about it.', speakerEvidence: voice },
  { start: 110, end: 114, text: 'She answered yes.', speakerEvidence: voice }
];
const comments = [{ time: 38, text: 'Lin Lan is LanLan.' }];
const clip = { start: 100, end: 120, title: 'Host asked someone', description: 'Host asked someone.', coverText: 'Question\nAnswer', grounding: { sourceKind: 'recount' } };
function packet(config = root, source = rows, audience = comments, options = settings) {
  const parsed = { segments: source };
  const context = buildParticipantContext(config, { roomId: '1' }, parsed, audience);
  return buildActorReviewPacket(clip, 'c1', buildSubtitleEvidence(source, { groupSegments: false }), audience, context, options);
}
function reference(p = packet()) {
  return { entityId: 'person', mention: 'LanLan', cueIds: ['G3'],
    contextIds: [p.entityContext.rows.find((row: any) => row.kind === 'audience').id], confidence: 'high',
    reason: 'The named addressee continues into the following answer.' };
}
function review(p = packet()) {
  return { clipId: 'c1', decision: 'repair', copy: { title: 'Host asked Lin Lan', description: 'Host recalled asking Lin Lan.', coverText: 'Question\nAnswer' },
    claims: [{ fields: ['title','description','coverText'], action: 'asked', actor: 'Host', narrator: 'Host', target: 'Lin Lan',
      sourceKind: 'recount', identityBasis: 'voice', speakerCueIds: ['G3'], cueIds: ['G3'], roleEvidence: { target: reference(p) } }], evidenceDanmakuIds: [] };
}

describe('automatic entity references', () => {
  test('discovers nickname-only people without a roster and never promotes them to speakers', () => {
    const p = packet(); const person = p.context.people.find((person: any) => person.id === 'person');
    expect(person.presence).toBe('mentioned_only');
    expect(person.names).toEqual(['Lin Lan']);
    expect(person.referenceHints).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'LanLan', kind: 'nickname' })]));
    expect(p.entityContext.rows).toContainEqual(expect.objectContaining({ sourceId: 'D1', text: comments[0].text }));
    expect(p.danmakuIds.has('D1')).toBe(false);
    expect(attributionRisk(clip, p.evidence, p.context)).toContain('other_person_in_context');
    expect(postProcessAiClipMetadata({ title: 'LanLan laughed' }, root).title).toBe('LanLan laughed');
  });
  test('defaults off and does not change the legacy context or alias normalization', () => {
    const config = structuredClone(root); config.ownStreamClips.attribution.entityReferences.enabled = false;
    const p = packet(config, rows, comments, { entityReferences: { enabled: false } });
    expect(p.entityContext).toBeUndefined();
    expect(p.context.people.every((person: any) => person.referenceHints === undefined)).toBe(true);
    const conversational = { ...clip, title: 'Host in a collab', description: 'Host in a collab', grounding: { sourceKind: 'live_speech' } };
    const noVoice = buildSubtitleEvidence([{ start: 100, end: 104, text: 'Hello.' }]);
    const onlyHost = { people: [p.context.people.find((person: any) => person.sourceHost)] };
    expect(attributionRisk(conversational, noVoice, onlyHost)).not.toContain('conversational_context_without_voice');
    expect(attributionRisk(conversational, noVoice, { ...onlyHost, entityReferencesEnabled: true })).toContain('conversational_context_without_voice');
  });
  test('keeps nickname and ASR variant hints distinct with configuration provenance', () => {
    expect(referenceHintsFor(root.ai.streamerRegistry.person, root, ['Lin Lan'])).toEqual([
      { name: 'LanLan', kind: 'nickname', source: 'ai.roomSettings.2.anchorName' },
      { name: 'Lyn', kind: 'asr_variant', source: 'streamerRegistry.aliases' }
    ]);
  });
  test('recognizes bounded honorific forms without substring or phonetic name replacement', () => {
    expect(matchesNameMention('LanLan前辈', 'LanLan')).toBe(true);
    expect(matchesNameMention('Lin Lan 老师', 'Lin Lan')).toBe(true);
    expect(matchesNameMention('Dr. Lin Lan', 'Lin Lan')).toBe(true);
    expect(matchesNameMention('LanLan的前辈', 'LanLan')).toBe(false);
    expect(matchesNameMention('LanLan朋友', 'LanLan')).toBe(false);
    expect(matchesNameMention('Lyn前辈', 'LanLan')).toBe(false);
  });
  test('preserves a literal honorific citation while corroborating its configured base nickname', () => {
    const p = packet(root, rows.map(row => ({ ...row, text: row.text.replaceAll('LanLan', 'LanLan前辈') })));
    const ref = reference(p); ref.mention = 'LanLan前辈';
    expect(validateRoleReference({ target: 'Lin Lan', cueIds: ['G4'], roleEvidence: { target: ref } }, 'target', p)).toEqual([]);
    expect(p.evidence.byId.get('G3').text).toContain('LanLan前辈');
    ref.contextIds = [];
    expect(validateRoleReference({ target: 'Lin Lan', cueIds: ['G4'], roleEvidence: { target: ref } }, 'target', p))
      .toContain('uncorroborated_role_alias:target');
  });
  test('honorifics cannot conceal base-name negation or colliding aliases', () => {
    const source = rows.map(row => ({ ...row, text: row.text.replaceAll('LanLan', 'LanLan前辈') }));
    source.push({ start: 115, end: 119, text: 'LanLan is not Lin Lan.' });
    const p = packet(root, source), ref = reference(p); ref.mention = 'LanLan前辈';
    expect(validateRoleReference({ target: 'Lin Lan', cueIds: ['G4'], roleEvidence: { target: ref } }, 'target', p))
      .toContain('contradicted_role_alias:target');
    const config: any = structuredClone(root);
    config.ai.streamerRegistry.other = { displayName: 'LanLan前辈', roomIds: ['3'] };
    const collision = packet(config, source.slice(0, -1));
    expect(validateRoleReference({ target: 'Lin Lan', cueIds: ['G4'], roleEvidence: { target: reference(collision) } }, 'target', collision))
      .toContain('ambiguous_role_alias:target');
    const collidingRef = { ...reference(collision), mention: 'LanLan前辈' };
    expect(validateRoleReference({ target: 'Lin Lan', cueIds: ['G4'], roleEvidence: { target: collidingRef } }, 'target', collision))
      .toContain('ambiguous_role_alias:target');
  });
  test('a shared canonical name is not disambiguated by repeating that same name', () => {
    const config: any = structuredClone(root);
    config.ai.streamerRegistry.other = { displayName: 'Lin Lan', roomIds: ['3'] };
    const source = rows.map(row => ({ ...row, text: row.text.replaceAll('LanLan', 'Lin Lan老师') }));
    const p = packet(config, source), ref = reference(p); ref.mention = 'Lin Lan老师';
    expect(validateRoleReference({ target: 'Lin Lan', cueIds: ['G4'], roleEvidence: { target: ref } }, 'target', p))
      .toContain('ambiguous_role_alias:target');
  });
  test('supports a referenced target with no target voice and preserves bound evidence', () => {
    const p = packet();
    expect(validateActorReview(review(p), p)).toEqual([]);
    const result = applyActorReview(p, review(p));
    expect(result.publicCopyPending).toBe(false);
    expect(result.attributionReview.entityContext.digest).toBe(p.entityContext.digest);
    expect(result.attributionReview.claims[0].roleEvidence.target.entityId).toBe('person');
  });
  test('validated nickname references must keep the named target in public copy', () => {
    const p = packet();
    const value = review(p);
    value.copy.title = 'Host asked the other person';
    value.copy.description = 'Host recalled asking her.';
    expect(validateActorReview(value, p)).toEqual([
      'known_person_anonymized:target:title:person:1',
      'known_person_anonymized:target:description:person:1'
    ]);
    value.claims[0].roleEvidence.target.contextIds = [];
    expect(validateActorReview(value, p)).toContain('uncorroborated_role_alias:target:1');
    expect(validateActorReview(value, p).some(issue => issue.startsWith('known_person_anonymized'))).toBe(false);
  });
  test('supports a pronoun action through a separate in-clip named antecedent', () => {
    const p = packet(); const claim = { actor: 'Lin Lan', cueIds: ['G4'], roleEvidence: { actor: reference(p) } };
    expect(validateRoleReference(claim, 'actor', p)).toEqual([]);
    expect(p.evidence.byId.get('G4').text).not.toContain('Lin Lan');
  });
  test('does not equate a unique nickname with a person without corroboration', () => {
    const p = packet(); const ref = reference(p); ref.contextIds = [];
    expect(validateRoleReference({ target: 'Lin Lan', cueIds: ['G4'], roleEvidence: { target: ref } }, 'target', p))
      .toContain('uncorroborated_role_alias:target');
    ref.cueIds = ['G2','G3'];
    expect(validateRoleReference({ target: 'Lin Lan', cueIds: ['G4'], roleEvidence: { target: ref } }, 'target', p)).toEqual([]);
  });
  test('never uses an audience-only name as a speech anchor', () => {
    const p = packet(); const ref = reference(p); ref.mention = 'Lin Lan';
    expect(validateRoleReference({ target: 'Lin Lan', cueIds: ['G4'], roleEvidence: { target: ref } }, 'target', p))
      .toContain('role_mention_not_in_speech:target');
  });
  test('ASR variants need separate speech support even when a comment suggests the name', () => {
    const source = rows.map(row => ({ ...row, text: row.text.replaceAll('LanLan', 'Lyn') }));
    const p = packet(root, source, [{ time: 38, text: 'Lin Lan is Lyn.' }]);
    const ref = reference(p); ref.mention = 'Lyn'; ref.cueIds = ['G2','G3'];
    expect(validateRoleReference({ target: 'Lin Lan', cueIds: ['G4'], roleEvidence: { target: ref } }, 'target', p))
      .toContain('uncorroborated_role_alias:target');
  });
  test('nickname collisions cannot be resolved by selecting an ID or by one audience comment', () => {
    const config: any = structuredClone(root);
    config.ai.streamerRegistry.other = { displayName: 'Other Person', roomIds: ['3'] };
    config.ai.roomSettings['3'] = { anchorName: 'LanLan' };
    const p = packet(config); const ref = reference(p);
    expect(p.entityContext.people.filter((person: any) => person.hints.some((hint: any) => hint.name === 'LanLan'))).toHaveLength(2);
    expect(validateRoleReference({ target: 'Lin Lan', cueIds: ['G4'], roleEvidence: { target: ref } }, 'target', p))
      .toContain('ambiguous_role_alias:target');
  });
  test('explicit nickname negation overrides an otherwise valid hint', () => {
    const p = packet(root, [...rows, { start: 115, end: 119, text: 'LanLan is not Lin Lan; it is someone else.' }]);
    expect(validateRoleReference({ target: 'Lin Lan', cueIds: ['G4'], roleEvidence: { target: reference(p) } }, 'target', p))
      .toContain('contradicted_role_alias:target');
  });
  test('selective name citations cannot hide a nearby explicit contradiction', () => {
    const p = packet(root, rows.map((row, index) => index === 0 ? { ...row, text: 'LanLan is not Lin Lan.' } : row));
    const ref = reference(p);
    expect(ref.contextIds).not.toContain(p.entityContext.rows.find((row: any) => row.kind === 'speech').id);
    expect(validateRoleReference({ target: 'Lin Lan', cueIds: ['G4'], roleEvidence: { target: ref } }, 'target', p))
      .toContain('contradicted_role_alias:target');
  });
  test('missing, medium-confidence, invented, or non-canonical entity bindings remain pending', () => {
    const p = packet(); const original = review(p);
    delete (original.claims[0] as any).roleEvidence;
    expect(validateActorReview(original, p)).toContain('missing_role_reference:target:1');
    for (const mutation of [{ confidence: 'medium' }, { entityId: 'invented' }, { entityId: null }]) {
      const value = review(p); Object.assign(value.claims[0].roleEvidence.target, mutation);
      expect(validateActorReview(value, p).length).toBeGreaterThan(0);
    }
    const value = review(p); value.claims[0].target = 'Someone Else';
    expect(validateActorReview(value, p)).toContain('role_entity_mismatch:target:1');
  });
  test('cannot borrow outside cues or reinterpret name-only N-IDs as action evidence', () => {
    const p = packet(); const value = review(p);
    value.claims[0].roleEvidence.target.cueIds = ['G1'];
    expect(validateActorReview(value, p)).toContain('invalid_role_citation:target:1');
    value.claims[0].cueIds = ['N1'];
    expect(validateActorReview(value, p)).toContain('invalid_action_citation:1');
  });
  test('context and identity bindings reject source, bounds, text or candidate mutations', () => {
    for (const mutate of [
      (p: any) => { p.entityContext.sourceSha256 = 'changed'; },
      (p: any) => { p.entityContext.end++; },
      (p: any) => { p.entityContext.rows[0].text = 'changed'; },
      (p: any) => { p.entityContext.people[0].name = 'changed'; }
    ]) {
      const p = packet(); const value = review(p); mutate(p);
      expect(validateActorReview(value, p)).toContain('entity_context_changed:target:1');
    }
  });
  test('bounded context never truncates source text or expands action permissions', () => {
    const p = packet(root, rows, comments, { entityReferences: { enabled: true, maxContextRows: 1, maxContextChars: 24 } });
    expect(p.entityContext.rows).toHaveLength(1);
    expect(p.entityContext.omittedRows).toBeGreaterThan(0);
    expect(p.entityContext.rows[0].text).toBe(comments[0].text);
    expect([...p.cueIds]).toEqual(['G2','G3','G4']);
    expect(p.entityContext.digest).toBe(entityDigest(p.entityContext));
  });
  test('names absent from the directory can be linked literally without inventing an ID or narrator', () => {
    const source = [rows[0], { start: 100, end: 104, text: 'A Driver talked to me.' },
      { start: 105, end: 109, text: 'The Driver asked about the route.' }];
    const p = packet(root, source, []);
    const value = { clipId: 'c1', decision: 'repair', copy: { title: 'Driver asked about the route', description: 'A recalled route question.', coverText: 'Route\nQuestion' },
      claims: [{ fields: ['title','description','coverText'], action: 'asked', actor: 'Driver', target: null, narrator: null,
        sourceKind: 'recount', identityBasis: 'unresolved', cueIds: ['G3'], roleEvidence: { actor: {
          entityId: null, mention: 'Driver', cueIds: ['G2'], contextIds: [], confidence: 'high', reason: 'The driver is the prior subject.' } } }], evidenceDanmakuIds: [] };
    expect(validateActorReview(value, p)).toEqual([]);
    value.claims[0].actor = 'Invented Real Name';
    expect(validateActorReview(value, p)).toContain('unproven_role_alias:actor:1');
  });
  test('cannot retain a named public actor while dropping all named role claims', () => {
    const p = packet(); const value: any = review(p);
    value.claims[0].target = null;
    expect(validateActorReview(value, p)).toContain('unclaimed_entity:title:person');
    expect(validateActorReview(value, p)).toContain('role_reference_without_role:target:1');
    expect(validateRoleReference(value.claims[0], 'target', p)).toEqual(['invalid_role_entity:target']);
  });
  test('an unresolved questioner cannot be published as an ambiguous first-person title', () => {
    const p = packet(); const value: any = review(p);
    value.copy.title = 'Lin Lan laughed at me, so I asked why';
    Object.assign(value.claims[0], { actor: null, narrator: null, identityBasis: 'unresolved', speakerCueIds: [] });
    expect(validateActorReview(value, p)).toContain('unresolved_first_person:title');
  });
});
