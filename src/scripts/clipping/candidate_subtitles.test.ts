export {};
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildPreflightEvidence } = require('./preflight_evidence');
const { ensureCandidateDraft, readCandidateDraft, correctCandidateDraft, approveCandidateDraft,
  hasDraftApproval, candidateDraftEvidence } = require('./candidate_subtitles');

describe('candidate subtitle revisions', () => {
  let dir, metadata, evidence, file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-draft-'));
    file = path.join(dir, 'candidate.json');
    evidence = buildPreflightEvidence([
      { start: 10, end: 12, text: 'SUI says zzz and zzz.' },
      { start: 12, end: 15, text: 'zzz is the word.' },
      { start: 20, end: 22, text: 'Unrelated zzz outside the clip.' }
    ]);
    metadata = { status: 'pending_preflight', window: { start: 10, end: 15, matchSegments: [] },
      source: { srtPath: path.join(dir, 'source.srt') },
      aiReview: { sourceSha256: evidence.sourceSha256, subtitleEdits: [], keyword: { hits: [] } },
      copy: { title: 'SUI says zzz', description: 'zzz is the word', coverText: 'zzz\nSUI' }, output: {} };
    fs.writeFileSync(metadata.source.srtPath, 'original recording subtitles');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { keywords: ['SUI'] };

  test('prepares an independent relative SRT before selection without media or approval', () => {
    const draft = ensureCandidateDraft(metadata, file, evidence, config);
    expect(draft.cues).toHaveLength(2);
    expect(draft.cues.map(cue => [cue.start, cue.end])).toEqual([[0, 2], [2, 5]]);
    expect(draft.approval).toBeUndefined();
    expect(metadata.status).toBe('pending_preflight');
    expect(metadata.output.mediaPath).toBeUndefined();
    expect(metadata.output.srtPath).toBe(draft.path);
    expect(fs.readFileSync(metadata.source.srtPath, 'utf8')).toBe('original recording subtitles');
  });

  test('literal correction changes only this candidate and keeps timing, old SRT and provenance', () => {
    const before = ensureCandidateDraft(metadata, file, evidence, config);
    const after = correctCandidateDraft(metadata, file, evidence, { from: 'zzz', to: '睡睡睡', reviewNote: 'User confirmed' });
    expect(after.revision).toBe(1);
    expect(fs.readFileSync(before.path, 'utf8')).toContain('zzz');
    expect(fs.readFileSync(after.path, 'utf8')).toContain('睡睡睡 and 睡睡睡');
    expect(after.cues.map(cue => [cue.start, cue.end])).toEqual([[0, 2], [2, 5]]);
    expect(after.edits[0]).toMatchObject({ authority: 'user', original: 'zzz', replacement: '睡睡睡',
      sourceSha256: evidence.sourceSha256, changes: [{ cue: 1 }, { cue: 2 }] });
    expect(metadata.copy.title).toBe('SUI says 睡睡睡');
    expect(evidence.cues[2].text).toBe('Unrelated zzz outside the clip.');
    expect(evidence.cues[0].text).toContain('zzz');
    expect(candidateDraftEvidence(metadata, evidence).evidence.cues[0].text).toContain('睡睡睡');
    expect(fs.readFileSync(metadata.source.srtPath, 'utf8')).toBe('original recording subtitles');
  });

  test('supports a local cue selector and idempotent retry without another revision', () => {
    ensureCandidateDraft(metadata, file, evidence, config);
    const options = { from: 'zzz', to: 'sleep', cue: 2, reviewNote: 'User confirmed cue 2' };
    const draft = correctCandidateDraft(metadata, file, evidence, options);
    expect(draft.cues[0].text).toContain('zzz');
    expect(draft.cues[1].text).toContain('sleep');
    expect(correctCandidateDraft(metadata, file, evidence, options).revision).toBe(1);
  });

  test('missing text or an invalid cue leaves the current revision and approval unchanged', () => {
    ensureCandidateDraft(metadata, file, evidence, config);
    approveCandidateDraft(metadata, evidence, 'User requested upload');
    const snapshot = JSON.stringify(metadata);
    expect(() => correctCandidateDraft(metadata, file, evidence, { from: 'absent', to: 'new' })).toThrow('No literal');
    expect(() => correctCandidateDraft(metadata, file, evidence, { from: 'zzz', to: 'new', cue: 99 })).toThrow('Unknown');
    expect(JSON.stringify(metadata)).toBe(snapshot);
  });

  test('approval binds source, subtitle revision and copy; subsequent edits invalidate it', () => {
    ensureCandidateDraft(metadata, file, evidence, config);
    expect(hasDraftApproval(metadata, evidence)).toBe(false);
    approveCandidateDraft(metadata, evidence, 'User requested upload');
    expect(hasDraftApproval(metadata, evidence)).toBe(true);
    expect(metadata.status).toBe('render_queued');
    expect(hasDraftApproval(metadata, evidence, 'wrong-snapshot')).toBe(false);
    metadata.copy.title = 'Changed title';
    expect(hasDraftApproval(metadata, evidence)).toBe(false);
    correctCandidateDraft(metadata, file, evidence, { from: 'zzz', to: 'sleep' });
    expect(metadata.status).toBe('pending_preflight');
    expect(metadata.candidateSubtitles.approval).toBeNull();
  });

  test('rejects direct SRT tampering, source drift, and boundary changes', () => {
    const draft = ensureCandidateDraft(metadata, file, evidence, config);
    expect(() => readCandidateDraft(metadata, { ...evidence, sourceSha256: 'changed' })).toThrow('changed');
    metadata.window.end = 16;
    expect(() => readCandidateDraft(metadata, evidence)).toThrow('boundaries');
    metadata.window.end = 15;
    fs.appendFileSync(draft.path, 'external edit');
    expect(() => readCandidateDraft(metadata, evidence)).toThrow('outside the correction');
  });
});
