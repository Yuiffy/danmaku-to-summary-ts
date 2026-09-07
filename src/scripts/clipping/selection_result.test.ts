const fs = require('fs');
const os = require('os');
const path = require('path');
const own = require('../own_stream_clipper');
const asr = require('../asr/asr_backends');
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const { normalizeAiClips, isRerankResponseValid, reusableRecall } = require('./selection_result');
const generator = require('../ai_text_generator');

describe('selection result provenance', () => {
  test('a model-supplied reuse field cannot authorize missing boundaries', () => {
    const evidence = buildSubtitleEvidence([{ start: 0, end: 40, text: 'A recorded story.' }]);
    const rejected = [];
    const clips = normalizeAiClips([{ candidateIndex: 1, title: 'A title',
      reuse: { startCueId: 'G1', endCueId: 'G1', sourceKind: 'recount' } }],
      [{ index: 1, start: 0, end: 40 }], 40, { minClipSeconds: 1, maxClipSeconds: 60 },
      'host', evidence, [], new Set(['G1']), new Set(), rejected);
    expect(clips).toEqual([]);
    expect(rejected).toEqual([expect.objectContaining({ reason: 'missing_explicit_boundaries',
      candidateIndex: 1, recallReusable: false, requiredFields: ['startCueId', 'endCueId'] })]);
  });

  test('the real mixed-candidate prompt always shows the full format and candidate-local omission rules', async () => {
    const parsed = { segments: [{ start: 0, end: 40, text: 'First story.' }, { start: 60, end: 100, text: 'Second story.' }] };
    const evidence = buildSubtitleEvidence(parsed.segments);
    const candidates = [{ index: 1, start: 0, end: 40 }, { index: 2, start: 60, end: 100,
      startCueId: 'G2', endCueId: 'G2', grounding: { status: 'linked', sourceSha256: evidence.sourceSha256,
        subtitleIds: ['G2'], danmakuIds: [], sourceKind: 'recount' } }];
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({ text: '{"clips":[]}', meta: {} });
    try {
      await own.refineCandidatesWithAI(candidates, parsed, [], {}, own.getOwnStreamClipsConfig({}),
        { ai: { text: { provider: 'daiYu' } } });
      expect(generate).toHaveBeenCalledTimes(1);
      const prompt = generate.mock.calls[0][0];
      expect(prompt).toContain('reuse=null');
      expect(prompt).toContain('不能因为其他候选可复用而省略');
      expect(prompt).toContain('"candidateIndex":1,"startCueId":"G1","endCueId":"G20"');
      expect(prompt).not.toContain('"candidateIndex":1,"title":"人工风格标题');
      const rows = prompt.split('\n').filter(line => /^#[12] /.test(line));
      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows[0].slice(rows[0].indexOf('['))).at(-1)).toBeNull();
      expect(JSON.parse(rows[1].slice(rows[1].indexOf('['))).at(-1)).toMatchObject({ startCueId: 'G2', endCueId: 'G2' });
    } finally { generate.mockRestore(); }
  });

  test.each([
    { name: 'default', avoidOverlappingClips: undefined, finalOverlapToleranceSeconds: 0, constrained: true, gap: 0 },
    { name: 'positive gap', avoidOverlappingClips: true, finalOverlapToleranceSeconds: 2.5, constrained: true, gap: 2.5 },
    { name: 'overlap permitted', avoidOverlappingClips: false, finalOverlapToleranceSeconds: 8, constrained: false, gap: 0 },
    { name: 'negative gap', avoidOverlappingClips: true, finalOverlapToleranceSeconds: -8, constrained: true, gap: 0 },
  ])('rerank instructions match the final overlap policy: $name', async ({ constrained, gap, ...options }) => {
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({ text: '{"clips":[]}', meta: {} });
    try {
      const config = own.getOwnStreamClipsConfig({ ownStreamClips: options });
      await own.refineCandidatesWithAI([{ index: 1, start: 0, end: 40 }],
        { segments: [{ start: 0, end: 40, text: 'A complete story.' }] }, [], {}, config,
        { ai: { text: { provider: 'daiYu' } } });
      expect(generate).toHaveBeenCalledTimes(1);
      const prompt = generate.mock.calls[0][0];
      expect(prompt.includes('所有输出片段必须互不重叠')).toBe(constrained);
      expect(prompt.includes('相邻片段至少间隔')).toBe(gap > 0);
      if (gap > 0) expect(prompt).toContain(`相邻片段至少间隔 ${gap} 秒`);
    } finally { generate.mockRestore(); }
  });

  test('reuses only matching linked recall fields and respects explicit overrides', () => {
    const evidence = buildSubtitleEvidence([{ start: 0, end: 20, text: 'first fact' }, { start: 20, end: 40, text: 'second fact' }]);
    const config = { minClipSeconds: 10, maxClipSeconds: 60 };
    const base = { index: 1, start: 0, end: 40, startCueId: 'G1', endCueId: 'G2',
      grounding: { status: 'linked', sourceSha256: evidence.sourceSha256, subtitleIds: ['G1', 'G2'], danmakuIds: [], sourceKind: 'recount' } };
    const minimal = { candidateIndex: 1, title: 'A factual story', description: 'A recollection', score: 90 };
    const result = normalizeAiClips([minimal], [base], 40, config, 'host', evidence, [], new Set(['G1', 'G2']), new Set());
    expect(result[0]).toMatchObject({ start: 0, end: 40, boundaryFromEvidence: true,
      grounding: { status: 'linked', reusedRecall: true, subtitleIds: ['G1', 'G2'], sourceKind: 'recount' } });
    expect(isRerankResponseValid({ text: JSON.stringify({ clips: [minimal] }) }, [base], 40, config, evidence, [], new Set(['G1', 'G2']))).toBe(true);
    const overridden = normalizeAiClips([{ ...minimal, startCueId: 'G2', endCueId: 'G2', evidenceCueIds: ['G2'], sourceKind: 'live_speech' }],
      [base], 40, config, 'host', evidence, [], new Set(['G1', 'G2']));
    expect(overridden[0]).toMatchObject({ start: 20, end: 40, grounding: { subtitleIds: ['G2'], sourceKind: 'live_speech' } });
    expect(reusableRecall({ ...base, grounding: { ...base.grounding, sourceSha256: 'stale' } }, evidence, config)).toBeNull();
    expect(normalizeAiClips([minimal], [{ ...base, grounding: null }], 40, config, 'host', evidence)).toEqual([]);
    const withAudience = { ...base, grounding: { ...base.grounding, danmakuIds: ['D1'], audience: [{ id: 'D1', time: 5, text: 'original' }] } };
    expect(reusableRecall(withAudience, evidence, config, [{ time: 5, text: 'original' }])).not.toBeNull();
    expect(reusableRecall(withAudience, evidence, config, [{ time: 5, text: 'changed' }])).toBeNull();
    expect(reusableRecall({ ...base, start: 1 }, evidence, config)).toBeNull();
  });

  test('reports why a proposal is rejected instead of silently lowering the count', () => {
    const source = buildSubtitleEvidence([{ start: 5, end: 15, text: 'evidence' }]);
    const rejected = [];
    const clips = normalizeAiClips([
      { candidateIndex: 99, startCueId: 'G1', endCueId: 'G1', title: 'wrong candidate' },
      { candidateIndex: 1, startCueId: 'G404', endCueId: 'G1', title: 'wrong cue' },
      { candidateIndex: 1, startCueId: 'G1', endCueId: 'G1', title: 'valid' }
    ], [{ index: 1, start: 5, end: 15 }], 20, { minClipSeconds: 1, maxClipSeconds: 30 },
    'host', source, [], new Set(['G1']), new Set(), rejected);
    expect(clips).toHaveLength(1);
    expect(rejected.map(row => row.reason)).toEqual(['unknown_candidate', 'invalid_boundary_ids']);
    expect(rejected[0]).toMatchObject({ index: 1, candidateIndex: 99 });
  });

  test.each(['object', 'array'])('cache validation rejects cross-window selections and malformed public copy (%s)', shape => {
    const evidence = buildSubtitleEvidence([{ start: 0, end: 60, text: 'first' }, { start: 120, end: 180, text: 'second' }]);
    const candidates = [{ index: 1, start: 0, end: 60 }, { index: 2, start: 120, end: 180 }];
    const config = { minClipSeconds: 10, maxClipSeconds: 100 };
    const allowed = new Set(['G1', 'G2']);
    const clip = { candidateIndex: 1, startCueId: 'G2', endCueId: 'G2', title: 'Wrong window' };
    const validate = value => isRerankResponseValid({ text: JSON.stringify(shape === 'array' ? [value] : { clips: [value] }) },
      candidates, 180, config, evidence, [], allowed);
    expect(validate(clip)).toBe(false);
    expect(validate({ ...clip, candidateIndex: 2 })).toBe(true);
    expect(validate({ ...clip, candidateIndex: 2, description: { bad: 'object' } })).toBe(false);
    expect(validate({ ...clip, candidateIndex: 2, score: 'Infinity' })).toBe(false);
    const adjacent = [{ index: 1, start: 0, end: 120 }];
    expect(normalizeAiClips([clip], adjacent, 180, config, 'host', evidence, [], allowed)).toEqual([]);
  });

  test('does not substitute a different candidate or accept an unprovided boundary ID', () => {
    const evidence = buildSubtitleEvidence([{ start: 5, end: 15, text: 'evidence' }]);
    const candidates = [{ index: 1, start: 5, end: 15 }];
    const config = { minClipSeconds: 1, maxClipSeconds: 30 };
    const raw = { candidateIndex: 99, startCueId: 'G1', endCueId: 'G1', title: 'wrong candidate' };
    expect(normalizeAiClips([raw], candidates, 20, config, 'host', evidence)).toEqual([]);
    expect(normalizeAiClips([{ ...raw, candidateIndex: 1 }], candidates, 20, config, 'host', evidence, [], new Set())).toEqual([]);
  });

  test('plan-only replay rechecks source changes and citations against the final cut', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grounded-plan-replay-'));
    const mediaPath = path.join(directory, 'source.flv');
    const srtPath = path.join(directory, 'source.srt');
    const planPath = path.join(directory, 'input-plan.json');
    fs.writeFileSync(mediaPath, 'fixture');
    fs.writeFileSync(srtPath, '1\n00:00:05,000 --> 00:00:15,000\nA source fact.\n');
    const grounding = { version: 1, status: 'linked', subtitleIds: ['G1'], danmakuIds: [], sourceKind: 'live_speech',
      sourceSha256: 'old-source', issues: [] };
    const clip = { start: 5, end: 15, duration: 10, boundaryFromEvidence: true, title: 'A fact', grounding };
    const options = { mediaPath, srtPath, planPath, planOnly: true,
      config: { ownStreamClips: { enabled: true, minClipSeconds: 1, ai: { enabled: false }, notify: { enabled: false } } } };
    try {
      fs.writeFileSync(planPath, JSON.stringify({ clips: [clip] }));
      const changed = await own.generateOwnStreamClips(options);
      expect(changed[0].grounding.status).toBe('needs_review');
      expect(changed[0].grounding.issues).toContain('source_changed');
      const savedPlan = JSON.parse(fs.readFileSync(path.join(directory, 'own_stream_fun_clips', 'input-plan_ALIGNED.json'), 'utf8'));
      expect(savedPlan.config).toMatchObject({ subtitleEvidenceFormat: 'complete_grouped_v1', subtitleTruncation: false });
      expect(savedPlan.config).not.toHaveProperty('maxCandidateSubtitleChars');
      grounding.sourceSha256 = buildSubtitleEvidence(asr.parseSrt(srtPath).segments).sourceSha256;
      fs.writeFileSync(planPath, JSON.stringify({ clips: [{ ...clip, end: 14, duration: 9 }] }));
      const trimmed = await own.generateOwnStreamClips(options);
      expect(trimmed[0].grounding.issues).toContain('subtitle_outside_clip:G1');
      expect(trimmed[0].grounding.status).toBe('needs_review');
      const review = fs.readFileSync(path.join(directory, 'own_stream_fun_clips', 'REVIEW_input-plan.md'), 'utf8');
      expect(review).toContain('subtitle_outside_clip:G1');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
