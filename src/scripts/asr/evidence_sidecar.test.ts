export {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const asr = require('./asr_backends');
const { evidencePath, loadAsrEvidence } = require('./evidence_sidecar');

describe('ASR replacement provenance', () => {
  let dir: string;
  let file: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-evidence-')); file = path.join(dir, 'source.srt'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function write() {
    const raw = { backend: 'paraformer', segments: [{ start: 1.125, end: 9.2,
      raw_text: 'Please sleep a few hours.', text: 'Please SUI a few hours.',
      phoneme_corrections: [{ from: 'sleep', to: 'SUI', score: 0.91 }] }] };
    const normalized = asr.normalizeAsrResult(raw, { max_chars_per_segment: 13 });
    asr.writeSrt(normalized, file, { write_evidence: true, max_chars_per_line: 8, strip_punctuation: true });
    return { raw, parsed: asr.parseSrt(file) };
  }

  test('links exact written rows, preserving full source spans across split subtitles', () => {
    const { raw, parsed } = write();
    const loaded = loadAsrEvidence(file, parsed.segments);
    expect(loaded.status).toBe('available');
    expect(loaded.segments.length).toBeGreaterThan(1);
    expect(loaded.segments[0].asrEvidence).toMatchObject({ status: 'available',
      sourceSpan: { start: 1.125, end: 9.2, rawText: 'Please sleep a few hours.',
        phonemeCorrections: [{ from: 'sleep', to: 'SUI', score: 0.91 }] } });
    expect(loaded.segments.at(-1).asrEvidence.sourceSpan.rawText).toBe(raw.segments[0].raw_text);
    expect(raw.segments[0].text).toBe('Please SUI a few hours.');
  });

  test('sidecar capture does not change the emitted SRT', () => {
    write();
    const content = fs.readFileSync(file, 'utf8');
    const loaded = asr.normalizeAsrResult({ backend: 'paraformer', segments: [{ start: 1.125, end: 9.2,
      text: 'Please SUI a few hours.' }] }, { max_chars_per_segment: 13 });
    asr.writeSrt(loaded, path.join(dir, 'plain.srt'), { max_chars_per_line: 8, strip_punctuation: true });
    expect(fs.readFileSync(path.join(dir, 'plain.srt'), 'utf8')).toBe(content);
    expect(fs.existsSync(evidencePath(path.join(dir, 'plain.srt')))).toBe(false);
  });

  test('marks missing, stale, malformed or misaligned evidence without guessing original words', () => {
    expect(loadAsrEvidence(file, []).status).toBe('missing');
    const { parsed } = write();
    expect(loadAsrEvidence(file, [{ ...parsed.segments[0], text: 'changed' }]).status).toBe('invalid');
    fs.appendFileSync(file, '\n');
    expect(loadAsrEvidence(file, parsed.segments)).toEqual({ status: 'stale', segments: parsed.segments });
    fs.writeFileSync(evidencePath(file), '{');
    expect(loadAsrEvidence(file, parsed.segments).status).toBe('invalid');
  });

  test('does not call already corrected historical SRT raw evidence', () => {
    const result = asr.normalizeAsrResult({ backend: 'whisper', segments: [{ start: 0, end: 3, text: 'SUI' }] });
    asr.writeSrt(result, file, { write_evidence: true });
    const linked = loadAsrEvidence(file, asr.parseSrt(file).segments);
    expect(linked.segments[0].asrEvidence.status).toBe('raw_unavailable');
    expect(linked.segments[0].asrEvidence.sourceSpan.rawText).toBeNull();
  });

  test('speaker-tagged SRT uses the plain sidecar only when every spoken row and time matches', () => {
    const result = asr.normalizeAsrResult({ backend: 'paraformer', segments: [{ start: 0, end: 3,
      raw_text: 'Swee is live.', text: 'SUI is live.', speaker: 'Host', speaker_score: 0.9 }] });
    asr.writeSrt(result, file, { write_evidence: true });
    const speakerPath = asr.writeSpeakerReviewSrt(result, file);
    const { parseTopicSrt } = require('../topic_clipper');
    const parsed = parseTopicSrt(speakerPath);
    expect(parsed.asrEvidenceStatus).toBe('available');
    expect(parsed.segments[0]).toMatchObject({ speaker: 'Host', text: 'SUI is live.',
      asrEvidence: { sourceSpan: { rawText: 'Swee is live.' } } });
    fs.writeFileSync(speakerPath, fs.readFileSync(speakerPath, 'utf8').replace('SUI is live.', 'Different speech.'));
    expect(parseTopicSrt(speakerPath).asrEvidenceStatus).toBe('invalid');
    expect(parseTopicSrt(speakerPath).segments[0].asrEvidence).toBeUndefined();
  });
});
