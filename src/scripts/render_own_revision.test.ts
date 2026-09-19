import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const topic = require('./topic_clipper');
const manual = require('./manual_clip_queue');
const { buildSubtitleEvidence } = require('./clipping/subtitle_evidence');
const { sourceSnapshot, fileDigest, approveRenderedClip } = require('./review_rendered_clip');
const { updateRevision, renderRevision } = require('./render_own_revision');

describe('own-stream subtitle revisions', () => {
  let directory, file, metadata, render, audit;
  const config = { ownStreamClips: { minClipSeconds: 35, maxClipSeconds: 210 } };
  const options = { candidateId: 7, reviewNote: 'Words and source checked' };
  const save = () => fs.writeFileSync(file, JSON.stringify(metadata));
  const load = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const correct = (extra = {}) => updateRevision(file, { ...options, action: 'correct', from: 'world', to: 'friend', ...extra }, config);

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'own-revision-'));
    file = path.join(directory, 'clip.json');
    const source = { mediaPath: path.join(directory, 'source.flv'), srtPath: path.join(directory, 'source.srt') };
    fs.writeFileSync(source.mediaPath, 'original recording');
    fs.writeFileSync(source.srtPath, '1\n00:00:01,000 --> 00:10:01,000\nHello world\n');
    const output = { metadataPath: file, mediaPath: path.join(directory, 'original.mp4'),
      srtPath: path.join(directory, 'original.srt'), coverPath: path.join(directory, 'original.jpg'), burnedSubtitles: true };
    fs.writeFileSync(output.mediaPath, 'original burned clip');
    fs.writeFileSync(output.srtPath, '1\n00:00:00,000 --> 00:01:00,000\nHello world\n');
    fs.writeFileSync(output.coverPath, 'original cover');
    const evidence = buildSubtitleEvidence(topic.parseTopicSrt(source.srtPath).segments);
    metadata = { mode: 'own_stream_fun_review', source, output, reviewIndex: 4, window: { index: 4, start: 1, end: 61, duration: 60 },
      copy: { title: '"Hello world"', description: 'Hello world', coverText: 'Hello world' }, uploadReady: true,
      streamerName: 'Host', recordedAt: '2026-09-09', streamTitle: 'Stream',
      grounding: { sourceSha256: evidence.sourceSha256, sourceKind: 'live_speech' },
      attributionRequired: true, attributionReview: { status: 'needs_review', sourceSha256: evidence.sourceSha256 },
      upload: { prefix: '[Host]', source: 'Host stream', tags: ['Host'], tid: 21 } };
    metadata.ownStreamHumanReview = { status: 'approved', note: 'Existing source review', sourceKind: 'live_speech', source: sourceSnapshot(metadata) };
    save();
    audit = jest.spyOn(require('child_process'), 'spawnSync').mockReturnValue({ status: 0, stdout: 'Audit passed' });
    render = jest.spyOn(manual, 'cutTask').mockImplementation(async task => {
      expect(task.mediaPath).toBe(source.mediaPath);
      expect(task.mediaPath).not.toBe(output.mediaPath);
      expect(task.approvedSubtitleSha256).toBe(fileDigest(task.approvedSubtitlePath));
      fs.mkdirSync(task.outputDir, { recursive: true });
      const rebuilt = { metadataPath: path.join(task.outputDir, 'clip.json'), mediaPath: path.join(task.outputDir, 'clip.mp4'),
        srtPath: path.join(task.outputDir, 'clip.srt'), coverPath: path.join(task.outputDir, 'cover.jpg'), burnedSubtitles: true };
      fs.writeFileSync(rebuilt.mediaPath, 'rebuilt video');
      fs.copyFileSync(task.approvedSubtitlePath, rebuilt.srtPath);
      fs.writeFileSync(rebuilt.coverPath, 'new cover');
      return { output: rebuilt };
    });
  });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

  test('literal corrections preserve old artifacts, cue times, ID and revision history', async () => {
    const before = fs.readFileSync(file, 'utf8');
    const result = await correct({ cue: 1 });
    expect(result).toMatchObject({ pendingRebuild: true, candidateRevision: 1 });
    expect(load()).toMatchObject({ uploadId: 7, reviewIndex: 4, uploadReady: false, rebuildRequired: true });
    expect(load().renderedSubtitles.cues[0]).toMatchObject({ start: 0, end: 60, text: 'Hello friend' });
    expect(fs.readFileSync(metadata.output.srtPath, 'utf8')).toContain('Hello world');
    expect(fs.readFileSync(metadata.output.mediaPath, 'utf8')).toBe('original burned clip');
    expect(load().copy.title).toBe('"Hello friend"');
    expect(load().renderedSubtitles.edits[0].authority).toBe('user');
    const history = path.join(directory, 'subtitle_revisions', '7', 'history');
    expect(fs.readdirSync(history).map(name => fs.readFileSync(path.join(history, name), 'utf8'))).toContain(before);
    render.mockClear();
    const retry = await correct({ cue: 1 });
    expect(retry.candidateRevision).toBe(1);
    expect(render).not.toHaveBeenCalled();
  });

  test('a held-before-render candidate can be explicitly reviewed and rendered under its original ID', async () => {
    metadata.preRenderHold = true; metadata.status = 'held_before_render';
    metadata.publicCopyPending = true; metadata.uploadReady = false;
    metadata.output.mediaPath = null; metadata.output.coverPath = null; metadata.output.burnedSubtitles = false;
    delete metadata.ownStreamHumanReview; save();
    await updateRevision(file, { ...options, action: 'prepare', sourceKind: 'live_speech' }, config);
    await renderRevision(file, options, config);
    expect(load().uploadId).toBe(7);
    expect(load().preRenderHold).toBeUndefined();
    expect(load().output.burnedSubtitles).toBe(true);
    expect(load().ownStreamHumanReview.status).toBe('approved');
    expect(render).toHaveBeenCalledTimes(1);
  });

  test('a held candidate cannot adopt a replaced source recording at first rebuild', async () => {
    metadata.preRenderHold = true; metadata.preRenderSource = sourceSnapshot(metadata);
    metadata.output.mediaPath = null; metadata.uploadReady = false;
    delete metadata.ownStreamHumanReview; save();
    fs.writeFileSync(metadata.source.mediaPath, 'replaced source recording');
    await expect(updateRevision(file, { ...options, action: 'prepare', sourceKind: 'live_speech' }, config))
      .rejects.toThrow('Original recording or sidecars changed');
    expect(render).not.toHaveBeenCalled();
  });

  test.each([{ from: 'absent' }, { cue: 2 }, { to: '' }, { to: '\ninvalid' }])('rejects invalid corrections without committing %o', async extra => {
    const before = fs.readFileSync(file, 'utf8');
    await expect(correct(extra)).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('subtitles reads the current revision without writing metadata', async () => {
    await correct();
    const before = fs.readFileSync(file, 'utf8');
    expect((await updateRevision(file, { ...options, action: 'draft' }, config)).cues[0].text).toBe('Hello friend');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('source, SRT and ID drift are rejected', async () => {
    await correct();
    await expect(updateRevision(file, { ...options, candidateId: 8, action: 'draft' }, config)).rejects.toThrow('ID');
    fs.appendFileSync(load().renderedSubtitles.path, 'tampered');
    await expect(updateRevision(file, { ...options, action: 'approve' }, config)).rejects.toThrow('outside the correction');
    fs.appendFileSync(metadata.source.srtPath, 'source drift');
    await expect(correct()).rejects.toThrow('source evidence changed');
  });

  test('does not adopt an out-of-band edit to an already reviewed SRT as the baseline', async () => {
    metadata.ownStreamHumanReview.digests = { subtitles: fileDigest(metadata.output.srtPath) };
    save();
    fs.appendFileSync(metadata.output.srtPath, '\n2\n00:00:59,000 --> 00:01:00,000\nUnapproved words\n');
    const before = fs.readFileSync(file, 'utf8');
    await expect(correct()).rejects.toThrow('changed since review');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('a new window is rebuilt from source subtitles before any corrections', async () => {
    metadata.ownStreamHumanReview.digests = { subtitles: fileDigest(metadata.output.srtPath) };
    save();
    await updateRevision(file, { ...options, action: 'prepare', start: 2, end: 70, sourceKind: 'live_speech' }, config);
    expect(load().window).toMatchObject({ start: 2, end: 70, duration: 68 });
    expect(load().renderedSubtitles.cues.at(-1).end).toBe(68);
    expect(fs.readFileSync(path.join(directory, 'original.srt'), 'utf8')).toContain('00:01:00,000');
  });

  test('cannot approve the old burned video after changing only subtitles', async () => {
    await correct();
    await expect(approveRenderedClip(file, { id: 7, reviewNote: 'Checked' }, config)).rejects.toThrow('must be rendered');
  });

  test('renders the exact approved revision from source and retries reuse successful media', async () => {
    const draft = await correct();
    await expect(renderRevision(file, { ...options, requireApproval: true, expectedSha256: draft.candidateSrtSha256 }, config)).rejects.toThrow('queued approval');
    expect(render).not.toHaveBeenCalled();
    await updateRevision(file, { ...options, action: 'approve' }, config);
    const result = await renderRevision(file, { ...options, requireApproval: true, expectedSha256: draft.candidateSrtSha256 }, config);
    expect(result.pendingRebuild).toBe(false);
    const saved = load();
    expect(saved.mode).toBe('own_stream_fun_review');
    expect(saved.output.metadataPath).toBe(file);
    expect(saved.output.mediaPath).not.toBe(metadata.output.mediaPath);
    expect(saved.ownStreamHumanReview.digests.subtitles).toBe(draft.candidateSrtSha256);
    expect(saved.ownStreamHumanReview.clipId).toBe(7);
    expect(saved.attributionReview.status).toBe('needs_review');
    expect(saved.grounding.subtitles[0].id).toBe('R1');
    expect(audit).toHaveBeenCalledWith('python', expect.arrayContaining(['--strict-warnings']), expect.anything());
    await renderRevision(file, { ...options, requireApproval: true, expectedSha256: draft.candidateSrtSha256 }, config);
    expect(render).toHaveBeenCalledTimes(1);
  });

  test('queued copy changes or a wrong subtitle hash cannot render', async () => {
    await correct();
    await updateRevision(file, { ...options, action: 'approve' }, config);
    await expect(renderRevision(file, { ...options, requireApproval: true, expectedSha256: 'wrong' }, config)).rejects.toThrow('queued approval');
    metadata = load(); metadata.copy.title = 'Changed after enqueue'; save();
    await expect(renderRevision(file, { ...options, requireApproval: true }, config)).rejects.toThrow('queued approval');
    expect(render).not.toHaveBeenCalled();
  });

  test('failed burning leaves the old artifact and current draft intact', async () => {
    await correct();
    const before = fs.readFileSync(file, 'utf8');
    render.mockRejectedValue(new Error('GPU and CPU fallback failed'));
    await expect(renderRevision(file, options, config)).rejects.toThrow('fallback failed');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('a failed media audit cannot publish a ready canonical record', async () => {
    await correct();
    const before = fs.readFileSync(file, 'utf8');
    audit.mockReturnValue({ status: 2, stdout: 'Video duration mismatch' });
    await expect(renderRevision(file, options, config)).rejects.toThrow('audit failed');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(load().rebuildRequired).toBe(true);
  });

  test('refuses a render whose SRT differs from the saved revision', async () => {
    await correct();
    const before = fs.readFileSync(file, 'utf8');
    render.mockImplementation(async () => ({ output: { ...metadata.output, burnedSubtitles: true } }));
    await expect(renderRevision(file, options, config)).rejects.toThrow('approved subtitle revision');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('preserves concurrent metadata changes instead of committing stale render results', async () => {
    await correct();
    const run = render.getMockImplementation();
    render.mockImplementation(async task => {
      const value = await run(task);
      const newer = load(); newer.userChange = true; fs.writeFileSync(file, JSON.stringify(newer));
      return value;
    });
    await expect(renderRevision(file, options, config)).rejects.toThrow('concurrently');
    expect(load().userChange).toBe(true);
    expect(load().rebuildRequired).toBe(true);
  });

  test('restores a long rejected clip only with explicit bound duration and copy review', async () => {
    metadata.window = { index: 4, start: 1, end: 601, duration: 600 };
    metadata.selectionRejection = { reason: 'duration_out_of_bounds', minClipSeconds: 35, maxClipSeconds: 210 };
    metadata.publicCopyPending = true; metadata.output.mediaPath = null;
    delete metadata.ownStreamHumanReview;
    save();
    const prepare = { ...options, action: 'prepare', sourceKind: 'live_speech' };
    await expect(updateRevision(file, prepare, config)).rejects.toThrow('--allow-long');
    await expect(updateRevision(file, { ...prepare, allowLong: true }, config)).rejects.toThrow('--duration-note');
    await expect(updateRevision(file, { ...prepare, allowLong: true, durationNote: 'Complete conversation', title: '"Invented quote"' }, config)).rejects.toThrow('source support');
    await updateRevision(file, { ...prepare, allowLong: true, durationNote: 'Complete conversation' }, config);
    expect(load()).toMatchObject({ uploadId: 7, rebuildRequired: true, publicCopyPending: false,
      durationApproval: { start: 1, end: 601, automaticMaxSeconds: 210, note: 'Complete conversation' } });
    expect(load().selectionRejection).toBeUndefined();
    expect(load().originalSelectionRejection.reason).toBe('duration_out_of_bounds');
    expect(render).not.toHaveBeenCalled();
  });

  test('an existing short burned clip can keep its window when correcting words', async () => {
    metadata.window = { index: 4, start: 1, end: 22, duration: 21 };
    fs.writeFileSync(metadata.output.srtPath, '1\n00:00:00,000 --> 00:00:21,000\nHello world\n');
    save();
    await correct();
    await updateRevision(file, { ...options, action: 'prepare', sourceKind: 'live_speech' }, config);
    expect(load().window.duration).toBe(21);
    expect(load().renderedSubtitles.cues[0].text).toBe('Hello friend');
    await expect(updateRevision(file, { ...options, action: 'prepare', start: 2, end: 20,
      sourceKind: 'live_speech' }, config)).rejects.toThrow('Invalid or out-of-source');
  });

  test('replanning a rejected window preserves its ID and history, then uses the normal render gates', async () => {
    metadata.selectionRejection = { reason: 'outside_candidate_context' };
    metadata.output.mediaPath = null; metadata.output.burnedSubtitles = false;
    delete metadata.ownStreamHumanReview; save();
    const registryPath = path.join(directory, 'registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({ clips: { 7: { metadataPath: file, reviewIndex: 4 } } }));
    const replan = { ...options, registryPath, action: 'prepare', replan: true, start: 2, end: 60,
      sourceKind: 'live_speech', title: 'Hello world', description: 'Hello world', coverText: 'Hello world' };
    const before = fs.readFileSync(file, 'utf8');
    await expect(updateRevision(file, { ...replan, start: 1, end: 61 }, config)).rejects.toThrow('new window');
    await expect(updateRevision(file, { ...replan, title: '"Invented quote"' }, config)).rejects.toThrow('source support');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    const draft = await updateRevision(file, replan, config);
    expect(load()).toMatchObject({ uploadId: 7, reviewIndex: 4, rebuildRequired: true,
      originalSelectionRejection: { reason: 'outside_candidate_context' },
      editorialReplan: { clipId: 7, start: 2, end: 60, originalWindow: { start: 1, end: 61 } } });
    expect(load().selectionRejection).toBeUndefined();
    await updateRevision(file, { ...options, registryPath, action: 'approve' }, config);
    await renderRevision(file, { ...options, registryPath, requireApproval: true,
      expectedSha256: draft.candidateSrtSha256 }, config);
    expect(load().output.burnedSubtitles).toBe(true);
    expect(load().uploadId).toBe(7);
    expect(load().originalSelectionRejection.reason).toBe('outside_candidate_context');
  });

  test('replanning refuses overlap with retained clips, including new overlap before queue approval', async () => {
    metadata.selectionRejection = { reason: 'overlap_after_alignment' }; save();
    const peerFile = path.join(directory, 'peer.json');
    const registryPath = path.join(directory, 'registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({ clips: {
      7: { metadataPath: file, reviewIndex: 4 },
      8: { metadataPath: peerFile, sourceMediaPath: metadata.source.mediaPath, status: 'uploaded' }
    } }));
    const peer = { source: metadata.source, window: { start: 50, end: 90 } };
    fs.writeFileSync(peerFile, JSON.stringify(peer));
    const replan = { ...options, registryPath, action: 'prepare', replan: true, start: 2, end: 60,
      sourceKind: 'live_speech', title: 'Hello world', description: 'Hello world', coverText: 'Hello world' };
    await expect(updateRevision(file, replan, config)).rejects.toThrow('overlaps retained clip 8');
    peer.window.start = 60;
    fs.writeFileSync(peerFile, JSON.stringify(peer));
    await updateRevision(file, replan, config);
    peer.window.start = 50;
    fs.writeFileSync(peerFile, JSON.stringify(peer));
    await expect(updateRevision(file, { ...options, registryPath, action: 'approve' }, config))
      .rejects.toThrow('overlaps retained clip 8');
    expect(render).not.toHaveBeenCalled();
  });

  test('replanning cannot recover other rejection types or silently reuse an old plan for a new window', async () => {
    metadata.selectionRejection = { reason: 'invalid_evidence' }; save();
    await expect(updateRevision(file, { ...options, action: 'prepare', replan: true,
      start: 2, end: 60, sourceKind: 'live_speech', title: 'Hello world',
      description: 'Hello world', coverText: 'Hello world' }, config)).rejects.toThrow('cannot be recovered');
    delete metadata.selectionRejection;
    metadata.originalSelectionRejection = { reason: 'outside_candidate_context' };
    metadata.editorialReplan = { clipId: 7, start: 2, end: 60, note: 'Earlier plan',
      sourceSha256: metadata.grounding.sourceSha256 };
    save();
    await expect(updateRevision(file, { ...options, action: 'approve' }, config)).rejects.toThrow('matching new editorial plan');
  });

  test('cannot use duration approval to bypass unrelated rejection or change corrected windows', async () => {
    metadata.selectionRejection = { reason: 'overlap' }; save();
    await expect(updateRevision(file, { ...options, action: 'prepare', allowLong: true, durationNote: 'Long', sourceKind: 'live_speech' }, config)).rejects.toThrow('new editorial plan');
    delete metadata.selectionRejection; save();
    await correct();
    await expect(updateRevision(file, { ...options, action: 'prepare', start: 2, end: 62, sourceKind: 'live_speech' }, config)).rejects.toThrow('before correcting');
  });

  test.each(['local_review', 'topic_candidate_manual_cut', 'manual_clip_queue'])('rebuilds rendered %s topics while preserving the original review, ID and source', async mode => {
    metadata.mode = mode; metadata.status = 'success'; metadata.uploadId = 7;
    delete metadata.reviewIndex; delete metadata.ownStreamHumanReview; delete metadata.attributionReview;
    metadata.window.index = 'E1-1';
    metadata.aiReview = { status: 'ready', sourceSha256: metadata.grounding.sourceSha256,
      window: { start: 1, end: 61 }, keyword: { status: 'confirmed' } };
    metadata.editorial = { copyWindow: { start: 1, end: 61 }, copyGrounding: { sourceSha256: metadata.grounding.sourceSha256,
      audience: [{ id: 'D12', time: 30, text: 'Hello world' }] } };
    delete metadata.grounding;
    const registryPath = path.join(directory, 'registry.json');
    const registry = { clips: { 7: { metadataPath: file, reviewIndex: 4, status: 'uploaded', uploadState: { bvid: 'BV_existing' } } } };
    fs.writeFileSync(registryPath, JSON.stringify(registry)); save();
    const initial = fs.readFileSync(file, 'utf8');
    const initialSource = fs.readFileSync(metadata.source.srtPath, 'utf8');
    const prepare = { ...options, registryPath, action: 'prepare', start: 0, end: 260,
      title: '弹幕 Hello world', description: 'Complete conversation', coverText: 'Hello', sourceKind: 'live_speech' };
    // Topic duration uses its own configured maximum, not the 210-second own-stream bound.
    await updateRevision(file, prepare, config);
    expect(load()).toMatchObject({ mode, uploadId: 7, reviewIndex: 4, rebuildRequired: true, uploadReady: false,
      window: { start: 0, end: 260 }, aiReview: metadata.aiReview, editorial: metadata.editorial,
      copy: { title: '弹幕 Hello world', description: 'Complete conversation' } });
    await expect(approveRenderedClip(file, { id: 7, reviewNote: 'Checked' }, config)).rejects.toThrow('must be rendered');
    await renderRevision(file, { ...options, registryPath }, config);
    const saved = load();
    expect(saved).toMatchObject({ mode, uploadId: 7, reviewIndex: 4, rebuildRequired: false,
      ownStreamHumanReview: { clipId: 7, artifactWindow: { start: 0, end: 260 } },
      aiReview: metadata.aiReview, editorial: metadata.editorial });
    expect(saved.copy.description).toBe('Complete conversation');
    expect(saved.grounding.audience).toEqual([{ id: 'D12', time: 30, text: 'Hello world' }]);
    expect(saved.renderedSubtitles.sourceSnapshot).toEqual(sourceSnapshot(metadata));
    expect(render.mock.calls[0][0]).toMatchObject({ start: 0, end: 260, mediaPath: metadata.source.mediaPath });
    expect(fs.readFileSync(metadata.source.srtPath, 'utf8')).toBe(initialSource);
    expect(fs.readFileSync(metadata.output.mediaPath, 'utf8')).toBe('original burned clip');
    expect(JSON.parse(fs.readFileSync(registryPath, 'utf8'))).toEqual(registry);
    const history = path.join(directory, 'subtitle_revisions', '7', 'history');
    expect(fs.readdirSync(history).map(name => fs.readFileSync(path.join(history, name), 'utf8'))).toContain(initial);
  });

  test('legacy manual cuts bind matching source subtitles on rebuild and reject subsequent source drift', async () => {
    metadata.mode = 'manual_clip_queue'; metadata.status = 'success';
    delete metadata.grounding; delete metadata.attributionReview; delete metadata.ownStreamHumanReview;
    save();
    const initial = fs.readFileSync(file, 'utf8');
    await expect(correct()).rejects.toThrow('explicit source review');
    expect(fs.readFileSync(file, 'utf8')).toBe(initial);
    await updateRevision(file, { ...options, action: 'prepare', start: 2, end: 50, sourceKind: 'live_speech' }, config);
    expect(load().manualRevisionSource.snapshot).toEqual(sourceSnapshot(metadata));
    expect(load().renderedSubtitles.cues.map(cue => cue.text)).toEqual(['Hello world']);
    await renderRevision(file, options, config);
    expect(load()).toMatchObject({ mode: 'manual_clip_queue', uploadId: 7, rebuildRequired: false });
    expect(fs.readFileSync(metadata.output.srtPath, 'utf8')).toContain('Hello world');
    fs.appendFileSync(metadata.source.srtPath, ' changed');
    await expect(updateRevision(file, { ...options, action: 'draft' }, config)).rejects.toThrow('source evidence changed');
  });

  test('legacy manual source adoption rejects a mismatch against the saved clip', async () => {
    metadata.mode = 'manual_clip_queue'; metadata.status = 'success';
    delete metadata.grounding; delete metadata.attributionReview; delete metadata.ownStreamHumanReview;
    save();
    const initial = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(metadata.source.srtPath, '1\n00:00:01,000 --> 00:10:01,000\nChanged words\n');
    await expect(updateRevision(file, { ...options, action: 'prepare', sourceKind: 'live_speech' }, config)).rejects.toThrow('no longer match');
    expect(fs.readFileSync(file, 'utf8')).toBe(initial);
    expect(render).not.toHaveBeenCalled();
  });

  test('topic review rejects source drift and cannot inherit old keyword approval for new copy', async () => {
    metadata.mode = 'local_review'; metadata.status = 'success';
    metadata.aiReview = { status: 'ready', sourceSha256: metadata.grounding.sourceSha256 };
    delete metadata.grounding; delete metadata.attributionReview; delete metadata.ownStreamHumanReview;
    save();
    const before = fs.readFileSync(file, 'utf8');
    const prepare = { ...options, action: 'prepare', start: 0, end: 70, sourceKind: 'live_speech' };
    await expect(updateRevision(file, { ...prepare, title: '"Unsupported new topic"' }, config)).rejects.toThrow('source support');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    fs.appendFileSync(metadata.source.srtPath, ' changed');
    await expect(updateRevision(file, prepare, config)).rejects.toThrow('source evidence changed');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('pending topics and registry index mismatches cannot enter the rendered revision path', async () => {
    metadata.mode = 'local_review'; metadata.status = 'pending_preflight'; save();
    await expect(updateRevision(file, { ...options, action: 'prepare' }, config)).rejects.toThrow('Unrendered keyword');
    metadata.status = 'success'; save();
    const registryPath = path.join(directory, 'registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({ clips: { 7: { metadataPath: file, reviewIndex: 5 } } }));
    await expect(updateRevision(file, { ...options, registryPath, action: 'prepare' }, config)).rejects.toThrow('review index');
  });

  test('explicitly added source XML is hash-bound and cannot be swapped or changed after preparation', async () => {
    metadata.mode = 'local_review'; metadata.status = 'success'; save();
    const xml = path.join(directory, 'source.xml');
    fs.writeFileSync(xml, '<i><d p="30,1,25,16777215,0,0,0,0">Hello audience</d></i>');
    await updateRevision(file, { ...options, action: 'prepare', xml, sourceKind: 'audience',
      title: '弹幕 Hello', description: 'The host reads audience chat' }, config);
    expect(load().source.xmlPath).toBe(xml);
    expect(load().renderedSubtitles.sourceSnapshot.xmlSha256).toBe(fileDigest(xml));
    expect(load().grounding.audience).toEqual([{ id: 'D1', time: 30, text: 'Hello audience' }]);
    const before = fs.readFileSync(file, 'utf8');
    await expect(updateRevision(file, { ...options, action: 'prepare', xml: path.join(directory, 'another.xml') }, config))
      .rejects.toThrow('Cannot replace');
    fs.appendFileSync(xml, '\n');
    await expect(renderRevision(file, options, config)).rejects.toThrow('sidecars changed');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(render).not.toHaveBeenCalled();
  });
});
