import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const topic = require('./topic_clipper');
const { buildSubtitleEvidence } = require('./clipping/subtitle_evidence');
const { approveRenderedClip, fileDigest } = require('./review_rendered_clip');

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
