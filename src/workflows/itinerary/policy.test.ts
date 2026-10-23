import { buildPrompt, day, Evidence, formatPlans, MAX_PROMPT_CHARS, queryPlans, selectEvidence, summarizeUsage, validateExtraction, validatePlans } from './policy';

const registry = { sui: { displayName: '岁己', roomIds: ['1'] }, mofu: { displayName: '犬绒', roomIds: ['2'] } };
const evidence: Evidence[] = [{ id: 'T1', kind: 'subtitle', text: '犬绒说：明天和岁己在上海见面', observedAt: '2026-10-18T20:00:00+08:00', source: 'recording.srt', offsetSeconds: 20 }];
const plan = { event: '上海会面', kind: 'meeting', participants: ['sui', 'mofu'], startDay: '2026-10-19', endDay: '2026-10-19',
  status: 'planned', location: '上海', citations: [{ id: 'T1', quote: evidence[0].text }] };
const validate = (p: any = plan, rows = evidence) => validatePlans({ plans: [p] }, rows, registry);

it('retains cited cross-room plans and uses Shanghai day across midnight', () => {
  expect(day('2026-10-18T16:00:00Z')).toBe('2026-10-19');
  const memory = { sourceId: 'mofu-recording', sourceRoom: '2', plans: validate(), evidence };
  expect(queryPlans([memory], 'sui', '2026-10-19T18:00:00+08:00')).toHaveLength(1);
  expect(queryPlans([memory], 'sui', '2026-10-18T19:59:59+08:00')).toEqual([]);
  expect(queryPlans([memory], 'sui', '2026-10-20T00:00:00+08:00')).toEqual([]);
});

it('rejects fabricated quotes, unknown identities, invalid dates and events outside the horizon', () => {
  for (const invalid of [
    { ...plan, citations: [{ id: 'T1', quote: '完全没有说过的话' }] },
    { ...plan, citations: [{ id: 'missing', quote: evidence[0].text }] },
    { ...plan, participants: ['unknown'] }, { ...plan, startDay: '2026-02-30' },
    { ...plan, startDay: '2026-11-30', endDay: '2026-11-30' }
  ]) expect(() => validate(invalid)).toThrow();
});

it('never promotes audience speculation or an unbound first-person subject', () => {
  expect(validate(plan, [{ ...evidence[0], kind: 'danmaku' }])[0]).toMatchObject({ status: 'tentative', confidence: 'tentative' });
  const rows = [{ ...evidence[0], text: '明天我去上海见岁己' }];
  expect(validate({ ...plan, citations: [{ id: 'T1', quote: rows[0].text }] }, rows)[0].confidence).toBe('tentative');
  const cancelled = validate({ ...plan, status: 'cancelled' }, [{ ...evidence[0], kind: 'danmaku' }]);
  expect(cancelled[0]).toMatchObject({ status: 'cancelled', confidence: 'tentative' });
  const memory = { sourceId: 'audience', sourceRoom: '2', plans: cancelled, evidence: [{ ...evidence[0], kind: 'danmaku' as const }] };
  expect(queryPlans([memory], 'sui', '2026-10-19T18:00:00+08:00')).toEqual([]);
  expect(queryPlans([memory, { ...memory, sourceId: 'speech', plans: validate(), evidence }], 'sui', '2026-10-19T18:00:00+08:00')).toHaveLength(1);
});

it('lets a later cited cancellation suppress plans from other rooms without erasing an earlier historical view', () => {
  const old = { sourceId: 'a', sourceRoom: '2', plans: validate(), evidence };
  const rows = [{ ...evidence[0], id: 'P1', kind: 'dynamic' as const, text: '犬绒与岁己明天上海会面取消', observedAt: '2026-10-18T23:00:00+08:00' }];
  const cancelled = { ...plan, status: 'cancelled', citations: [{ id: 'P1', quote: rows[0].text }] };
  const newer = { sourceId: 'b', sourceRoom: '1', plans: validate(cancelled, rows), evidence: rows };
  expect(queryPlans([old, newer], 'sui', '2026-10-19T18:00:00+08:00')).toEqual([]);
  const earlierSameDay = { ...plan, startDay: '2026-10-18', endDay: '2026-10-19', citations: [{ id: 'T1', quote: '犬绒和岁己今天在上海见面' }] };
  const historicalEvidence = [{ ...evidence[0], text: earlierSameDay.citations[0].quote }];
  const historical = { ...old, evidence: historicalEvidence, plans: validate(earlierSameDay, historicalEvidence) };
  expect(queryPlans([historical, newer], 'sui', '2026-10-18T22:00:00+08:00')).toHaveLength(1);
});

it('checks literal dates against each original row clock and omits private quote details from generation context', () => {
  expect(() => validate({ ...plan, startDay: '2026-10-20', endDay: '2026-10-20' })).toThrow('itinerary_date_conflicts_with_quote');
  const midnight = [{ ...evidence[0], observedAt: '2026-10-18T16:01:00Z' }];
  expect(validate({ ...plan, startDay: '2026-10-20', endDay: '2026-10-20' }, midnight)).toHaveLength(1);
  expect(formatPlans([{ ...validate()[0], event: 'XX酒店402房间同住', location: 'XX酒店', citations: [{ id: 'T1', quote: '入住私人地址' }] }]))
    .not.toMatch(/402|XX酒店|入住私人地址/u);
});

it('reports unknown real usage separately from measured usage rather than treating failures as free', () => {
  expect(summarizeUsage([{ usage: { requests: 1, estimatedInputTokens: 200 }, generation: { attempts: [
    { promptTokens: 100, cachedTokens: 10, completionTokens: 20, totalTokens: 120 }
  ] } }, { usage: { requests: 1, estimatedInputTokens: 300 }, status: 'failed' }])).toMatchObject({
    requestAttempts: 2, measuredRequests: 1, requestsWithoutMeasuredUsage: 1,
    estimatedInputTokens: 500, measuredPromptTokens: 100, measuredTotalTokens: 120
  });
});

it('keeps a dated phonetic-name hypothesis tentative and preserves it when another proposal lacks a date citation', () => {
  const rows: Evidence[] = [{ ...evidence[0], id: 'T1', text: '看大人的三D我敢迟到吗' },
    { ...evidence[0], id: 'T2', text: '明天只见小明，后天犬容也会来' }];
  const bad = { ...plan, status: 'tentative', citations: [{ id: 'T1', quote: rows[0].text }] };
  const hypothesis = { ...plan, startDay: '2026-10-20', endDay: '2026-10-20', status: 'tentative',
    citations: [{ id: 'T2', quote: rows[1].text }] };
  expect(validateExtraction({ plans: [bad, hypothesis] }, rows, registry)).toMatchObject({
    plans: [{ participants: ['mofu', 'sui'], status: 'tentative', confidence: 'tentative' }],
    rejected: [{ index: 0, error: 'itinerary_date_not_in_citations' }]
  });
  expect(() => validatePlans({ plans: [{ ...hypothesis, status: 'planned' }] }, rows, registry)).toThrow('itinerary_people_not_in_citations');
});

it('repairs a misnumbered citation only when its exact quote uniquely identifies a supplied row', () => {
  const raw = { plans: [{ ...plan, citations: [{ id: 'wrong', quote: evidence[0].text }] }] };
  const fixed = validateExtraction(raw, evidence, registry);
  expect(fixed.plans[0].citations[0].id).toBe('T1');
  expect(fixed.repairedCitations).toEqual([{ planIndex: 0, from: 'wrong', to: 'T1' }]);
  const ambiguous = validateExtraction(raw, [...evidence, { ...evidence[0], id: 'T2' }], registry);
  expect(ambiguous.plans).toEqual([]);
  expect(ambiguous.rejected).toEqual([{ index: 0, error: 'invalid_itinerary_citation' }]);
});

it('scans the whole corpus and caps model input even with thousands of plan mentions', () => {
  const rows = Array.from({ length: 10000 }, (_, i) => ({ ...evidence[0], id: `T${i}`, text: `明天犬绒和岁己见面${i}`, offsetSeconds: i * 3 }));
  const selected = selectEvidence(rows);
  expect(selected.scanned).toBe(10000);
  expect(selected.truncated).toBe(true);
  expect(buildPrompt(selected.rows, registry, '2').length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  expect(selectEvidence([{ ...evidence[0], text: '今天打游戏好开心' }]).rows).toEqual([]);
});
