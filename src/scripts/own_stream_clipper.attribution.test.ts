export {};
jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), spawnSync: jest.fn(() => ({ status: 0, stdout: '', stderr: '' })) }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const own = require('./own_stream_clipper');
const topic = require('./topic_clipper');
const asr = require('./asr/asr_backends');
const { buildSubtitleEvidence, linkClipEvidence } = require('./clipping/subtitle_evidence');
const { writeRecordingParticipants } = require('./asr/recording_roster');

describe('own-stream actor review workflow', () => {
  test.each([true, false])('review outcome %s reaches metadata and publication eligibility', async accepted => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-review-workflow-'));
    const mediaPath = path.join(dir, 'source.flv'), srtPath = path.join(dir, 'source.srt'), planPath = path.join(dir, 'input.json');
    const cut = jest.spyOn(topic, 'cutClipMedia').mockImplementation(async (_source, _window, _srt, media) => {
      fs.writeFileSync(media, 'rendered fixture');
      return { path: media, burnedSubtitles: true };
    });
    const cover = jest.spyOn(topic, 'generateClipCover').mockResolvedValue(null);
    const generate = jest.spyOn(require('./ai_text_generator'), 'generateTextWithDaiYu').mockImplementation(async () => ({
      text: JSON.stringify({ reviews: [{ clipId: 'c1', decision: accepted ? 'repair' : 'needs_review',
        copy: { title: 'GuestClip asked Mimi', coverText: 'Question\nAnswer', description: 'GuestClip recalled asking Mimi.' },
        claims: [{ fields: ['title', 'coverText', 'description'], action: 'asked', narrator: 'Guest', actor: 'Guest', target: 'Mimi',
          sourceKind: 'recount', identityBasis: 'voice', speakerCueIds: ['G1'], cueIds: ['G1'] }], evidenceDanmakuIds: [] }] }),
      meta: { model: 'fixture', attempts: [] }
    }));
    try {
      fs.writeFileSync(mediaPath, 'fixture');
      asr.writeSrt({ backend: 'fixture', segments: [{ start: 0, end: 10, text: 'I asked Mimi about it.',
        speakerEvidence: { version: 1, status: 'row_supported', label: 'Guest', observations: [
          { start: 0, end: 10, label: 'Guest', scope: 'row', row: { accepted: true, score: .7, margin: .15 } }
        ] } }] }, srtPath, { write_evidence: true });
      writeRecordingParticipants({ mediaPath, srtPath, roomId: '1', participantIds: ['guest'] });
      const evidence = buildSubtitleEvidence(asr.parseSrt(srtPath).segments);
      const clip = { start: 0, end: 10, duration: 10, boundaryFromEvidence: true, title: 'Host asked Mimi',
        description: 'Host asked Mimi.', coverText: 'Question\nAnswer' };
      fs.writeFileSync(planPath, JSON.stringify({ clips: [{ ...clip,
        grounding: linkClipEvidence({ ...clip, sourceKind: 'recount', evidenceCueIds: ['G1'] }, clip, evidence, []) }] }));
      const config = { ai: { text: { provider: 'daiYu', enabled: true }, streamerRegistry: {
        host: { displayName: 'Host', aiClipName: 'Host', roomIds: ['1'] }, guest: { displayName: 'Guest', aiClipName: 'GuestClip' }
      } }, ownStreamClips: { enabled: true, minClipSeconds: 1, clipConcurrency: 1,
        clipResourceAdaptive: { enabled: false }, notify: { enabled: false },
        attribution: { enabled: true, roomIds: ['1'], maxRequests: 1 }, ai: { enabled: true } } };
      const results = await own.generateOwnStreamClips({ config, context: { roomId: '1' }, mediaPath, srtPath, planPath, registerUpload: false });
      expect(require('child_process').spawnSync).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
      const metadata = JSON.parse(fs.readFileSync(results[0].output.metadataPath, 'utf8'));
      expect(metadata.attributionRequired).toBe(true);
      expect(metadata.attributionReview.status).toBe(accepted ? 'passed' : 'needs_review');
      expect(metadata.uploadReady).toBe(accepted);
      expect(metadata.publicCopyPending).toBe(!accepted);
      if (accepted) {
        expect(metadata.copy.title).toBe('GuestClip asked Mimi');
        const { copyDigest } = require('./clipping/actor_review');
        expect(metadata.attributionReview.artifactCopyDigest).toBe(copyDigest(metadata.copy));
        expect(metadata.attributionReview.artifactDigests.video).toMatch(/^[a-f0-9]{64}$/);
        expect(metadata.attributionReview.artifactWindow).toEqual({ start: 0, end: 10 });
      }
    } finally {
      cut.mockRestore(); cover.mockRestore(); generate.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
