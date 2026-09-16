const selection = require('./own_selection');
const own = require('../own_stream_clipper');
const generator = require('../ai_text_generator');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('own-stream recall preservation', () => {
  test('new plan-only runs keep grounded viewing angles and every pre-ranking proposal without media or upload', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viewing-angle-plan-'));
    const mediaPath = path.join(directory, 'source.flv'), srtPath = path.join(directory, 'source.srt');
    fs.writeFileSync(mediaPath, 'fixture');
    fs.writeFileSync(srtPath, '1\n00:00:01,000 --> 00:00:10,000\n你怎么在这里，找到你了\n\n2\n00:00:20,000 --> 00:00:30,000\n天气真好\n');
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async prompt => ({
      text: JSON.stringify({ clips: String(prompt).includes('完整候选池') ? [{ candidateIndex: 1,
        startCueId: 'G1', endCueId: 'G1', title: '终于找到你了', description: '找到你了', coverText: '你怎么在这里\n终于找到你了',
        evidenceCueIds: ['G1'], sourceKind: 'live_speech', score: 90 }] : [
          { startCueId: 'G1', endCueId: 'G1', evidenceCueIds: ['G1'], sourceKind: 'live_speech', event: '寻找后相遇', score: 90,
            viewingAngles: [{ label: '角色互动', hook: '找到对方后的招呼', evidenceCueIds: ['G1'], evidenceDanmakuIds: [] }] },
          { startCueId: 'G2', endCueId: 'G2', evidenceCueIds: ['G2'], sourceKind: 'live_speech', event: '平静聊天', score: 50,
            viewingAngles: [{ label: '编造标签', hook: '不存在的事件', evidenceCueIds: ['G99'] }] }
        ] }), meta: { model: 'fixture' }
    }));
    const cut = jest.spyOn(require('../topic_clipper'), 'cutClipMedia');
    const register = jest.spyOn(require('child_process'), 'spawnSync');
    try {
      await own.generateOwnStreamClips({ mediaPath, srtPath, totalDurationSeconds: 35, planOnly: true,
        config: { ai: { text: { provider: 'daiYu' } }, ownStreamClips: { enabled: true,
          ai: { enabled: true, strategy: 'staged', maxCandidateLines: 1, recallMaxClipsPerChunk: 12 }, notify: { enabled: false } } } });
      const plan = JSON.parse(fs.readFileSync(path.join(directory, 'own_stream_fun_clips', 'PLAN.json'), 'utf8'));
      expect(plan.config).toMatchObject({ viewingAnglesVersion: 1, recallMaxClipsPerChunk: 12 });
      expect(plan.aiStatus.recallChunks[0]).toMatchObject({ proposed: 2, atLimit: false, limit: 12 });
      expect(plan.aiStatus.recallPool.candidates).toHaveLength(2);
      expect(plan.aiStatus.recallPool.candidates[1]).toMatchObject({ disposition: 'candidate_pool_limit', viewingAngles: [],
        viewingAngleIssues: ['invalid_viewing_angle:1'] });
      expect(plan.clips[0].viewingAngles[0]).toMatchObject({ label: '角色互动', evidenceCueIds: ['G1'] });
      expect(cut).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
    } finally { generate.mockRestore(); cut.mockRestore(); register.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test.each([[1, false], [2, false], [1, true]])('rerank failure keeps unfinished copy out of publishable artifacts (workers=%s, localOnly=%s)', async (clipConcurrency, localOnly) => {
    const register = jest.spyOn(require('child_process'), 'spawnSync').mockReturnValue({ status: 0, stdout: '', stderr: '' });
    let own, topic;
    jest.isolateModules(() => {
      own = require('../own_stream_clipper');
      topic = require('../topic_clipper');
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-public-copy-'));
    const mediaPath = path.join(directory, 'source.flv');
    const srtPath = path.join(directory, 'source.srt');
    fs.writeFileSync(mediaPath, 'fixture');
    fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:01:00,000\nA complete recorded incident.\n');
    const event = 'She recounts the entire incident, including its setup and every reaction.';
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async prompt => {
      if (String(prompt).includes('完整候选池')) throw new Error('rerank unavailable');
      return { text: JSON.stringify({ clips: localOnly ? [] : [{ startCueId: 'G1', endCueId: 'G1', evidenceCueIds: ['G1'],
        sourceKind: 'recount', event, score: 90,
        ...(clipConcurrency === 2 ? { title: event, coverText: 'Internal\nsummary', description: event } : {})
      }] }), meta: { model: 'fixture' } };
    });
    const cut = jest.spyOn(topic, 'cutClipMedia').mockImplementation(async (_source, _window, _srt, output) => {
      fs.writeFileSync(output, 'rendered fixture');
      return { path: output, burnedSubtitles: true };
    });
    const cover = jest.spyOn(topic, 'generateClipCover').mockResolvedValue(null);
    try {
      const results = await own.generateOwnStreamClips({ mediaPath, srtPath, totalDurationSeconds: 60,
        config: { ai: { text: { provider: 'daiYu' } }, ownStreamClips: { enabled: true, clipConcurrency,
          ...(localOnly ? { subtitleKeywords: ['incident'] } : {}),
          clipResourceAdaptive: { enabled: false }, ai: { enabled: true, strategy: 'staged' }, notify: { enabled: false } } } });
      expect(results).toHaveLength(1);
      const result = results[0];
      if (localOnly) expect(result.candidate.recallSources).toEqual(['local_signals']);
      else expect(result.candidate).toMatchObject({ event, title: '', publicCopyPending: true });
      expect(result).toMatchObject({ publicCopyPending: true, uploadReady: false });
      expect(result.copy.title).not.toBe(event);
      expect(result.copy.description).not.toContain(event);
      expect(cover).not.toHaveBeenCalled();
      const saved = JSON.parse(fs.readFileSync(result.output.metadataPath, 'utf8'));
      expect(saved.publicCopyPending).toBe(true);
      const root = path.dirname(result.output.metadataPath);
      expect(fs.readFileSync(path.join(root, 'REVIEW.md'), 'utf8')).toContain('发布文案待生成，禁止上传');
      expect(own.buildNotifyMarkdown(results, {})).toContain('发布文案待生成');
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'UPLOAD_MANIFEST.json'), 'utf8'));
      expect(manifest.clips).toHaveLength(1);
      expect(manifest.clips[0].metadataPath).toBe(result.output.metadataPath);
      expect(register).toHaveBeenCalledTimes(1);
      expect(register.mock.calls[0][1]).toContain('--include-pending');
      expect(register.mock.calls[0][1]).not.toContain('enqueue');
      expect(generate).toHaveBeenCalledTimes(2);
    } finally {
      generate.mockRestore(); cut.mockRestore(); cover.mockRestore(); register.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([60, 62, 72])('retains independent non-overlapping events beginning at %s', start => {
    const clips = [{ start: 0, end: 60, score: 90, event: 'First incident' },
      { start, end: start + 60, score: 95, event: 'A different incident' }];
    expect(selection.dedupePlannedClips(clips, { maxClips: 50 })).toEqual(clips);
  });

  test('keeps slightly overlapping alternatives for the global editor to resolve', () => {
    const clips = [{ start: 0, end: 60, score: 90 }, { start: 55, end: 115, score: 80 }];
    expect(selection.dedupePlannedClips(clips, { maxClips: 50 })).toEqual(clips);
  });

  test('still deduplicates substantially overlapping proposals and honors the candidate cap', () => {
    const first = { start: 0, end: 60, score: 90 };
    const duplicate = { start: 2, end: 62, score: 95 };
    const next = { start: 65, end: 125, score: 80 };
    const later = { start: 140, end: 200, score: 70 };
    expect(selection.dedupePlannedClips([later, next, first, duplicate], { maxClips: 2 }))
      .toEqual([duplicate, next]);
  });

  test('both adjacent events reach the global editor and warm replay makes no additional requests', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adjacent-recall-'));
    const proposals = [1, 2].map(index => ({ startCueId: `G${index}`, endCueId: `G${index}`,
      evidenceCueIds: [`G${index}`], sourceKind: 'recount', event: `Incident ${index}`, score: 91 - index }));
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async prompt => ({
      text: JSON.stringify({ clips: String(prompt).includes('完整候选池')
        ? proposals.map((clip, index) => ({ ...clip, candidateIndex: index + 1, title: clip.event, description: clip.event }))
        : proposals }), meta: { model: 'fixture' }
    }));
    const config = own.getOwnStreamClipsConfig({ ownStreamClips: { chunkSeconds: 600 } });
    const parsed = { segments: [{ start: 0, end: 60, text: 'First incident' }, { start: 62, end: 122, text: 'Second incident' }] };
    const info = { streamTitle: 'Fixture', selectionCacheDirectory: directory };
    try {
      const run = () => own.planClipsWithStagedAI([], parsed, [], info, 122, config, { ai: { text: { provider: 'daiYu' } } });
      const first = await run();
      expect(first.modelCandidates).toHaveLength(2);
      expect(first.clips).toHaveLength(2);
      expect(generate).toHaveBeenCalledTimes(2);
      expect((await run()).clips).toEqual(first.clips);
      expect(generate).toHaveBeenCalledTimes(2);
    } finally { generate.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test('never requests a model for a block with no supplied evidence', async () => {
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({ text: '{"clips":[]}', meta: {} });
    const config = own.getOwnStreamClipsConfig({ ownStreamClips: { chunkSeconds: 600 } });
    const diagnostics = { errors: [] };
    try {
      const result = await own.planClipsWithAIChunks({ segments: [] }, [],
        { streamTitle: 'Metadata must not substitute for source facts' }, 1800, config,
        { ai: { text: { provider: 'daiYu' } } }, diagnostics);
      expect(result).toEqual([]);
      expect(generate).not.toHaveBeenCalled();
      expect(diagnostics.errors).toEqual([]);
      expect(diagnostics['skippedChunks']).toEqual([1, 2, 3].map(index => ({ index,
        start: (index - 1) * 600, end: index * 600, reason: 'no_evidence' })));
    } finally { generate.mockRestore(); }
  });

  test('persists skipped chunks in PLAN without marking them as requests or failures', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-chunk-plan-'));
    const mediaPath = path.join(directory, 'source.flv');
    const srtPath = path.join(directory, 'source.srt');
    fs.writeFileSync(mediaPath, 'fixture');
    fs.writeFileSync(srtPath, '1\n00:10:50,000 --> 00:11:50,000\nRecorded incident.\n');
    const clip = { startCueId: 'G1', endCueId: 'G1', evidenceCueIds: ['G1'],
      sourceKind: 'recount', score: 90, event: 'Recorded incident' };
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async prompt => ({
      text: JSON.stringify({ clips: [String(prompt).includes('完整候选池')
        ? { ...clip, candidateIndex: 1, title: 'Recorded incident', description: 'A recorded recollection.' }
        : clip] }), meta: { model: 'fixture' }
    }));
    try {
      await own.generateOwnStreamClips({ mediaPath, srtPath, totalDurationSeconds: 1800, planOnly: true,
        config: { ai: { text: { provider: 'daiYu' } }, ownStreamClips: { enabled: true,
          chunkSeconds: 600, ai: { enabled: true, strategy: 'staged' }, notify: { enabled: false } } } });
      const plan = JSON.parse(fs.readFileSync(path.join(directory, 'own_stream_fun_clips', 'PLAN.json'), 'utf8'));
      expect(plan.aiStatus.skippedChunks.map(row => row.index)).toEqual([1, 3]);
      expect(plan.config).toMatchObject({ minClipSeconds: 35, maxClipSeconds: 210, aiDurationPolicy: 'content_complete' });
      expect(plan.aiStatus.requests).toHaveLength(2);
      expect(plan.aiStatus.errorCount).toBe(0);
      expect(plan.aiStatus.usedFallback).toBe(false);
      expect(generate).toHaveBeenCalledTimes(2);
    } finally { generate.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test.each(['speech', 'audience', 'emotion'])('does not skip an otherwise empty block with %s evidence', async kind => {
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({ text: '{"clips":[]}', meta: {} });
    const config = own.getOwnStreamClipsConfig({ ownStreamClips: { chunkSeconds: 600, reactionKeywords: ['reaction'] } });
    const parsed = { segments: kind === 'speech' ? [{ start: 650, end: 700, text: 'Recorded speech' }] : [] };
    const comments = kind === 'audience' ? [{ time: 650, text: 'reaction without speech' }] : [];
    const emotion = kind === 'emotion' ? { status: 'completed',
      timeline: [{ start: 650, end: 652, emotion: 'HAPPY', events: ['Laughter'] }] } : null;
    const diagnostics = { errors: [] };
    try {
      await own.planClipsWithAIChunks(parsed, comments, { streamTitle: 'Fixture' }, 1800, config,
        { ai: { text: { provider: 'daiYu' } } }, diagnostics, emotion);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(diagnostics['skippedChunks'].map(row => row.index)).toEqual([1, 3]);
      expect(generate.mock.calls[0][0]).toContain('00:10:00-00:20:00');
      const content = { speech: 'Recorded speech', audience: 'reaction without speech', emotion: 'Laughter' }[kind];
      expect(generate.mock.calls[0][0]).toContain(content);
    } finally { generate.mockRestore(); }
  });
});
