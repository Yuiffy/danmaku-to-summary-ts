export {};
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const { attributionRisk, buildActorReviewPacket, validateActorReview, parseActorReviews,
  applyActorReview, finalizeActorReview, copyDigest } = require('./actor_review');
const { reviewClipActors } = require('./actor_review_runner');
const generator = require('../ai_text_generator');
const context = { people: [
  { id: 'host', label: 'Host', names: ['Host'], preferredName: 'Host', sourceHost: true, presence: 'source_host' },
  { id: 'guest', label: 'Guest', names: ['Guest', 'GuestClip'], preferredName: 'GuestClip', sourceHost: false, presence: 'planned' }
] };
const voice = (label: string) => ({ version: 1, status: 'row_supported', label, observations: [
  { start: 0, end: 10, label, scope: 'row', row: { label, accepted: true, score: .7, margin: .15 } }
] });
const source = buildSubtitleEvidence([{ start: 0, end: 10, text: 'I asked Mimi about it.', speakerEvidence: voice('Guest') },
  { start: 10, end: 20, text: 'That was surprising.', speakerEvidence: voice('Host') }], { groupSegments: false });
const clip = { start: 0, end: 10, title: 'Host asked Mimi', coverText: 'The question', description: 'Host asked Mimi.',
  grounding: { sourceKind: 'recount' } };
const packet = () => buildActorReviewPacket(clip, 'c1', source, [{ time: 15, text: 'Guest!' }], context);
const good = () => ({ clipId: 'c1', decision: 'repair', copy: { title: 'GuestClip asked Mimi',
  coverText: 'A question', description: 'GuestClip recalled asking Mimi.' },
  claims: [{ fields: ['title', 'coverText', 'description'], action: 'asked', narrator: 'Guest', actor: 'GuestClip', target: 'Mimi',
    sourceKind: 'recount', identityBasis: 'voice', speakerCueIds: ['G1'], cueIds: ['G1'] }], evidenceDanmakuIds: [] });

describe('independent action attribution review', () => {
  test('repairs actor without altering boundaries, with a content-bound review record', () => {
    expect(validateActorReview(good(), packet())).toEqual([]);
    const updated = applyActorReview(packet(), good());
    expect(updated).toMatchObject({ start: 0, end: 10, title: 'GuestClip asked Mimi', publicCopyPending: false });
    expect(updated.attributionReview.copyDigest).toBe(copyDigest(updated));
    expect(updated.attributionReview.originalCopy.title).toBe('Host asked Mimi');
  });
  test('rejects host attribution contradicting the cited voice even if the model says accept', () => {
    const bad = good();
    bad.claims[0].narrator = 'Host'; bad.claims[0].actor = 'Host';
    expect(validateActorReview(bad, packet())).toContain('speaker_citation_conflict:1');
  });
  test('cannot borrow a speaker cue or audience reaction outside the output window', () => {
    const bad = good();
    bad.claims[0].speakerCueIds = ['G2']; bad.evidenceDanmakuIds = ['D1'];
    expect(validateActorReview(bad, packet())).toEqual(expect.arrayContaining(['missing_speaker_citation:1', 'unseen_danmaku:D1', 'danmaku_outside_clip:D1']));
  });
  test('confirmed guest must be named in title, not just the description', () => {
    const bad = good(); bad.copy.title = 'Someone asked Mimi';
    expect(validateActorReview(bad, packet())).toContain('guest_name_missing_from_title:1');
  });
  test('normalizes an explicit formal name before validation without guessing a new identity', () => {
    const review = good(); review.copy.title = 'Guest asked Mimi';
    const [normalized] = parseActorReviews({ text: JSON.stringify({ reviews: [review] }) }, [packet()]);
    expect(normalized.copy.title).toBe('GuestClip asked Mimi');
    expect(validateActorReview(normalized, packet())).toEqual([]);
  });
  test('metadata and comments alone cannot verify a narrator', () => {
    const bad = good(); bad.claims[0].identityBasis = 'explicit_text';
    expect(validateActorReview(bad, packet())).toContain('unproven_narrator:1');
  });
  test('missing fields, duplicate clips, and unresolved named actions fail closed', () => {
    const bad = good(); bad.claims[0].fields = ['title']; bad.claims[0].identityBasis = 'unresolved';
    expect(validateActorReview(bad, packet())).toContain('uncovered_copy_field:description');
    expect(validateActorReview(bad, packet())).toContain('unresolved_named_actor:1');
    expect(() => parseActorReviews({ text: JSON.stringify({ reviews: [good(), good()] }) }, [packet()])).toThrow();
    expect(applyActorReview(packet(), { clipId: 'c1', decision: 'needs_review' }).publicCopyPending).toBe(true);
  });
  test('an identity repair cannot silently replace a question with a declaration', () => {
    const bad = good(); bad.claims[0].action = 'declared affection';
    expect(validateActorReview(bad, packet())).toContain('question_action_removed');
  });
  test('past events cannot become live events merely by setting sourceKind to recount', () => {
    const review = good(); review.copy.description = '直播中现场追问米米';
    expect(validateActorReview(review, packet())).toContain('recount_as_live:description');
    review.copy.description = '回忆当时现场追问米米';
    expect(validateActorReview(review, packet())).not.toContain('recount_as_live:description');
  });
  test('single-host live speech does not trigger a new paid request', async () => {
    const parsed = { segments: [{ start: 0, end: 10, text: 'Hello there.' }], participantContext: { people: [context.people[0]] } };
    const evidence = buildSubtitleEvidence(parsed.segments);
    const sample = { ...clip, title: 'Hello', description: 'Hello', grounding: { sourceKind: 'live_speech' } };
    const spy = jest.spyOn(generator, 'generateTextWithDaiYu').mockRejectedValue(new Error('Unexpected request'));
    try {
      expect(attributionRisk(sample, evidence, parsed.participantContext)).toEqual([]);
      const diagnostics: any = {};
      const result = await reviewClipActors([sample], parsed, [], evidence, { roomId: '1' },
        { attribution: { enabled: true, roomIds: ['1'] }, ai: { enabled: true } }, { ai: { text: { provider: 'daiYu' } } }, diagnostics);
      expect(result[0]).toBe(sample);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  test('neutral copy is not reviewed just because another participant appears elsewhere in the stream', () => {
    const local = buildSubtitleEvidence([{ start: 0, end: 10, text: 'The client crashed.', speakerEvidence: { status: 'unknown',
      observations: [{ label: 'UNKNOWN', scope: 'row_rejected' }] } }]);
    const neutral = { start: 0, end: 10, title: 'Client startup failed', description: 'A startup failure.', grounding: { sourceKind: 'live_speech' } };
    expect(attributionRisk(neutral, local, context)).toEqual([]);
    expect(attributionRisk({ ...neutral, title: 'Host crashed the client' }, local, context)).toContain('uncertain_speaker');
  });
  test('valid claim citations do not inherit uncertainty from an unrelated short response', () => {
    const evidence = buildSubtitleEvidence([{ start: 0, end: 10, text: 'Host has a new cup.', speakerEvidence: voice('Host') },
      { start: 10, end: 11, text: 'Uh.', speakerEvidence: { status: 'unknown', observations: [{ label: 'UNKNOWN', scope: 'row_rejected' }] } }], { groupSegments: false });
    const sample = { start: 0, end: 11, title: 'Host has a new cup', description: 'Host has a new cup.',
      grounding: { status: 'linked', sourceSha256: evidence.sourceSha256, subtitleIds: ['G1'], sourceKind: 'live_speech' } };
    expect(attributionRisk(sample, evidence, { people: [context.people[0]] })).toEqual([]);
    expect(attributionRisk({ ...sample, grounding: { ...sample.grounding, sourceSha256: 'old' } }, evidence, context)).toContain('uncertain_speaker');
    expect(attributionRisk({ ...sample, grounding: { ...sample.grounding, subtitleIds: ['G2'] } }, evidence, context)).toContain('uncertain_speaker');
  });
  test('budget exhaustion keeps the original clip for review instead of silently approving it', async () => {
    const diagnostics: any = {};
    const result = await reviewClipActors([clip], { participantContext: context }, [], source, { roomId: '1' },
      { attribution: { enabled: true, roomIds: ['1'], maxRequests: 0 }, ai: { enabled: true } }, {}, diagnostics);
    expect(result[0].publicCopyPending).toBe(true);
    expect(result[0].attributionReview.issues).toEqual(['actor_review_unavailable']);
    expect(result[0].title).toBe(clip.title);
  });
  test('post-review source, bounds, or packaging changes invalidate eligibility', () => {
    const updated = applyActorReview(packet(), good());
    const copy = good().copy;
    expect(finalizeActorReview({ copy, uploadReady: true }, updated, copy, source).uploadReady).toBe(true);
    expect(finalizeActorReview({ copy: { ...copy, title: 'Changed' }, uploadReady: true }, updated, copy, source).uploadReady).toBe(false);
    expect(finalizeActorReview({ copy, uploadReady: true }, { ...updated, end: 11 }, copy, source).uploadReady).toBe(false);
  });
  test('makes at most one repair for explicit validation issues, counting both requests', async () => {
    const first = good(); first.copy.title = 'Someone asked Mimi';
    const calls: string[] = [];
    const spy = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async (prompt: string) => {
      calls.push(prompt);
      return { text: JSON.stringify({ reviews: [calls.length === 1 ? first : good()] }), meta: { attempts: [] } };
    });
    try {
      const diagnostics: any = {};
      const result = await reviewClipActors([clip], { participantContext: context }, [], source, { roomId: '1' },
        { attribution: { enabled: true, roomIds: ['1'], maxRequests: 2 }, ai: { enabled: true, selectionCacheEnabled: false } },
        { ai: { text: { provider: 'daiYu' } } }, diagnostics);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain('guest_name_missing_from_title');
      expect(result[0].attributionReview.status).toBe('passed');
      expect(diagnostics.requests).toHaveLength(2);
      expect(diagnostics.attribution.requests).toBe(2);
    } finally { spy.mockRestore(); }
  });
  test('does not add independent analysis when the first actor review is already conclusive', async () => {
    const calls: string[] = [];
    const spy = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async (prompt: string) => {
      calls.push(prompt); return { text: JSON.stringify({ reviews: [good()] }), meta: { attempts: [] } };
    });
    try {
      const diagnostics: any = {};
      const result = await reviewClipActors([clip], { participantContext: context }, [], source, { roomId: '1' },
        { attribution: { enabled: true, roomIds: ['1'], dialogueEnabled: true, maxRequests: 3 }, ai: { enabled: true, selectionCacheEnabled: false } },
        { ai: { text: { provider: 'daiYu' } } }, diagnostics);
      expect(result[0].attributionReview.status).toBe('passed');
      expect(calls).toHaveLength(1);
      expect(diagnostics.attribution.requests).toBe(1);
    } finally { spy.mockRestore(); }
  });
  test('unresolved identity can receive fresh independent evidence and one repair, within the shared budget', async () => {
    const calls: string[] = [];
    const spy = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async (prompt: string) => {
      calls.push(prompt);
      if (calls.length === 1) return { text: JSON.stringify({ reviews: [{ clipId: 'c1', decision: 'needs_review' }] }), meta: { attempts: [] } };
      if (calls.length === 2) {
        expect(prompt).not.toContain('Host asked Mimi');
        expect(prompt).not.toContain('[V=');
        return { text: JSON.stringify({ windows: [{ clipId: 'c1', multiSpeaker: 'yes', turns: [{ speakerId: 'guest', cueIds: ['G1'],
          anchorCueIds: ['G1','G2'], evidenceDanmakuIds: [], confidence: 'high', reason: 'Reciprocal source dialogue.' }] }] }), meta: { attempts: [] } };
      }
      const review = good(); review.claims[0].identityBasis = 'dialogue';
      return { text: JSON.stringify({ reviews: [review] }), meta: { attempts: [] } };
    });
    try {
      const diagnostics: any = {};
      const result = await reviewClipActors([clip], { participantContext: context }, [], source, { roomId: '1' },
        { attribution: { enabled: true, roomIds: ['1'], dialogueEnabled: true, maxRequests: 3 }, ai: { enabled: true, selectionCacheEnabled: false } },
        { ai: { text: { provider: 'daiYu' } } }, diagnostics);
      expect(result[0].attributionReview.status).toBe('passed');
      expect(calls).toHaveLength(3);
      expect(diagnostics.requests.map((row: any) => row.phase)).toEqual(['actor-review-1','dialogue-evidence-2','actor-review-3-repair']);
    } finally { spy.mockRestore(); }
  });
  test('bounded concurrent batches preserve clip order and cannot exceed their shared request limit', async () => {
    let active = 0, peak = 0, calls = 0;
    const spy = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async (prompt: string) => {
      calls++; peak = Math.max(peak, ++active);
      const data = JSON.parse(prompt.split('\n').at(-1)!);
      await new Promise(resolve => setTimeout(resolve, data.clipId === 'c1' ? 25 : 5));
      active--;
      return { text: JSON.stringify({ reviews: [{ ...good(), clipId: data.clipId }] }), meta: { attempts: [] } };
    });
    try {
      const diagnostics: any = {};
      const input = [1,2,3].map(index => ({ ...clip, testIndex: index }));
      const result = await reviewClipActors(input, { participantContext: context }, [], source, { roomId: '1' },
        { attribution: { enabled: true, roomIds: ['1'], batchSize: 1, concurrency: 2, maxRequests: 2 }, ai: { enabled: true, selectionCacheEnabled: false } },
        { ai: { text: { provider: 'daiYu' } } }, diagnostics);
      expect(peak).toBe(2);
      expect(calls).toBe(2);
      expect(result.map((item: any) => item.testIndex)).toEqual([1,2,3]);
      expect(result.map((item: any) => item.attributionReview.status)).toEqual(['passed','passed','needs_review']);
      expect(diagnostics.attribution.requests).toBe(2);
    } finally { spy.mockRestore(); }
  });
  test('unregistered local participant clues can request dialogue analysis without certifying presence', async () => {
    const mentioned = { people: context.people.map((person: any) => ({ ...person,
      presence: person.sourceHost ? 'source_host' : 'mentioned_only' })) };
    const evidence = buildSubtitleEvidence([{ start: 0, end: 5, text: 'Guest, did you ask Mimi?' },
      { start: 5, end: 10, text: 'Yes, Host, I asked Mimi.' }], { groupSegments: false });
    let calls = 0;
    const spy = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async () => {
      calls++;
      const text = calls === 2 ? { windows: [{ clipId: 'c1', multiSpeaker: 'uncertain', turns: [] }] }
        : { reviews: [{ clipId: 'c1', decision: 'needs_review' }] };
      return { text: JSON.stringify(text), meta: { attempts: [] } };
    });
    try {
      const diagnostics: any = {};
      const result = await reviewClipActors([clip], { participantContext: mentioned }, [], evidence, { roomId: '1' },
        { attribution: { enabled: true, roomIds: ['1'], dialogueEnabled: true, maxRequests: 3 }, ai: { enabled: true, selectionCacheEnabled: false } },
        { ai: { text: { provider: 'daiYu' } } }, diagnostics);
      expect(diagnostics.requests.map((row: any) => row.phase)).toEqual(['actor-review-1', 'dialogue-evidence-2']);
      expect(result[0].publicCopyPending).toBe(true);
      expect(mentioned.people[1].presence).toBe('mentioned_only');
    } finally { spy.mockRestore(); }
  });
  test('elapsed budget prevents new batches and repair without cancelling an in-flight result', async () => {
    let now = 1000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const first = good(); first.copy.title = 'Someone asked Mimi';
    const spy = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async () => {
      now += 1001;
      return { text: JSON.stringify({ reviews: [first] }), meta: { attempts: [] } };
    });
    try {
      const diagnostics: any = {};
      const result = await reviewClipActors([clip, clip], { participantContext: context }, [], source, { roomId: '1' },
        { attribution: { enabled: true, roomIds: ['1'], dialogueEnabled: true, batchSize: 1, concurrency: 1,
          maxRequests: 6, maxElapsedMs: 1000 }, ai: { enabled: true, selectionCacheEnabled: false } },
        { ai: { text: { provider: 'daiYu' } } }, diagnostics);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.every((item: any) => item.publicCopyPending)).toBe(true);
      expect(result[1].attributionReview.issues).toEqual(['actor_review_time_budget_exhausted']);
    } finally { spy.mockRestore(); clock.mockRestore(); }
  });
});
