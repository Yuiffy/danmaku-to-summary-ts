export {};
const { buildPreflightEvidence, buildPreflightInput, buildPreflightPrompt, samplePreflightAudience } = require('./preflight_evidence');
const { normalizePreflightResponse } = require('./preflight_plan');
const { preflightSelections } = require('./preflight_runner');
const { getClipTopicsConfig } = require('./topic_config');

// Minimal maintained evidence from candidate 2268: a delayed question resumes the group-chat story.
const segments = [
  { start: 6953.720, end: 6955.930, text: '就剧情上的还是会玩玩的啦' },
  { start: 6963.850, end: 6967.439, text: '嗯小这个是和牛高手' },
  { start: 6967.439, end: 6969.340, text: '没想到吧我怎么不知道' },
  { start: 6969.340, end: 6971.550, text: '他叫他之前打完那个boss就去群里说' },
  { start: 6971.550, end: 6975.475, text: '是什么怎么怎么过怎么怎么过的这样子' },
  { start: 6976.279, end: 6983.305, text: '嘿嘿嗯嗯嗯我知道黑魂嘛' },
  { start: 6986.649, end: 6990.925, text: '我只玩过我只玩过那亚特力棒棒' },
  { start: 6992.229, end: 6994.479, text: '嗯如果比岁己游戏力差' },
  { start: 6994.600, end: 6999.960, text: '就骂你你刚啊你怎么这么说小醉呀' },
  { start: 7000.359, end: 7001.340, text: '有人接话吗' },
  { start: 7001.340, end: 7004.635, text: '有啊小康啊就接他话了' },
  { start: 7005.029, end: 7017.100, text: '哎呦我去又磕到了可以嗯嗯嗯嗯嗯' },
  { start: 7025.279, end: 7032.819, text: '对的对的对的' },
  { start: 7032.819, end: 7040.359, text: '那你们要看我打什么' }
];
const config = getClipTopicsConfig({ clipTopics: { keywords: ['岁己', '小岁'], review: { qualityRules: true } } });
const evidence = buildPreflightEvidence(segments);
const group = { index: 'E1', start: 6953.720, end: 7040.359, cues: evidence.cues, bursts: [],
  matchSegments: [{ ...segments[7], matchedKeywords: ['岁己'] }] };
const input = buildPreflightInput(group, evidence, config);
const hit = { id: 'K1', verdict: 'mention', reason: '片中真实提及', evidenceCueIds: ['G8'] };
const boundaryReview = { setupCueId: 'G2', closureCueId: 'G13',
  startReason: '魂游高手的介绍引出群里聊过关', endReason: '接话反应确认完后才转到自己玩什么',
  dependencies: [{ cueId: 'G10', dependsOnCueIds: ['G4', 'G5'], reason: '接话问的是之前群里聊过关的事' },
    { cueId: 'G11', dependsOnCueIds: ['G10'], reason: '回答谁接了群里那句话' }], unresolvedCueIds: [] };
const clip = { id: 'E1-1', status: 'ready', startCueId: 'G2', endCueId: 'G13', hitIds: ['K1'],
  event: '群里聊过关和接话', reason: '保留群聊起因及延迟问答', score: 80, extensionReason: '', sourceKind: 'live_speech',
  evidenceCueIds: ['G8', 'G10', 'G11'], evidenceDanmakuIds: [], warnings: [],
  title: '聊到群里怎么过关', description: '聊到群里交流过关与接话。', coverText: '聊到游戏\n群里有人接话', subtitleEdits: [], boundaryReview };
const normalize = (value, options = {}, settings = config) => normalizePreflightResponse(
  JSON.stringify({ hits: [hit], clips: [value] }), input, evidence, settings, options);

test('holds the old narrow cut when its delayed answer depends on group chat outside the window', () => {
  const result = normalize({ ...clip, startCueId: 'G6', endCueId: 'G12' }).clips[0];
  expect(result.status).toBe('needs_review');
  expect(result.issues).toContain('回指依赖仍在选窗外：G4');
  expect(result.issues).toContain('收尾仍在选窗外：G13');
  expect(result.start).toBe(6976.279); // Validation does not invent or silently expand an edit.
});

test('accepts the continuous complete exchange without attaching the unrelated next topic', () => {
  const before = JSON.stringify(segments);
  const plan = normalize(clip);
  expect(plan.clips[0]).toMatchObject({ status: 'ready', start: 6963.850, end: 7032.819,
    boundaryReview: { status: 'linked', dependencies: boundaryReview.dependencies } });
  expect(plan.clips[0].subtitleSegments.some(cue => cue.text === segments[13].text)).toBe(false);
  expect(JSON.stringify(segments)).toBe(before);
  const selection = preflightSelections({ ...plan, record: { strategy: 'single', model: 'test' } }, group, config)[0];
  expect(selection.preflight.boundaryReview).toEqual(plan.clips[0].boundaryReview);
});

test('an unresolved prerequisite cannot pass by returning empty dependencies', () => {
  const result = normalize({ ...clip, boundaryReview: { ...boundaryReview,
    dependencies: [], unresolvedCueIds: ['G10'] } }).clips[0];
  expect(result.status).toBe('needs_review');
  expect(result.issues).toContain('未找到必要起因或收尾：G10');
  expect(normalize({ ...clip, boundaryReview: undefined }).clips[0].status).toBe('needs_review');
});

test.each([
  { ...boundaryReview, setupCueId: 'G999' },
  { ...boundaryReview, dependencies: [{ cueId: 'G10', dependsOnCueIds: ['G999'], reason: '不存在的来源' }] },
  { ...boundaryReview, dependencies: [{ cueId: 'G10', dependsOnCueIds: ['G10'], reason: '循环自证' }] },
  { ...boundaryReview, startReason: '' }
])('holds incomplete or invented boundary evidence: %j', review => {
  expect(normalize({ ...clip, boundaryReview: review }).clips[0].status).toBe('needs_review');
});

test('staged finalization preserves the locked dependency review, including an unresolved hold', () => {
  const planned = normalize({ ...clip, boundaryReview: { ...boundaryReview, unresolvedCueIds: ['G10'] } }, { phase: 'plan' });
  const result = normalize({ ...clip, boundaryReview: { ...boundaryReview, dependencies: [] } }, {
    phase: 'finish', lockedClip: planned.clips[0], lockedHits: planned.hits
  }).clips[0];
  expect(result.status).toBe('needs_review');
  expect(result.boundaryReview.unresolvedCueIds).toEqual(['G10']);
});

test('cyclic prerequisites hold the candidate while a later acyclic explanation remains allowed', () => {
  const laterExplanation = { ...boundaryReview, dependencies: [
    { cueId: 'G10', dependsOnCueIds: ['G11'], reason: '后面的回答说明这句的问题对象' }
  ] };
  expect(normalize({ ...clip, boundaryReview: laterExplanation }).clips[0].status).toBe('ready');
  const cycle = { ...laterExplanation, dependencies: [...laterExplanation.dependencies,
    { cueId: 'G11', dependsOnCueIds: ['G12'], reason: '依赖下一句' },
    { cueId: 'G12', dependsOnCueIds: ['G10'], reason: '循环回到问题' }] };
  const result = normalize({ ...clip, boundaryReview: cycle }).clips[0];
  expect(result.status).toBe('needs_review');
  expect(result.issues).toContain('回指依赖存在循环：G10 → G11 → G12 → G10');
});

test('the complete audit repair example includes the same required boundary schema', () => {
  const { buildQualityAuditPrompt } = require('./preflight_quality');
  const prompt = buildQualityAuditPrompt(normalize(clip), input);
  const example = JSON.parse(prompt.split('replacement when repairing: ')[1].split('\n')[0]);
  expect(example.boundaryReview).toMatchObject({ setupCueId: 'G1', closureCueId: 'G20',
    dependencies: [{ cueId: 'G18', dependsOnCueIds: ['G2'] }], unresolvedCueIds: [] });
});

test('legacy configurations keep optional boundary evidence while the quality prompt requests explicit dependencies', () => {
  const legacy = getClipTopicsConfig({ clipTopics: { keywords: config.keywords, review: { qualityRules: false } } });
  expect(normalize({ ...clip, boundaryReview: undefined }, {}, legacy).clips[0].status).toBe('ready');
  const prompt = buildPreflightPrompt(input);
  expect(prompt).toContain('delayed audience questions/answers');
  expect(prompt).toContain('"dependsOnCueIds"');
  expect(prompt).toContain('unresolvedCueIds');
});

test('bounded audience sampling retains the target introduction and delayed question lost by uniform sampling', () => {
  const rows = Array.from({ length: 240 }, (_, index) => ({ id: `row-${index}`, time: 6810 + index * 2, text: '嘻嘻' }));
  rows[75] = { id: 'D1711', time: 6958.026, text: '小岁可是魂游高手没想到吧' };
  rows[91] = { id: 'D1716', time: 6990.528, text: '有人接她话吗' };
  const old = Array.from({ length: 120 }, (_, index) => rows[Math.floor(index * rows.length / 120)]);
  expect(old.some(row => ['D1711', 'D1716'].includes(row.id))).toBe(false);
  const selected = samplePreflightAudience(rows, segments, config.keywords, 120);
  expect(selected).toHaveLength(120);
  expect(selected.map(row => row.id)).toEqual(expect.arrayContaining(['D1711', 'D1716']));
  expect(selected.map(row => rows.indexOf(row))).toEqual([...selected.map(row => rows.indexOf(row))].sort((a, b) => a - b));
});

test('many keyword messages cannot crowd out a spoken question or all remaining context', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ id: `D${index + 1}`, time: 6800 + index,
    text: index < 70 ? '小岁来了' : `其他话题${index}` }));
  rows[79] = { id: 'D80', time: 6990.528, text: '有人接她话吗' };
  const selected = samplePreflightAudience(rows, segments, config.keywords, 10);
  expect(selected).toHaveLength(10);
  expect(selected.some(row => row.id === 'D80')).toBe(true);
  expect(selected.some(row => row.text.startsWith('其他话题'))).toBe(true);
  expect(samplePreflightAudience(rows.slice(0, 5), segments, config.keywords, 10)).toEqual(rows.slice(0, 5));
});

test('large disjoint priority pools retain late evidence from both types across the full timeline', () => {
  const rows = Array.from({ length: 192 }, (_, index) => [
    { id: `keyword-${index}`, time: index * 3, text: `小岁来了${index}` },
    { id: `question-${index}`, time: index * 3 + 1, text: '有人接她话吗' },
    { id: `context-${index}`, time: index * 3 + 2, text: '别的话题' }
  ]).flat();
  const speech = Array.from({ length: 192 }, (_, index) => ({
    start: index * 3 + 5, end: index * 3 + 6, text: '有人接话吗'
  }));
  const selected = samplePreflightAudience(rows, speech, config.keywords, 120);
  expect(selected).toHaveLength(120);
  for (const type of ['keyword-', 'question-']) {
    const retained = selected.filter(row => row.id.startsWith(type));
    expect(retained).toHaveLength(48);
    expect(retained.some(row => row.time >= 144 * 3)).toBe(true);
    expect(retained.some(row => row.time < 48 * 3)).toBe(true);
  }
  expect(selected.filter(row => row.id.startsWith('context-'))).toHaveLength(24);
});
