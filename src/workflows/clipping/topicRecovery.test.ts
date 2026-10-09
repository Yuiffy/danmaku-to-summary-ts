import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { compactPreflightPrompt, recoverCandidatePlan, recoveryAuthorizes, repairTopicResponse, type CandidateRecoveryIO } from './topicRecovery';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sourceSha256 = 'a'.repeat(64);
const copy = { title: 'Pending', description: '', coverText: '' };
const config = { minClipSeconds: 30, maxClipSeconds: 480, contextPrePaddingSeconds: 180,
  contextPostPaddingSeconds: 300, review: { enabled: true, mode: 'preflight' } };

test('oversized source packing retains every cue and restores identical ASR fields exactly', () => {
  const rawText = 'Unchanged ASR original text. '.repeat(200);
  const input = { subtitles: [{ id: 'G1', start: 0, end: 10, text: 'SUI source' }],
    hits: [{ id: 'K1', cueId: 'G1' }], audience: [{ id: 'D1', text: 'A reaction' }],
    originalAsrSpans: [
      { id: 'R1', start: 0, end: 10, rawText, recognizedText: rawText,
        timingPrecision: 'segment', words: null, phonemeCorrections: [{ original: '小c', corrected: '小岁' }] },
      { id: 'R2', rawText: 'Raw source', recognizedText: 'Different recognition' },
    ] };
  const prompt = `All editorial rules\nSOURCE EVIDENCE:\n${JSON.stringify(input)}`;
  const compact = compactPreflightPrompt(prompt, prompt.length - 500);
  expect(compact.length).toBeLessThanOrEqual(prompt.length - 500);
  expect(compact).toContain('All editorial rules');
  expect(compact).toContain('omitted recognizedText is identical to rawText');
  const packed = JSON.parse(compact.split('SOURCE EVIDENCE:\n')[1]);
  packed.originalAsrSpans = packed.originalAsrSpans.map(row => ({ ...row,
    recognizedText: row.recognizedText ?? row.rawText }));
  expect(packed).toEqual(input);
  expect(input.originalAsrSpans[0].recognizedText).toBe(rawText);
  expect(compactPreflightPrompt(prompt, prompt.length)).toBe(prompt);
});

test.each(['No source marker', 'rules\nSOURCE EVIDENCE:\ninvalid', 'rules\nSOURCE EVIDENCE:\nnull',
  'rules\nSOURCE EVIDENCE:\n{"originalAsrSpans":[{"rawText":"one","recognizedText":"different"}]}'])
('unpackable prompts remain subject to the original budget: %s', prompt => {
  expect(compactPreflightPrompt(prompt, 1)).toBe(prompt);
});

describe('bounded recovery of a queued topic boundary failure', () => {
  let dir: string, metadata: any, selected: any, options: any, io: CandidateRecoveryIO;
  const cues = [
    { id: 'G1', start: 0, end: 10, text: 'Setup', items: [{ start: 0, end: 10, text: 'Setup' }] },
    { id: 'G2', start: 10, end: 20, text: 'SUI has a price', items: [{ start: 10, end: 20, text: 'SUI has a price' }] },
    { id: 'G3', start: 20, end: 40, text: 'Closing reply', items: [{ start: 20, end: 40, text: 'Closing reply' }] }
  ];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-recovery-'));
    const file = path.join(dir, 'candidate.json');
    const srt = path.join(dir, 'candidate.srt');
    const media = path.join(dir, 'source.mp4');
    fs.writeFileSync(media, 'source media');
    fs.writeFileSync(srt, 'old approved subtitles');
    metadata = { candidateId: 17, status: 'render_queued',
      source: { mediaPath: media, srtPath: path.join(dir, 'source.srt'), sourceKind: 'video' },
      window: { index: 'E2-1', start: 10, end: 40, matchSegments: [{ ...cues[1].items[0], matchedKeywords: ['SUI'] }] },
      aiReview: { sourceSha256, status: 'needs_review', reason: 'Preflight duration outside limits' },
      editorial: { copyGrounding: null }, copy: { ...copy },
      output: { metadataPath: file, srtPath: srt, mediaPath: null },
      candidateSubtitles: { sourceSha256, sourceSrtPath: path.join(dir, 'source.srt'), window: { start: 10, end: 40 },
        path: srt, sha256: digest('old approved subtitles'), revision: 0, edits: [],
        approval: { authority: 'user', sourceSha256, sha256: digest('old approved subtitles'), revision: 0,
          copySha256: digest(JSON.stringify([copy.title, copy.description, copy.coverText])) } } };
    options = { candidateId: 17, requireApproval: true, reviewNote: 'User requested upload',
      expectedSha256: metadata.candidateSubtitles.sha256, registryPath: path.join(dir, 'registry.json') };
    fs.writeFileSync(options.registryPath, JSON.stringify({ clips: { 17: { id: 17, metadataPath: file, pendingCut: true } } }));
    const evidence = { sourceSha256, cues, byId: new Map(cues.map(cue => [cue.id, cue])) };
    selected = { start: 0, end: 40, subtitleSegments: cues.map(cue => ({ ...cue.items[0] })),
      aiTitle: 'SUI has a price', aiDescription: 'The response', aiCoverText: 'price\nSUI',
      preflight: { status: 'ready', sourceSha256, keyword: { status: 'confirmed' }, quality: { status: 'pass', issues: [] },
        subtitleEdits: [], model: 'gpt-6-luna', reasoningEffort: 'high', applied: false },
      editorial: { sourceKind: 'live_speech', copyGrounding: { issues: [], subtitleIds: ['G1', 'G2', 'G3'] } } };
    io = { evidence: jest.fn(() => evidence), ensureDraft: jest.fn(item => item.candidateSubtitles),
      approved: jest.fn(() => true), corrected: jest.fn((_item, input) => input),
      prepare: jest.fn(async () => ({ clips: [selected], record: {} })), selections: jest.fn(() => [selected]),
      writeRevision: jest.fn((target, newCues) => {
        const content = JSON.stringify(newCues);
        fs.writeFileSync(target, content);
        return { sha256: digest(content), cues: newCues };
      }), save: jest.fn(item => fs.writeFileSync(file, JSON.stringify(item))), now: () => '2026-10-03T00:00:00Z' };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = () => recoverCandidatePlan(metadata, metadata.output.metadataPath, options, config, io);

  test('versions the new interval and public copy, retaining the original upload intent and subtitle file', async () => {
    const oldSrt = metadata.candidateSubtitles.path;
    await run();
    expect(metadata.window).toMatchObject({ start: 0, end: 40 });
    expect(metadata.candidateSubtitles.approval).toBeNull();
    expect(fs.readFileSync(oldSrt, 'utf8')).toBe('old approved subtitles');
    expect(metadata.candidateRecovery.original.window).toMatchObject({ start: 10, end: 40 });
    expect(recoveryAuthorizes(metadata, sourceSha256, options.expectedSha256)).toBe(true);
    metadata.aiReview.applied = true;
    expect(recoveryAuthorizes(metadata, sourceSha256, options.expectedSha256)).toBe(true);
    expect(recoveryAuthorizes(metadata, sourceSha256, 'other queued revision')).toBe(false);
    metadata.copy.title = 'Changed after review';
    expect(recoveryAuthorizes(metadata, sourceSha256, options.expectedSha256)).toBe(false);
    expect(io.prepare).toHaveBeenCalledTimes(1);
  });

  test.each(['source', 'approval'] as const)('rejects changed %s before any AI request', async changed => {
    if (changed === 'source') metadata.aiReview.sourceSha256 = 'stale';
    else io.approved = jest.fn(() => false);
    await expect(run()).rejects.toThrow(changed === 'source' ? 'Source evidence changed' : 'matching upload approval');
    expect(io.prepare).not.toHaveBeenCalled();
    expect(io.writeRevision).not.toHaveBeenCalled();
  });

  test('an unresolved repair is persisted and cannot trigger an automatic loop', async () => {
    selected.preflight.status = 'needs_review';
    selected.preflight.quality.issues = ['The event remains incomplete'];
    await expect(run()).rejects.toThrow('still needs review');
    expect(metadata.candidateRecovery.status).toBe('failed');
    expect(metadata.candidateSubtitles.revision).toBe(0);
    await expect(run()).rejects.toThrow('already attempted');
    expect(io.prepare).toHaveBeenCalledTimes(1);
    expect(io.writeRevision).not.toHaveBeenCalled();
  });

  test('protects original context and structured boundary references during request budgeting', async () => {
    metadata.window.contextSegments = [{ start: 8, end: 9 }];
    metadata.aiReview.boundaryReview = { setupCueId: 'G2', closureCueId: 'G3',
      unresolvedCueIds: [], dependencies: [{ cueId: 'G3', dependsOnCueIds: ['G1'] }] };
    await run();
    expect((io.prepare as jest.Mock).mock.calls[0][3]).toEqual({ start: 0, end: 40 });
    expect(io.prepare).toHaveBeenCalledTimes(1);
  });

  test.each(['overlap', 'source_drift', 'confirmed_word', 'lost_anchor', 'short_event'] as const)(
    'holds %s and preserves the approved draft', async failure => {
      if (failure === 'overlap') {
        const sibling = path.join(dir, 'other.json');
        fs.writeFileSync(sibling, JSON.stringify({ source: metadata.source, window: { start: 0, end: 8 } }));
        fs.writeFileSync(options.registryPath, JSON.stringify({ clips: {
          17: { id: 17, metadataPath: metadata.output.metadataPath, pendingCut: true },
          18: { id: 18, metadataPath: sibling, sourceMediaPath: metadata.source.mediaPath, mediaPath: 'rendered.mp4' } } }));
      } else if (failure === 'source_drift') {
        io.prepare = jest.fn(async () => { fs.writeFileSync(metadata.source.mediaPath, 'changed source media'); return { clips: [selected] }; });
      } else if (failure === 'confirmed_word') {
        metadata.candidateSubtitles.edits = [{ changes: [{ cueId: 'G2' }] }];
        selected.subtitleSegments[1].text = 'AI overwrote the confirmed word';
      } else if (failure === 'lost_anchor') selected.start = 21;
      else { selected.start = 10; selected.end = 20; }
      await expect(run()).rejects.toThrow();
      expect(metadata.candidateSubtitles.revision).toBe(0);
      expect(metadata.output.mediaPath).toBeNull();
      expect(io.writeRevision).not.toHaveBeenCalled();
    });

  test('a missing old artifact from a different recording cannot block recovery', async () => {
    const registry = JSON.parse(fs.readFileSync(options.registryPath, 'utf8'));
    registry.clips[18] = { id: 18, metadataPath: path.join(dir, 'unavailable.json'),
      sourceMediaPath: path.join(dir, 'different-recording.mp4'), mediaPath: 'archived.mp4' };
    fs.writeFileSync(options.registryPath, JSON.stringify(registry));
    await run();
    expect(metadata.candidateRecovery.status).toBe('ready');
  });
});

test('boundary repair holds a second bad response and rejects model changes without further requests', async () => {
  const request = jest.fn(async () => ({ text: 'invalid' }));
  const io = { request, normalize: () => { throw new Error('Preflight duration outside limits'); },
    matches: () => true, record: jest.fn() };
  await expect(repairTopicResponse('rules\nSOURCE EVIDENCE:\nfull source', 'old draft', 'Preflight duration outside limits', io))
    .rejects.toThrow('duration');
  expect(request).toHaveBeenCalledTimes(1);
  await expect(repairTopicResponse('rules\nSOURCE EVIDENCE:\nfull source', 'old draft', 'provider timeout', io))
    .rejects.toThrow('provider timeout');
  expect(request).toHaveBeenCalledTimes(1);
  await expect(repairTopicResponse('rules\nSOURCE EVIDENCE:\nfull source', 'old draft', 'Preflight duration outside limits',
    { ...io, matches: () => false })).rejects.toThrow('model, protocol or reasoning');
  expect(request).toHaveBeenCalledTimes(2);
});
