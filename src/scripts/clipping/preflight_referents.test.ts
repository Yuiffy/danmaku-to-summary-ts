export {};
const { buildPreflightEvidence, buildPreflightInput, buildPreflightPrompt, samplePreflightAudience } = require('./preflight_evidence');
const { normalizePreflightResponse } = require('./preflight_plan');
const { getClipTopicsConfig } = require('./topic_config');

// Minimal source evidence from 3598: spray use and a later chat-triggered eyeliner answer.
const segments = [
  { start: 2286.8, end: 2288.622, text: '小太就拿他的补水喷雾就一直给往给我脸' },
  { start: 2315.36, end: 2316.949, text: '你不给他收回来了吗' },
  { start: 2333.199, end: 2335, text: '当然没有了' },
  { start: 2405.699, end: 2408.4, text: '那我当时他说不要了' },
  { start: 2408.4, end: 2414.014, text: '我说那我拿走了他说他说没水啦' },
  { start: 2414.98, end: 2417.44, text: '我说没水我也要这是可是小岁用过的' },
  { start: 2417.44, end: 2421.119, text: '我是正大光明拿的' },
  { start: 2452.599, end: 2453.375, text: '好搞笑' }
];
const config = getClipTopicsConfig({ clipTopics: { keywords: ['岁己', '小岁'], review: { qualityRules: true } } });
const evidence = buildPreflightEvidence(segments);
const group = { index: 'E1', start: segments[0].start, end: segments.at(-1)!.end, cues: evidence.cues, bursts: [],
  matchSegments: [{ ...segments[5], matchedKeywords: ['小岁'] }] };
const comments = [{ time: 2288.691, text: '岁己的眼线笔' },
  { time: 2396.924, text: '岁己的眼线笔呢' }];
const input = buildPreflightInput(group, evidence, config, {}, comments);
const packetOf = (prompt: string) => JSON.parse(prompt.split('SOURCE EVIDENCE:\n')[1]);

test('initial generation sees chat directly before the relevant speech while retaining the original source tables', () => {
  const before = JSON.stringify({ segments, comments, input });
  const packet = packetOf(buildPreflightPrompt(input));
  const answer = packet.subtitles.find(row => row.id === 'G4');
  expect(answer.audienceBefore).toEqual([{ id: 'D2', time: 2396.924, text: '岁己的眼线笔呢' }]);
  expect(answer.text).toBe('那我当时他说不要了');
  expect(packet.subtitles.map(({ audienceBefore, ...row }) => row)).toEqual(input.subtitles);
  expect(packet.audience).toEqual(input.audience);
  expect(packet.subtitles.some(row => row.text.includes('补水喷雾'))).toBe(true);
  expect(JSON.stringify({ segments, comments, input })).toBe(before);
});

test('a substantive question without a target name survives a flood of laughter within the existing row budget', () => {
  const rows = Array.from({ length: 240 }, (_, index) => ({ id: `D${index + 1}`, time: index, text: '哈哈哈哈' }));
  rows[91] = { id: 'D92', time: 91, text: '那支眼线笔后来拿了吗' };
  rows[175] = { id: 'D176', time: 175, text: '之前那个补水喷雾好贵' };
  const before = JSON.stringify(rows);
  const sampled = samplePreflightAudience(rows, [], ['小岁'], 120);
  expect(sampled).toHaveLength(120);
  expect(sampled.map(row => row.id)).toEqual(expect.arrayContaining(['D92', 'D176']));
  expect(sampled.map(row => row.time)).toEqual([...sampled.map(row => row.time)].sort((a, b) => a - b));
  expect(JSON.stringify(rows)).toBe(before);
});

test('finishing presents the current approved subtitle text alongside chat', () => {
  const prepared = { ...input, subtitles: input.subtitles.map(row => row.id === 'G4' ? { ...row, text: '这是本阶段已批准的字幕' } : row) };
  const packet = packetOf(buildPreflightPrompt(prepared, 'finish'));
  expect(packet.subtitles.find(row => row.id === 'G4')).toMatchObject({ text: '这是本阶段已批准的字幕', audienceBefore: [{ id: 'D2' }] });
  expect(input.subtitles.find(row => row.id === 'G4').text).toBe(segments[3].text);
});

test('the extra reading context does not change the response contract or introduce a validation requirement', () => {
  const raw = { id: 'E1-1', status: 'ready', startCueId: 'G1', endCueId: 'G8', hitIds: ['K1'],
    event: '谈论借用喷雾并回应弹幕', reason: '原有事件和边界合同', score: 80, extensionReason: '', sourceKind: 'recount',
    evidenceCueIds: ['G4', 'G5', 'G6', 'G7'], evidenceDanmakuIds: [], warnings: [],
    title: '说起拿走空眼线笔，解释是对方不要了', description: '解释拿走空眼线笔的经过。',
    coverText: '没水我也要\n我是正大光明拿的', subtitleEdits: [],
    boundaryReview: { setupCueId: 'G1', closureCueId: 'G8', startReason: '话题引入', endReason: '笑声收尾',
      dependencies: [], unresolvedCueIds: [] } };
  const response = JSON.stringify({ hits: [{ id: 'K1', verdict: 'mention', reason: '原话提及', evidenceCueIds: ['G6'] }], clips: [raw] });
  const enhanced = packetOf(buildPreflightPrompt(input));
  const original = normalizePreflightResponse(response, input, evidence, config);
  expect(normalizePreflightResponse(response, enhanced, evidence, config)).toEqual(original);
  expect(original.clips[0].status).toBe('ready');
  expect(buildPreflightPrompt(input)).not.toContain('dependsOnDanmakuIds');
});

test('an older active release uses the original presentation without adding a hold or failing generation', () => {
  const runtime = require('../workflow-runtime');
  const load = runtime.loadWorkflow;
  const spy = jest.spyOn(runtime, 'loadWorkflow').mockImplementation((name: string) => {
    if (name === 'clipping/preflightConversation') throw new Error('Unknown compiled workflow: clipping/preflightConversation');
    return load(name);
  });
  try {
    expect(packetOf(buildPreflightPrompt(input))).toEqual(input);
    expect(samplePreflightAudience(input.audience, input.subtitles, config.keywords, 1)).toHaveLength(1);
  } finally { spy.mockRestore(); }
});

test('the optional inline view cannot crowd source evidence out of the request budget', () => {
  const measured = buildPreflightPrompt(input).length;
  const tight = { ...input, limits: { ...input.limits, maxEvidenceChars: measured - 100 } };
  const prompt = buildPreflightPrompt(tight);
  expect(prompt.length).toBeLessThan(tight.limits.maxEvidenceChars);
  expect(packetOf(prompt)).toEqual(tight);
});
