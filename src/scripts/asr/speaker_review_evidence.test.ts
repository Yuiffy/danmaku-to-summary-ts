const fs = require('fs');
const os = require('os');
const path = require('path');
const asr = require('./asr_backends');
const { loadAsrEvidence } = require('./evidence_sidecar');
const { buildFullContextSource } = require('../full_live_context');

test('speaker review SRT retains hash-bound local rejections, identities and raw provenance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-review-evidence-'));
  try {
    const result = { backend: 'paraformer', segments: [
      { start: 0, end: 12, text: 'First statement with a rejected speaker', speaker: 'Host', speaker_score: 0.99,
        speakerEvidence: { version: 1, status: 'mixed', label: null, observations: [] } },
      { start: 12, end: 24, text: 'A correctly identified guest tells a different story', speaker: 'Guest', speaker_score: 0.9,
        speakerEvidence: { version: 1, status: 'row_supported', label: 'Guest', observations: [] } },
      { start: 24, end: 36, text: 'Low score name must remain rejected', speaker: 'Weak', speaker_score: 0.4,
        speakerEvidence: { version: 1, status: 'row_supported', label: 'Weak', observations: [] } }
    ] };
    const config = { ai: { comic: { multiReferenceImages: { minSpeechSeconds: 8, minSpeakerScore: 0.64 } },
      streamerRegistry: { host: { displayName: 'Host', roomIds: ['1'] }, guest: { displayName: 'Guest' }, weak: { displayName: 'Weak' } } } };
    const review = asr.writeSpeakerReviewSrt(result, path.join(dir, 'source.srt'), { max_chars_per_line: 12 }, config, { roomId: '1' });
    const evidence = loadAsrEvidence(review, asr.parseSrt(review).segments);
    expect(evidence.status).toBe('available');
    expect(evidence.segments.map((row: any) => row.speakerEvidence.status)).toEqual(['mixed', 'row_supported', 'unqualified']);
    expect(evidence.segments[1].asrEvidence.recognizedText).toBe(result.segments[1].text);
    const source = buildFullContextSource({ segments: evidence.segments }, [], { compactEvidence: true });
    expect(source.evidence.speech.map((row: any) => row.speaker)).toEqual(['UNKNOWN', 'Guest', 'UNKNOWN']);
    fs.appendFileSync(review, '\nchanged');
    expect(loadAsrEvidence(review, asr.parseSrt(review).segments).status).toBe('stale');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
