export {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const generator = require('../ai_text_generator');
const { getClipTopicsConfig } = require('./topic_config');
const { buildPreflightEvidence, buildPreflightInput } = require('./preflight_evidence');
const { buildQualityDraftPrompt } = require('./preflight_quality');
const { prepareTopicGroup, preflightSelections } = require('./preflight_runner');

describe('preflight context recovery', () => {
  let directory: string, source: any, evidence: any, group: any, config: any, request: any;
  const root = { ai: { text: { enabled: true, provider: 'daiYu' } } };
  const diagnostics = () => ({ requests: [], failures: [] });
  const match = (cue: any) => ({ ...cue.items[0], matchedKeywords: ['SUI'] });
  const inputOf = (prompt: string) => JSON.parse(prompt.split('SOURCE EVIDENCE:\n')[1]);

  function clip(input: any, start: string, end: string, id = `${input.groupId}-1`): any {
    const first = evidence.byId.get(start), last = evidence.byId.get(end);
    const hits = input.hits.filter(hit => hit.start >= first.start && hit.end <= last.end);
    return { id, status: 'ready', startCueId: start, endCueId: end, hitIds: hits.map(hit => hit.id),
      event: '完整送礼经历', reason: '保留介绍、回应和收束', score: 80, extensionReason: '保留完整交流',
      sourceKind: 'live_speech', evidenceCueIds: [start, end, ...hits.map(hit => hit.cueId)],
      evidenceDanmakuIds: [], warnings: [], subtitleEdits: [], title: '完整送礼经历',
      description: '讲述送礼后的回应', coverText: '送出的礼物\n收到了回应',
      boundaryReview: { setupCueId: start, closureCueId: end, startReason: '完整介绍',
        endReason: '回应已经闭合，后文是独立事件', dependencies: [], unresolvedCueIds: [] } };
  }

  function result(input: any, clips: any[]) {
    return { text: JSON.stringify({ hits: input.hits.map(hit => ({ id: hit.id, verdict: 'mention',
      reason: '上下文明确提及人物', evidenceCueIds: [hit.cueId] })), clips }),
      meta: { model: config.review.model, attempts: [{ model: config.review.model,
        reasoningEffortSent: config.review.reasoningEffort, apiModeUsed: 'responses' }] } };
  }

  function incomplete(input: any, end: string, unresolved: string) {
    const draft = clip(input, 'G1', end);
    draft.status = 'needs_review';
    draft.boundaryReview.dependencies = [{ cueId: unresolved, dependsOnCueIds: ['G2'], reason: '后续继续回应送礼' }];
    draft.boundaryReview.unresolvedCueIds = [unresolved];
    return draft;
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-context-'));
    source = { srtPath: path.join(directory, 'source.srt'), streamerName: '主播' };
    fs.writeFileSync(source.srtPath, 'Original source, never rewritten');
    evidence = buildPreflightEvidence(Array.from({ length: 16 }, (_, index) => ({
      start: index * 20, end: (index + 1) * 20,
      text: [1, 5].includes(index) ? 'SUI收到礼物' : '完整的介绍与回应' })));
    group = { index: 'E1', start: 0, end: 100, cues: evidence.cues.slice(0, 5),
      matchSegments: [match(evidence.cues[1])], bursts: [{ index: 1, matchSegments: [match(evidence.cues[1])] }] };
    config = getClipTopicsConfig({ clipTopics: { keywords: ['SUI'], contextPrePaddingSeconds: 60,
      contextPostPaddingSeconds: 60, review: { enabled: true, mode: 'preflight', qualityRules: true,
        model: 'gpt-6-sol', reasoningEffort: 'high' }, ai: { selectionCacheEnabled: false } } });
    request = jest.spyOn(generator, 'generateTextWithDaiYu');
  });
  afterEach(() => { request.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); });
  const run = (options: any = {}, log = diagnostics()) => prepareTopicGroup(group, evidence, config, root, source, log, options);

  test('numeric recovery fits newly added context before its one request and retains every original row', async () => {
    const originalIds = group.cues.map(cue => cue.id);
    const requested = { start: 0, end: 320 };
    Object.assign(group, { ...requested, cues: evidence.cues });
    const fitting = { ...group, end: 200, cues: evidence.cues.slice(0, 10) };
    config.review.maxEvidenceChars = buildQualityDraftPrompt(buildPreflightInput(fitting, evidence, config,
      { ...source, verifiedFacts: [], verifiedEdits: [] })).length;
    request.mockImplementation(async (prompt: string) => {
      const input = inputOf(prompt);
      expect(prompt.length).toBeLessThanOrEqual(config.review.maxEvidenceChars);
      expect(input.subtitles.map(cue => cue.id)).toEqual(evidence.cues.slice(0, 10).map(cue => cue.id));
      expect(originalIds.every(id => input.subtitles.some(cue => cue.id === id))).toBe(true);
      return result(input, [clip(input, 'G1', 'G7')]);
    });
    const plan = await run({ retainedContext: { start: 0, end: 100 }, boundaryRepair: false });
    expect(request).toHaveBeenCalledTimes(1);
    expect(plan.clips[0].status).toBe('ready');
    expect(plan.record.contextBudget).toMatchObject({ requested, retained: { start: 0, end: 100 },
      supplied: { start: 0, end: 200 }, promptChars: config.review.maxEvidenceChars });
  });

  test('numeric recovery cannot discard required source or request the model when it still exceeds budget', async () => {
    config.review.maxEvidenceChars = 1;
    const before = group.cues.map(cue => cue.id);
    const plan = await run({ retainedContext: { start: 0, end: 100 }, boundaryRepair: false });
    expect(request).not.toHaveBeenCalled();
    expect(group.cues.map(cue => cue.id)).toEqual(before);
    expect(plan.record.errors).toContainEqual({ error: 'Preflight source exceeds request budget' });
  });

  test('expands exhausted context and can return independent anchored cuts despite a verbose failed draft', async () => {
    const before = JSON.stringify(evidence);
    const oldCues = group.cues.map(cue => cue.id);
    config.review.maxEvidenceChars = buildQualityDraftPrompt(buildPreflightInput(group, evidence, config, source)).length + 3500;
    let calls = 0;
    request.mockImplementation(async (prompt: string) => {
      const input = inputOf(prompt);
      if (calls++ === 0) {
        const draft = incomplete(input, 'G4', 'G5');
        draft.reason = '逐句解释原事件但缺少后文。'.repeat(3000);
        return result(input, [draft]);
      }
      expect(oldCues.every(id => input.subtitles.some(cue => cue.id === id))).toBe(true);
      expect(input.subtitles.at(-1).id).toBe('G8');
      expect(input.hits.map(hit => hit.cueId)).toEqual(['G2', 'G6']);
      expect(prompt.length).toBeLessThanOrEqual(config.review.maxEvidenceChars);
      return result(input, [clip(input, 'G1', 'G5'), clip(input, 'G6', 'G8', 'E1-2')]);
    });
    const plan = await run({ recallMatches: [match(evidence.cues[1]), match(evidence.cues[5])] });
    expect(request).toHaveBeenCalledTimes(2);
    expect(plan.clips.map(row => row.status)).toEqual(['ready', 'ready']);
    expect(plan.clips.map(row => [row.start, row.end])).toEqual([[0, 100], [100, 160]]);
    expect(plan.record.contextRecovery[0]).toMatchObject({ from: { start: 0, end: 100 }, to: { start: 0, end: 160 } });
    expect(plan.record.responses[0].text.length).toBeGreaterThan(config.review.maxEvidenceChars);
    expect(group.matchSegments.map(row => row.start)).toEqual([20, 100]);
    expect(preflightSelections(plan, group, config)).toHaveLength(2);
    expect(JSON.stringify(evidence)).toBe(before);
    expect(fs.readFileSync(source.srtPath, 'utf8')).toBe('Original source, never rewritten');
  });

  test('allows a second extension only while a concrete boundary dependency still needs new context', async () => {
    request.mockImplementation(async (prompt: string) => {
      const input = inputOf(prompt), tail = input.subtitles.at(-1).id;
      return result(input, [tail === 'G5' ? incomplete(input, 'G4', 'G5')
        : tail === 'G8' ? incomplete(input, 'G7', 'G8') : clip(input, 'G1', 'G10')]);
    });
    const plan = await run();
    expect(request).toHaveBeenCalledTimes(3);
    expect(plan.clips[0].status).toBe('ready');
    expect(plan.record.contextRecovery.map(row => row.to.end)).toEqual([160, 220]);
    expect(plan.input.subtitles.at(-1).id).toBe('G11');
  });

  test('keeps identity uncertainty held after boundaries are repaired', async () => {
    let calls = 0;
    request.mockImplementation(async (prompt: string) => {
      const input = inputOf(prompt);
      if (calls++ === 0) return result(input, [incomplete(input, 'G4', 'G5')]);
      const draft = clip(input, 'G1', 'G7');
      const response = result(input, [draft]);
      const raw = JSON.parse(response.text);
      raw.hits[0].verdict = 'uncertain';
      response.text = JSON.stringify(raw);
      return response;
    });
    const plan = await run();
    expect(request).toHaveBeenCalledTimes(2);
    expect(plan.clips[0].status).toBe('needs_review');
    expect(plan.clips[0].issues).toContain('Model requests human review or identity remains uncertain');
  });

  test('can read missing introduction context without extending a resolved ending', async () => {
    group.start = 60;
    group.end = 160;
    group.cues = evidence.cues.slice(3, 8);
    group.matchSegments = [match(evidence.cues[5])];
    group.bursts = [{ index: 1, matchSegments: group.matchSegments }];
    let calls = 0;
    request.mockImplementation(async (prompt: string) => {
      const input = inputOf(prompt);
      if (calls++ === 0) {
        const draft = clip(input, 'G4', 'G8');
        draft.boundaryReview.unresolvedCueIds = ['G4'];
        return result(input, [draft]);
      }
      expect(input.subtitles.map(cue => cue.id)).toEqual(evidence.cues.slice(0, 8).map(cue => cue.id));
      return result(input, [clip(input, 'G1', 'G8')]);
    });
    const plan = await run();
    expect(request).toHaveBeenCalledTimes(2);
    expect(plan.clips[0]).toMatchObject({ status: 'ready', start: 0, end: 160 });
    expect(plan.record.contextRecovery[0]).toMatchObject({ from: { start: 60, end: 160 }, to: { start: 0, end: 160 } });
  });

  test('fits a smaller contiguous extension when the full additional context exceeds the budget', async () => {
    evidence = buildPreflightEvidence(evidence.cues.map((cue, index) => ({ ...cue.items[0],
      text: index >= 5 ? 'response '.repeat(160) : cue.text })));
    group.cues = evidence.cues.slice(0, 5);
    config.contextPostPaddingSeconds = 300;
    config.review.maxEvidenceChars = buildQualityDraftPrompt(buildPreflightInput(group, evidence, config, source)).length + 6500;
    let calls = 0;
    request.mockImplementation(async (prompt: string) => {
      const input = inputOf(prompt);
      expect(prompt.length).toBeLessThanOrEqual(config.review.maxEvidenceChars);
      if (calls++ === 0) return result(input, [incomplete(input, 'G4', 'G5')]);
      expect(input.subtitles.slice(0, 5).map(cue => cue.id)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5']);
      expect(input.subtitles.length).toBeGreaterThanOrEqual(8);
      expect(input.subtitles.length).toBeLessThan(16);
      return result(input, [clip(input, 'G1', input.subtitles.at(-1).id)]);
    });
    const plan = await run();
    expect(request).toHaveBeenCalledTimes(2);
    expect(plan.clips[0].status).toBe('ready');
    expect(plan.record.contextRecovery[0].addedCueIds).toEqual(['G6', 'G7', 'G8']);
  });

  test('a still-unresolved context edge stops after two recovery requests', async () => {
    request.mockImplementation(async (prompt: string) => {
      const input = inputOf(prompt);
      return result(input, [incomplete(input, input.subtitles.at(-2).id, input.subtitles.at(-1).id)]);
    });
    const plan = await run();
    expect(request).toHaveBeenCalledTimes(3);
    expect(plan.clips[0].status).toBe('needs_review');
    expect(plan.clips[0].issues).toContain('未找到必要起因或收尾：G11');
    expect(plan.record.contextRecovery).toHaveLength(2);
  });

  test.each(['provider_failure', 'route_changed', 'source_end', 'group_limit', 'disabled', 'duration', 'overlap', 'copy'])('holds %s without looping', async failure => {
    if (failure === 'source_end') evidence = buildPreflightEvidence(evidence.cues.slice(0, 5).map(cue => cue.items[0]));
    if (failure === 'group_limit') config.editorial.maxGroupSeconds = 100;
    if (failure === 'duration') config.maxClipSeconds = 100;
    let calls = 0;
    request.mockImplementation(async (prompt: string) => {
      const input = inputOf(prompt);
      if (calls++ > 0 && failure === 'provider_failure') throw new Error('provider failed');
      const response = result(input, [incomplete(input, 'G4', 'G5')]);
      if (calls > 1 && failure === 'route_changed') response.meta.attempts[0].model = 'other-model';
      if (calls > 1 && ['duration', 'overlap', 'copy'].includes(failure)) {
        const repaired = clip(input, 'G1', 'G7');
        if (failure === 'copy') repaired.evidenceCueIds = ['G2', 'G8'];
        response.text = result(input, failure === 'overlap'
          ? [repaired, clip(input, 'G6', 'G8', 'E1-2')] : [repaired]).text;
      }
      return response;
    });
    const plan = await run(failure === 'disabled' ? { boundaryRepair: false } : {});
    expect(request).toHaveBeenCalledTimes(failure === 'disabled' ? 1 : 2);
    expect(plan.clips[0].status).toBe('needs_review');
  });

  test('an already valid result makes no recovery request', async () => {
    request.mockImplementation(async (prompt: string) => {
      const input = inputOf(prompt);
      return result(input, [clip(input, 'G1', 'G4')]);
    });
    const plan = await run();
    expect(request).toHaveBeenCalledTimes(1);
    expect(plan.clips[0].status).toBe('ready');
    expect(group.end).toBe(100);
  });
});
