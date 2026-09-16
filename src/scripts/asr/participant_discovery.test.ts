const { discoverParticipants } = require('./participant_discovery');

const config = { ai: { streamerRegistry: {
  sui: { displayName: '岁己SUI', roomIds: ['25788785'], mentionLabels: ['岁己', '小岁'], speakerLabels: ['SUI'] },
  shiori: { displayName: '栞栞', roomIds: ['26966466'], mentionLabels: ['栞栞', '小栞', 'Shiori'], aliases: ['浅浅', '栞'] },
  rhea: { displayName: '瑞娅', roomIds: ['23260993'], mentionLabels: ['瑞娅', 'Rhea'] },
  izayoi: { displayName: '十六萤Izayoi', roomIds: ['1741667419'], mentionLabels: ['十六萤'] },
  hazel: { displayName: '灰泽满Hazel', roomIds: ['1713546334'], mentionLabels: ['灰泽满', '满满'] },
  liko: { displayName: '莉蔻Liko', roomIds: ['1713548468'], mentionLabels: ['莉蔻'] },
  kloa: { displayName: '克罗雅Kloa', roomIds: ['1986461465'], mentionLabels: ['克罗雅'] }
} } };
const session = { roomId: '25788785', sessionId: 'sui-20260912', startedAt: '2026-09-12T20:00:00+08:00',
  endedAt: '2026-09-12T23:00:00+08:00' };
const source = (value: any = {}) => ({ id: 'title', source: 'room_title', roomId: session.roomId,
  observedAt: session.startedAt, ...value });
const discover = (evidence: any[], options: any = {}, settings = config) => discoverParticipants({ ...session, ...options, evidence }, settings);
const frame = (id: string, offsetSeconds: number, extra: any = {}) => source({ id, source: 'frame', observedAt: undefined,
  offsetSeconds, sceneContext: 'live', observations: [{ name: '栞栞', relation: 'present', kind: 'live_participant',
    identityBasis: 'visible_name_label', confidence: 0.97 }], ...extra });

describe('session participant discovery', () => {
  test('distinguishes a collab plan from live presence and retains source provenance', () => {
    const result = discover([source({ text: '今天和栞栞联动！', url: 'https://live.bilibili.com/25788785' })]);
    expect(result).toMatchObject({ mode: 'multi', modeStatus: 'planned', plannedParticipantIds: ['shiori'],
      confirmedParticipantIds: [], constrainToRoster: false, speakerIdentityVerified: false });
    expect(result.participants[0]).toMatchObject({ streamerId: 'sui', role: 'host', status: 'candidate', presence: 'source_host' });
    expect(result.participants[1].evidence[0]).toMatchObject({ source: 'room_title', roomId: '25788785',
      observedAt: session.startedAt, quote: '今天和栞栞联动', url: 'https://live.bilibili.com/25788785' });
  });

  test('an ordinary real Sui stream title supplies neither collab nor solo proof', () => {
    // Recording title from the production 2026-09-10 stream; this is deliberately not a solo label.
    const result = discover([source({ text: '陪你这个猪过周四！5070ti版' })]);
    expect(result).toMatchObject({ mode: 'unknown', confirmedParticipantIds: [], rosterStreamerIds: ['sui'] });
  });

  test.each(['今天看栞栞直播', '一起看瑞娅联动回放', '聊聊栞栞的事', '游戏角色瑞娅登场', '今天浅浅联动一下'])
  ('mentions, viewing, game characters and ASR-only aliases do not populate roster: %s', (text: string) => {
    const result = discover([source({ text })]);
    expect(result.rosterStreamerIds).toEqual(['sui']);
    expect(result.confirmedParticipantIds).toEqual([]);
    if (text.includes('回放')) expect(result.mode).toBe('unknown');
  });

  test('a collab clause does not promote people mentioned in another clause', () => {
    const result = discover([source({ text: '和栞栞联动，聊聊瑞娅最近的趣事' })]);
    expect(result.plannedParticipantIds).toEqual(['shiori']);
    expect(result.mentions).toEqual(expect.arrayContaining([expect.objectContaining({ streamerId: 'rhea', relation: 'mentioned' })]));
  });

  test('explicit solo remains a claim and never proves the host spoke every line', () => {
    const result = discover([source({ text: '今天单播，看看栞栞的录播' })]);
    expect(result).toMatchObject({ mode: 'solo', modeStatus: 'planned', rosterStreamerIds: ['sui'], speakerIdentityVerified: false });
  });

  test.each([
    { roomId: '26966466', reason: 'room_mismatch' },
    { sessionId: 'different-session', reason: 'session_mismatch' },
    { observedAt: '2026-09-11T20:00:00+08:00', reason: 'observation_outside_session' },
    { text: '明天和栞栞联动', reason: 'event_day_mismatch' },
    { text: '9月11日和栞栞联动', reason: 'event_day_mismatch' },
    { text: '和栞栞联动 https://live.bilibili.com/26966466', reason: 'linked_room_mismatch' }
  ])('rejects a source bound to another event: $reason', ({ reason, ...extra }: any) => {
    const result = discover([source({ text: '和栞栞联动', ...extra })]);
    expect(result.rejectedEvidence).toEqual([expect.objectContaining({ reason })]);
    expect(result.rosterStreamerIds).toEqual(['sui']);
  });

  test('late dynamic fetching uses the original publication/event time', () => {
    const result = discover([source({ source: 'dynamic', publishedAt: '2026-09-11T22:00:00+08:00',
      observedAt: '2026-09-14T12:00:00+08:00', text: '明晚和栞栞联动', authorId: 'host-uid' })]);
    expect(result.plannedParticipantIds).toEqual(['shiori']);
    expect(result.evidence[0].publishedAt).toBe('2026-09-11T22:00:00+08:00');
  });

  test.each([
    { publishedAt: undefined, reason: 'publication_time_missing' },
    { publishedAt: '2026-09-01T20:00:00+08:00', reason: 'publication_outside_session' },
    { publishedAt: '2026-09-11T22:00:00+08:00', reason: 'dynamic_event_time_unbound' }
  ])('old or unbound dynamic does not become the current guest list: $reason', ({ reason, ...extra }: any) => {
    const result = discover([source({ source: 'dynamic', text: '和栞栞联动', ...extra })]);
    expect(result.rejectedEvidence[0].reason).toBe(reason);
    expect(result.plannedParticipantIds).toEqual([]);
  });

  test('scheduled announcements match their actual event regardless of publish date', () => {
    const result = discover([source({ source: 'dynamic', text: '和栞栞联动', publishedAt: '2026-09-11T20:00:00+08:00',
      scheduledAt: '2026-09-12T20:00:00+08:00' })]);
    expect(result.plannedParticipantIds).toEqual(['shiori']);
  });

  test('a cover and one visual match remain candidates', () => {
    const result = discover([frame('f1', 60), frame('cover', 120, { source: 'cover', observedAt: session.startedAt })]);
    expect(result.confirmedParticipantIds).toEqual([]);
    expect(result.participants.find((person: any) => person.streamerId === 'shiori').status).toBe('candidate');
  });

  test('corroborating named live participants in distinct frames confirms presence, never speech', () => {
    const result = discover([frame('f1', 60), frame('f2', 120)]);
    expect(result).toMatchObject({ mode: 'multi', modeStatus: 'confirmed', confirmedParticipantIds: ['shiori'], speakerIdentityVerified: false });
    expect(result.participants[1]).toMatchObject({ presence: 'repeated_visual_presence' });
  });

  test.each([
    [frame('same-id', 60), frame('same-id', 120)],
    [frame('f1', 60), frame('f2', 60)],
    [frame('f1', 60, { sha256: 'same-image' }), frame('f2', 120, { sha256: 'same-image' })],
    [frame('f1', 60, { sceneContext: 'replay' }), frame('f2', 120, { replay: true })],
    [frame('f1', 60, { sceneContext: 'poster' }), frame('f2', 120, { sceneContext: 'character' })]
  ])('duplicate frames, playback and decorative avatars cannot corroborate presence', (...evidence: any[]) => {
    expect(discover(evidence).confirmedParticipantIds).toEqual([]);
  });

  test.each([1.1, -1, NaN, '0.99', Infinity])('rejects invalid observation confidence %s', (confidence: any) => {
    const observations = [{ name: '栞栞', relation: 'present', kind: 'live_participant', identityBasis: 'visible_name_label', confidence }];
    const result = discover([frame('f1', 60, { observations }), frame('f2', 120, { observations })]);
    expect(result.confirmedParticipantIds).toEqual([]);
    expect(result.issues).toContain('invalid_observation_confidence:f1');
  });

  test('unknown people are preserved without selecting a registered lookalike', () => {
    const result = discover([source({ text: '今晚和@新朋友联动', observations: [{ name: '陌生主播', relation: 'present' }] })]);
    expect(result.rosterStreamerIds).toEqual(['sui']);
    expect(result.unresolved.map((item: any) => item.reason)).toEqual(['unknown_name', 'unknown_name']);
  });

  test('ambiguous names remain unresolved and English identifiers require word boundaries', () => {
    const ambiguousConfig = { ai: { streamerRegistry: { ...config.ai.streamerRegistry,
      other: { displayName: '另一位', mentionLabels: ['小栞'] } } } };
    const result = discover([source({ text: '和小栞联动；aShioriName 和 Rheadance 只是游戏ID' })], {}, ambiguousConfig);
    expect(result.rosterStreamerIds).toEqual(['sui']);
    expect(result.unresolved[0]).toMatchObject({ reason: 'ambiguous_name', matchedStreamerIds: ['shiori', 'other'] });
  });

  test('documented four-person collab roster stays planned until presence has evidence', () => {
    // The four participants are documented in docs/speaker-enrollment-notes.md.
    const result = discover([source({ roomId: '1741667419', text: '十六萤×灰泽满×莉蔻×克罗雅 4人联动' })],
      { roomId: '1741667419', hostStreamerId: 'izayoi' });
    expect(result.rosterStreamerIds).toEqual(['izayoi', 'hazel', 'liko', 'kloa']);
    expect(result.confirmedParticipantIds).toEqual([]);
  });

  test('confirmed visual guests override a solo plan but retain the conflict', () => {
    const result = discover([source({ text: '今天单播' }), frame('f1', 60), frame('f2', 120)]);
    expect(result.mode).toBe('multi');
    expect(result.issues).toContain('solo_claim_with_guest_evidence');
  });

  test('missing session time prevents using unbound images and title metadata', () => {
    const result = discover([source({ text: '和栞栞联动' })], { startedAt: undefined, endedAt: undefined });
    expect(result.issues).toContain('session_time_missing');
    expect(result.rejectedEvidence[0].reason).toBe('session_time_missing');
  });

  test.each([undefined, '2026-09-13T02:00:00+08:00'])('tomorrow is not tonight even with unknown or midnight end time %s', (endedAt: any) => {
    const result = discover([source({ text: '今天和栞栞联动' }), source({ id: 'future', source: 'dynamic',
      publishedAt: '2026-09-12T18:00:00+08:00', text: '明天和瑞娅联动' })], { endedAt });
    expect(result.plannedParticipantIds).toEqual(['shiori']);
    expect(result.rejectedEvidence).toEqual([expect.objectContaining({ id: 'future', reason: 'event_day_mismatch' })]);
  });

  test.each(['下周和栞栞联动', '回顾上次和栞栞的联动', '改天和栞栞一起玩'])('vague other-session announcements do not bind to today: %s', (text: string) => {
    const result = discover([source({ text })]);
    expect(result.rejectedEvidence[0].reason).toBe('event_time_unbound');
    expect(result.plannedParticipantIds).toEqual([]);
  });

  test('bound cover posters provide voice-comparison candidates without proving presence', () => {
    const result = discover([source({ source: 'cover', sceneContext: 'poster', observations: [
      { name: '栞栞', relation: 'poster', confidence: 0.95 }, { name: '瑞娅', relation: 'character', confidence: 0.9 }
    ] })]);
    expect(result.candidateStreamerIds).toEqual(['sui', 'shiori']);
    expect(result.confirmedParticipantIds).toEqual([]);
    expect(result.mode).toBe('unknown');
  });

  test('independent dates in one dynamic keep tonight and reject tomorrow without losing provenance', () => {
    const result = discover([source({ id: 'schedule', source: 'dynamic', publishedAt: '2026-09-12T18:00:00+08:00',
      text: '今晚和栞栞联动，明天和瑞娅联动' })]);
    expect(result.plannedParticipantIds).toEqual(['shiori']);
    expect(result.participants[1].evidence[0]).toMatchObject({ id: 'schedule', quote: '今晚和栞栞联动',
      parentText: '今晚和栞栞联动，明天和瑞娅联动', clauseIndex: 0 });
    expect(result.rejectedEvidence[0]).toMatchObject({ id: 'schedule', text: '明天和瑞娅联动', reason: 'event_day_mismatch', clauseIndex: 1 });
  });

  test('retains unnamed live avatars as unresolved multi-person clues', () => {
    const result = discover([frame('two-anonymous', 120, { observations: [
      { name: '', relation: 'candidate', kind: 'avatar', confidence: 0.8, quote: '左下角棕发立绘，无姓名标签' },
      { name: '', relation: 'candidate', kind: 'avatar', confidence: 0.8, quote: '右下角白发立绘，无姓名标签' }
    ] })]);
    expect(result).toMatchObject({ mode: 'multi', modeStatus: 'candidate', confirmedParticipantIds: [], rosterStreamerIds: ['sui'] });
    expect(result.unresolved[0]).toMatchObject({ name: '', reason: 'unknown_identity' });
  });
});
