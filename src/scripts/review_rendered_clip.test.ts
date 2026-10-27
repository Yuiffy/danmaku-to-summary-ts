import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const topic = require('./topic_clipper');
const { buildSubtitleEvidence } = require('./clipping/subtitle_evidence');
const { approveRenderedClip, fileDigest } = require('./review_rendered_clip');
const { publicDescription } = require('./clipping/rendered_revision_evidence');
const { buildClipDescription } = require('./own_stream_clipper');

describe('human review of rendered own-stream clips', () => {
  let directory, metadataPath, metadata, cover;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rendered-human-review-'));
    const source = { mediaPath: path.join(directory, 'source.flv'), srtPath: path.join(directory, 'source.srt') };
    fs.writeFileSync(source.mediaPath, 'original');
    fs.writeFileSync(source.srtPath, '1\n00:00:01,000 --> 00:00:10,000\nHost said hello.\n');
    const output = { mediaPath: path.join(directory, 'clip.mp4'), srtPath: path.join(directory, 'clip.srt'), burnedSubtitles: true };
    fs.writeFileSync(output.mediaPath, 'rendered');
    fs.writeFileSync(output.srtPath, '1\n00:00:00,000 --> 00:00:09,000\nHost said hello.\n');
    const copy = { title: 'Host said hello', description: 'Host said hello.', coverText: 'Host said\nhello' };
    metadataPath = path.join(directory, 'clip.json');
    const evidence = buildSubtitleEvidence(topic.parseTopicSrt(source.srtPath).segments);
    metadata = { mode: 'own_stream_fun_review', source, output, copy, roomId: '1', streamerName: 'Host',
      window: { index: 5, start: 1, end: 10, duration: 9 }, uploadReady: false, publicCopyPending: true,
      attributionRequired: true, attributionReview: { status: 'needs_review', issues: ['actor_review_unavailable'],
        sourceSha256: evidence.sourceSha256, originalCopy: copy }, grounding: { sourceSha256: evidence.sourceSha256, sourceKind: 'live_speech' } };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    cover = jest.spyOn(topic, 'generateClipCover').mockImplementation(async (_video, _copy, dir) => {
      const result = path.join(dir, 'cover.jpg'); fs.writeFileSync(result, 'cover'); return result;
    });
  });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

  test('approves an own-stream speaker SRT using the exact evidence serialization saved during selection', async () => {
    const asr = require('./asr/asr_backends'), sidecar = require('./asr/evidence_sidecar');
    metadata.source.srtPath = path.join(directory, 'source.speaker.srt');
    const content = '1\n00:00:01,000 --> 00:00:10,000\n[UNKNOWN] Host said hello.\n';
    fs.writeFileSync(metadata.source.srtPath, content);
    sidecar.writeAsrEvidence(metadata.source.srtPath, content, [{ start: 1, end: 10, text: '[UNKNOWN] Host said hello.',
      asr: { recognizedText: 'Host said hello.' }, speaker: { version: 1, status: 'unknown', observations: [] } }], 'fixture');
    const parsed = asr.parseSrt(metadata.source.srtPath);
    const hash = buildSubtitleEvidence(sidecar.loadAsrEvidence(metadata.source.srtPath, parsed.segments).segments).sourceSha256;
    metadata.grounding.sourceSha256 = hash; metadata.attributionReview.sourceSha256 = hash;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    await approveRenderedClip(metadataPath, { id: 88, reviewNote: '投', feedbackAuthorized: true }, {});
    expect(JSON.parse(fs.readFileSync(metadataPath, 'utf8')).grounding.sourceSha256).toBe(hash);
    expect(cover).toHaveBeenCalledTimes(1);
    metadata.publicationKind = 'keyword_topic';
    metadata.aiReview = { sourceSha256: hash };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    await expect(approveRenderedClip(metadataPath, { id: 88, reviewNote: '投', feedbackAuthorized: true }, {}))
      .rejects.toThrow('Original subtitle evidence changed');
    expect(cover).toHaveBeenCalledTimes(1);
  });

  test('saves an explicit bound human review but never upload authorization', async () => {
    const result = await approveRenderedClip(metadataPath, { id: 88, reviewNote: 'Watched and checked the source' }, {});
    expect(result.uploadAuthorized).toBe(false);
    const saved = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    expect(saved.publicCopyPending).toBe(false);
    expect(saved.uploadReady).toBe(true);
    expect(saved.attributionReview.status).toBe('needs_review');
    expect(saved.ownStreamHumanReview.authority).toBe('human');
    expect(saved.ownStreamHumanReview.digests.video).toBe(fileDigest(metadata.output.mediaPath));
    expect(saved.ownStreamHumanReview.digests.subtitles).toBe(fileDigest(metadata.output.srtPath));
  });
  test('passes the saved manual frame and crop through a later human review', async () => {
    metadata.coverSelection = { time: 3.2, part: 1, text: metadata.copy.coverText,
      crop: { x: .1, y: .1, width: .8, height: .8 }, mediaIdentity: { path: metadata.output.mediaPath } };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    await approveRenderedClip(metadataPath, { id: 88, reviewNote: '核对封面与成片' }, {});
    expect(cover.mock.calls[0][3].manualSelection).toEqual(metadata.coverSelection);
    expect(JSON.parse(fs.readFileSync(metadataPath, 'utf8')).coverSelection).toEqual(metadata.coverSelection);
  });

  test('reviews the editorial text separately from generated recording, timing, and emotion numbers', async () => {
    metadata.streamTitle = 'Stream'; metadata.recordedAt = '2026-10-12 20:03:05';
    metadata.candidate = { emotionEvidence: [{ start: 1, end: 7, emotion: 'HAPPY' }, { start: 7, end: 10, emotion: 'ANGRY' }] };
    metadata.copy.description = buildClipDescription({ ...metadata, ...metadata.window, description: 'Host said hello.', emotionEvidence: metadata.candidate.emotionEvidence });
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    expect(publicDescription(metadata, metadata.copy.description)).toBe('Host said hello.');
    await approveRenderedClip(metadataPath, { id: 88, reviewNote: '核对无误', description: metadata.copy.description }, {});
    const saved = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    expect(saved.ownStreamHumanReview.status).toBe('approved');
    expect(saved.copy.description).toBe(metadata.copy.description);
  });

  test('keeps unsupported numbers in the actual editorial body subject to grounding', async () => {
    metadata.streamTitle = 'Stream'; metadata.recordedAt = '2026-10-12 20:03:05';
    metadata.candidate = { emotionEvidence: [{ start: 1, end: 10, emotion: 'HAPPY' }] };
    metadata.copy.description = buildClipDescription({ ...metadata, ...metadata.window, description: 'Host said hello 98765 times.', emotionEvidence: metadata.candidate.emotionEvidence });
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    expect(publicDescription(metadata, metadata.copy.description)).toBe('Host said hello 98765 times.');
    await expect(approveRenderedClip(metadataPath, { id: 88, reviewNote: '核对无误', description: metadata.copy.description }, {})).rejects.toThrow('unsupported_number');
    expect(cover).not.toHaveBeenCalled();
  });

  test('records explicit feedback publication acceptance without requiring old editorial issues to pass', async () => {
    metadata.copy.description = 'Host said hello 98765 times.';
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    await approveRenderedClip(metadataPath, { id: 88, reviewNote: '按反馈修改后直接投稿，不要求再次AI审核', feedbackAuthorized: true }, {});
    const saved = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    expect(saved.ownStreamHumanReview).toMatchObject({ authority: 'human', acceptanceMode: 'feedback', audioVisualReviewed: false });
    expect(saved.grounding.issues).toEqual(expect.arrayContaining([expect.stringContaining('unsupported_number')]));
    expect(saved.attributionReview.status).toBe('needs_review');
    expect(saved.uploadReady).toBe(true);
  });

  test('updates a highlight-first title while retaining the composed media and subtitle timeline', async () => {
    metadata.mode = 'local_review';
    metadata.window.duration = 12.2;
    metadata.editorialStyle = { selected: 'highlight_first', status: 'completed' };
    metadata.editorialTimeline = { duration: 12.2, pieces: [
      { kind: 'op', start: 0, end: 3.2, outputStart: 0 },
      { kind: 'body', start: 0, end: 9, outputStart: 3.2 }
    ] };
    fs.writeFileSync(metadata.output.srtPath, '1\n00:00:03,200 --> 00:00:12,200\nHost said hello.\n');
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    const before = { video: fileDigest(metadata.output.mediaPath), subtitles: fileDigest(metadata.output.srtPath) };
    await approveRenderedClip(metadataPath, { id: 88, reviewNote: '投', title: '用户选择的新标题', feedbackAuthorized: true }, {});
    const saved = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    expect(saved.copy.title).toBe('用户选择的新标题');
    expect(saved.window).toEqual(metadata.window);
    expect(saved.editorialTimeline).toEqual(metadata.editorialTimeline);
    expect(saved.ownStreamHumanReview.digests).toMatchObject(before);
    expect(saved.ownStreamHumanReview).toMatchObject({ acceptanceMode: 'feedback', audioVisualReviewed: false });
    expect(cover).toHaveBeenCalledTimes(1);
  });

  test('accepts whitespace changes only in the metadata-bound generated description prefix', async () => {
    metadata.streamTitle = 'Stream'; metadata.recordedAt = '2026-10-12 20:03:05';
    metadata.candidate = { emotionEvidence: [{ start: 1, end: 10, emotion: 'HAPPY' }] };
    const prefix = buildClipDescription({ ...metadata, ...metadata.window, description: '', emotionEvidence: metadata.candidate.emotionEvidence });
    metadata.copy.description = `${prefix.replace(/\s/gu, '')}\r\n\r\nHost said hello.`;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    expect(publicDescription(metadata, metadata.copy.description)).toBe('Host said hello.');
    await approveRenderedClip(metadataPath, { id: 88, reviewNote: '核对无误', description: metadata.copy.description }, {});
    expect(JSON.parse(fs.readFileSync(metadataPath, 'utf8')).ownStreamHumanReview.status).toBe('approved');
  });

  test('keeps changed provenance and unsupported editorial numbers subject to grounding', async () => {
    metadata.streamTitle = 'Stream'; metadata.recordedAt = '2026-10-12 20:03:05';
    const prefix = buildClipDescription({ ...metadata, ...metadata.window, description: '' }).replace(/\s/gu, '');
    const alteredProvenance = `${prefix.replace('2026-10-12', '2099-10-12')}\n\nHost said hello.`;
    expect(publicDescription(metadata, alteredProvenance)).toBe(alteredProvenance);
    const unsupportedBody = `${prefix}\n\nHost said hello 98765 times.`;
    expect(publicDescription(metadata, unsupportedBody)).toBe('Host said hello 98765 times.');
    await expect(approveRenderedClip(metadataPath, { id: 88, reviewNote: '核对无误', description: unsupportedBody }, {})).rejects.toThrow('unsupported_number');
    expect(cover).not.toHaveBeenCalled();
  });

  test('does not accept unsupported copy even with a human note', async () => {
    await expect(approveRenderedClip(metadataPath, { id: 88, reviewNote: 'Checked', title: '"Invented quote"' }, {})).rejects.toThrow('source support');
    expect(cover).not.toHaveBeenCalled();
  });

  test('requires a note and refuses unrendered/rejected candidates', async () => {
    await expect(approveRenderedClip(metadataPath, { id: 88, reviewNote: '' }, {})).rejects.toThrow('review note');
    metadata.selectionRejection = { reason: 'duration_out_of_bounds' };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    await expect(approveRenderedClip(metadataPath, { id: 88, reviewNote: 'Checked' }, {})).rejects.toThrow('re-planned');
  });

  test('source drift and edits made during review invalidate approval', async () => {
    fs.appendFileSync(metadata.source.srtPath, 'Different words.');
    await expect(approveRenderedClip(metadataPath, { id: 88, reviewNote: 'Checked' }, {})).rejects.toThrow('evidence changed');
  });

  test('does not overwrite concurrent metadata edits', async () => {
    cover.mockImplementation(async (_video, _copy, dir) => {
      fs.writeFileSync(metadataPath, JSON.stringify({ ...metadata, userChange: true }));
      const file = path.join(dir, 'cover.jpg'); fs.writeFileSync(file, 'cover'); return file;
    });
    await expect(approveRenderedClip(metadataPath, { id: 88, reviewNote: 'Checked' }, {})).rejects.toThrow('changed during review');
    expect(JSON.parse(fs.readFileSync(metadataPath, 'utf8')).userChange).toBe(true);
  });
});
