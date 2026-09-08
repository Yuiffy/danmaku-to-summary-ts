export {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { bindActorArtifacts } = require('./actor_artifact_binding');

describe('actor review artifact binding', () => {
  let dir: string;
  let metadata: any;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-artifacts-'));
    const mediaPath = path.join(dir, 'clip.mp4'), srtPath = path.join(dir, 'clip.srt');
    fs.writeFileSync(mediaPath, 'video'); fs.writeFileSync(srtPath, 'speech');
    metadata = { attributionRequired: true, uploadReady: true, window: { start: 10, end: 20 },
      output: { mediaPath, srtPath }, attributionReview: { status: 'passed', start: 10, end: 20 } };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  test('hashes actual generated files and retains the source window', async () => {
    const result = await bindActorArtifacts(metadata);
    expect(result.attributionReview.artifactWindow).toEqual({ start: 10, end: 20 });
    expect(result.attributionReview.artifactDigests).toEqual({ video: crypto.createHash('sha256').update('video').digest('hex'),
      subtitles: crypto.createHash('sha256').update('speech').digest('hex') });
    expect(metadata.attributionReview.artifactDigests).toBeUndefined();
  });
  test('missing artifacts and changed windows fail closed', async () => {
    const changed = await bindActorArtifacts({ ...metadata, window: { start: 10, end: 21 } });
    expect(changed.uploadReady).toBe(false);
    expect(changed.publicCopyPending).toBe(true);
    fs.unlinkSync(metadata.output.mediaPath);
    expect((await bindActorArtifacts(metadata)).attributionReview.status).toBe('needs_review');
  });
  test('does not hash or promote unreviewed and legacy artifacts', async () => {
    const legacy = { ...metadata, attributionRequired: false, output: {} };
    expect(await bindActorArtifacts(legacy)).toBe(legacy);
    const pending = { ...metadata, attributionReview: { status: 'needs_review' }, output: {} };
    expect(await bindActorArtifacts(pending)).toBe(pending);
  });
});
