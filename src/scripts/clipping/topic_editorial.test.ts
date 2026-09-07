export {};

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getClipTopicsConfig } = require('./topic_config');
const { findKeywordMatches, buildTopicBursts, dedupeClipsByStart } = require('./topic_selection');
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const { formatTopicEvidence, isTopicEditorialEnabled, buildTopicEditorialGroups, buildTopicEventPrompt, normalizeTopicEvents,
  buildTopicClipWindow, buildTopicCopyPrompt, normalizeTopicCopy } = require('./topic_editorial');
const { planTopicEventGroup } = require('./topic_editorial_runner');
const generator = require('../ai_text_generator');
const topicClipper = require('../topic_clipper');

// The source timings reproduce the setup/reversal/reaction/new-topic structure
// from the overlapping 2026-09-06 Mofu batch, without depending on local media.
const segments = [
  { start: 6735, end: 6739, text: 'UNRELATED earlier dialogue' },
  { start: 6743.289, end: 6746.095, text: 'SUI did really well' },
  { start: 6760, end: 6775, text: 'The retold story begins with pressure at rehearsal' },
  { start: 6849, end: 6860, text: 'One friend comforts the other' },
  { start: 6936, end: 6944, text: 'The comforter cries too and their roles reverse' },
  { start: 7017.96, end: 7023.119, text: 'SUI was comforted and then comforted the friend' },
  { start: 7041, end: 7047, text: 'The host wonders about playing a duo game with SUI tomorrow' },
  { start: 7080, end: 7087, text: 'The reaction to the story concludes' },
  { start: 7090, end: 7098, text: 'A NEW TOPIC: my first impression was a cold personality' },
  { start: 7140.739, end: 7144.239, text: 'SUI changed what cold personality means' },
  { start: 7150, end: 7159, text: 'That impression became a joke' }
];
const rootConfig = { clipTopics: { enabled: true, keywords: ['SUI'], mergeGapSeconds: 45 }, ai: { text: { provider: 'daiYu' } } };
const config = getClipTopicsConfig(rootConfig);
const evidence = buildSubtitleEvidence(segments);
const bursts = buildTopicBursts(segments, findKeywordMatches(segments, ['SUI']), config);
const groups = buildTopicEditorialGroups(bursts, evidence, config);
const events = [
  { startCueId: 'G2', endCueId: 'G8', event: 'A story and the host reaction',
    reason: 'Keep the independent setup and reversal', score: 91,
    extensionReason: 'The reversal and immediate host reaction need the full story',
    sourceKind: 'recount', evidenceCueIds: ['G2', 'G5', 'G7'] },
  { startCueId: 'G9', endCueId: 'G11', event: 'The cold personality joke',
    reason: 'A genuinely new topic with its own hook', score: 82,
    sourceKind: 'live_speech', evidenceCueIds: ['G10'] }
];
const response = (clips = events) => JSON.stringify({ clips });

function finalizedClips() {
  return normalizeTopicEvents(response(), groups[0], evidence, config).map(selection => ({
    window: buildTopicClipWindow(selection, groups[0], segments), editorial: selection.editorial
  }));
}

function finalCopy(clipId: string) {
  return clipId.endsWith('-1')
    ? { clipId, title: 'The comforting roles reverse', description: 'The host reacts to a retold story.',
      coverText: 'A story\nRoles reverse', sourceKind: 'recount', evidenceCueIds: ['G5', 'G7'] }
    : { clipId, title: 'The cold image did not last', description: 'An early impression becomes a joke.',
      coverText: 'First impression\nIt became a joke', sourceKind: 'live_speech', evidenceCueIds: ['G10'] };
}

describe('topic event editorial policy', () => {
  test('enables event planning by default with compatible opt-outs and consistent duration defaults', () => {
    expect(isTopicEditorialEnabled(rootConfig)).toBe(true);
    expect(isTopicEditorialEnabled({ ai: { text: { enabled: false } } })).toBe(false);
    expect(isTopicEditorialEnabled({ clipTopics: { aiSegmentBurst: false } })).toBe(false);
    expect(isTopicEditorialEnabled({ clipTopics: { editorial: { enabled: false } } })).toBe(false);
    for (const root of [{}, require('../../../config/default.json'), require('../../../config/production.json')]) {
      expect(getClipTopicsConfig(root)).toMatchObject({ preferredClipSeconds: 180, maxClipSeconds: 480,
        editorial: { enabled: true, maxGroupSeconds: 1800, maxEvidenceChars: 80000 } });
    }
    expect(getClipTopicsConfig({ clipTopics: { editorial: { maxGroupSeconds: 900 } } }).editorial)
      .toMatchObject({ enabled: true, maxGroupSeconds: 900, maxEvidenceChars: 80000 });
  });

  test('jointly considers overlapping keyword contexts without preemptively merging events', () => {
    expect(bursts).toHaveLength(3);
    expect(groups).toHaveLength(1);
    expect(groups[0].bursts.map(burst => burst.index)).toEqual([1, 2, 3]);
    expect(groups[0].cues.flatMap(cue => cue.items).map(item => item.text)).toEqual(segments.map(s => s.text));
    const prompt = buildTopicEventPrompt(groups[0], config, 'Host');
    expect(prompt).toContain('SAME story into ONE continuous source interval');
    expect(prompt).toContain('genuinely new topic');
    expect(prompt).toContain('This is a preference, not a cutoff');
    expect(prompt).toContain('Do not write upload titles');
    expect(prompt).toContain('NOT necessarily the host speaking');
  });

  test('bounds planning batches without sampling or losing keyword anchors', () => {
    const bounded = buildTopicEditorialGroups(bursts, evidence, {
      ...config, editorial: { ...config.editorial, maxGroupSeconds: 500 }
    });
    expect(bounded.length).toBeGreaterThan(1);
    expect(bounded.flatMap(group => group.matchSegments)).toHaveLength(findKeywordMatches(segments, ['SUI']).length);
    const smallBudget = buildTopicEditorialGroups(bursts, evidence, {
      ...config, editorial: { ...config.editorial, maxEvidenceChars: 200 }
    });
    expect(smallBudget).toHaveLength(3);
    expect(smallBudget[0].cues.some(cue => cue.text.includes('roles reverse'))).toBe(true);
  });

  test('preserves the story payoff above 180 seconds and separates the subsequent topic', () => {
    const selected = finalizedClips();
    expect(selected).toHaveLength(2);
    expect(selected[0].window).toMatchObject({ start: 6743.289, end: 7087, matchCount: 3 });
    expect(selected[0].window.duration).toBeGreaterThan(180);
    expect(selected[0].window.allSegmentTexts.join(' ')).toContain('roles reverse');
    expect(selected[0].window.allSegmentTexts.join(' ')).not.toContain('NEW TOPIC');
    expect(selected[1].window).toMatchObject({ start: 7090, end: 7159, matchCount: 1 });
    expect(selected[1].window.allSegmentTexts.join(' ')).not.toContain('roles reverse');
    expect(selected[0].editorial.sourceBurstIndices).toEqual([1, 2]);
    expect(selected[1].editorial.sourceBurstIndices).toEqual([3]);
    expect(dedupeClipsByStart(selected, { dedupeMatchText: false })).toEqual(selected);
  });

  test.each([
    ['outside cue', { endCueId: 'G9999' }],
    ['reversed cue', { startCueId: 'G8', endCueId: 'G2' }],
    ['missing extension reason', { extensionReason: '' }],
    ['outside evidence', { evidenceCueIds: ['G10'] }],
    ['missing evidence', { evidenceCueIds: [] }],
    ['invalid score', { score: 'high' }],
    ['missing attribution', { sourceKind: null }]
  ])('rejects %s instead of clipping an invalid plan into shape', (_name, patch) => {
    expect(() => normalizeTopicEvents(response([{ ...events[0], ...patch }]), groups[0], evidence, config)).toThrow();
  });

  test('rejects hard-limit violations, unanchored windows, and overlapping output', () => {
    expect(() => normalizeTopicEvents(response(), groups[0], evidence, { ...config, maxClipSeconds: 180 }))
      .toThrow('refusing to truncate');
    expect(() => normalizeTopicEvents(response([{ ...events[1], startCueId: 'G4', endCueId: 'G5' }]), groups[0], evidence, config))
      .toThrow('keyword anchor');
    expect(() => normalizeTopicEvents(response([events[0], { ...events[1], startCueId: 'G7' }]), groups[0], evidence, config))
      .toThrow('still overlap');
    expect(normalizeTopicEvents(response([]), groups[0], evidence, config)).toEqual([]);
    expect(() => normalizeTopicEvents('{"error":"bad response"}', groups[0], evidence, config)).toThrow();
  });

  test('generates copy from locked in-clip evidence, not old titles or neighboring topics', () => {
    const [clip] = finalizedClips();
    const { prompt, cues } = buildTopicCopyPrompt({ ...clip, aiTitle: 'BAD DRAFT', aiDescription: 'OLD COPY' }, evidence, 'Host', generator);
    expect(prompt).toContain('roles reverse');
    expect(prompt).not.toContain('BAD DRAFT');
    expect(prompt).not.toContain('OLD COPY');
    expect(prompt).not.toContain('UNRELATED');
    expect(prompt).not.toContain('NEW TOPIC');
    const copy = normalizeTopicCopy(response([finalCopy(clip.window.index)]), clip, evidence, cues);
    expect(copy).toMatchObject({ title: 'The comforting roles reverse', grounding: { status: 'linked', sourceKind: 'recount' } });
    expect(copy.description).not.toContain('Keep the independent');
  });

  test.each([
    ['wrong clip', { clipId: 'another-clip' }],
    ['changed range', { start: 6700 }],
    ['outside evidence', { evidenceCueIds: ['G10'] }],
    ['fabricated quote', { title: 'She said "fabricated words"' }],
    ['reversed source type', { sourceKind: 'host_always' }],
    ['missing copy', { description: '' }],
    ['invalid cover', { coverText: 'one line' }]
  ])('rejects final copy with %s', (_name, patch) => {
    const [clip] = finalizedClips();
    const { cues } = buildTopicCopyPrompt(clip, evidence, 'Host', generator);
    expect(() => normalizeTopicCopy(response([{ ...finalCopy(clip.window.index), ...patch }]), clip, evidence, cues)).toThrow();
  });

  test('marks uncertain attribution for review instead of treating cue links as identity verification', () => {
    const [clip] = finalizedClips();
    const { cues } = buildTopicCopyPrompt(clip, evidence, 'Host', generator);
    const copy = normalizeTopicCopy(response([{ ...finalCopy(clip.window.index), sourceKind: 'uncertain' }]), clip, evidence, cues);
    expect(copy.grounding).toMatchObject({ status: 'needs_review', issues: ['uncertain_source'] });
  });

  test('retains supplied speaker labels when rendering audio-track evidence', () => {
    const labeled = buildSubtitleEvidence([{ start: 1, end: 5, text: 'Guest dialogue', speaker: 'Guest' }]);
    expect(formatTopicEvidence(labeled.cues)).toContain('[Guest] Guest dialogue');
  });

  test('uses editorial assessment, not duration, for the final overlap safety check', () => {
    const longer = { window: { start: 100, end: 300 }, editorial: { score: 60 } };
    const complete = { window: { start: 200, end: 350 }, editorial: { score: 90 } };
    expect(dedupeClipsByStart([longer, complete], { dedupeMatchText: false })).toEqual([complete]);
  });

  test.each(['provider', 'evidence-budget'])('keeps labeled fallback candidates when %s prevents editorial planning', async failure => {
    const request = jest.spyOn(generator, 'generateTextWithDaiYu').mockRejectedValue(new Error('provider unavailable'));
    const diagnostics = { failures: [], requests: [] };
    try {
      const result = await planTopicEventGroup(groups[0], evidence, failure === 'evidence-budget'
        ? { ...config, editorial: { ...config.editorial, maxEvidenceChars: 1 } } : config,
      rootConfig, 'Host', {}, diagnostics);
      expect(result).toHaveLength(bursts.length);
      expect(result.every(clip => clip.editorial.status === 'fallback' && !clip.aiTitle)).toBe(true);
      expect(diagnostics.failures).toHaveLength(1);
      expect(request).toHaveBeenCalledTimes(failure === 'provider' ? 1 : 0);
    } finally { request.mockRestore(); }
  });
});

describe('topic event workflow', () => {
  test.each([false, true])('writes final media/copy/review consistently (copy failure=%s)', async failCopy => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-editorial-'));
    const mediaPath = path.join(dir, 'recording.mp4');
    const srtPath = path.join(dir, 'recording.srt');
    fs.writeFileSync(mediaPath, 'fake video');
    topicClipper.writeClipSrt(segments, { start: 0, end: 7200, duration: 7200 }, srtPath, { maxCharsPerLine: 200 });
    const sourceStart = topicClipper.parseTopicSrt(srtPath).segments[1].start;
    const request = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async (prompt: string) => {
      if (prompt.includes('This is event planning only')) return { text: response(), meta: { model: 'test-model' } };
      if (failCopy) throw new Error('copy provider unavailable');
      const clipId = prompt.match(/"clipId":"([^"]+)"/)?.[1];
      if (!clipId) throw new Error('Unexpected request');
      return { text: response([finalCopy(clipId)]), meta: { model: 'test-model' } };
    });
    const mediaGenerator = jest.fn(async (_source, _window, _srt, outputPath) => {
      fs.writeFileSync(outputPath, 'generated clip');
      return { path: outputPath, burnedSubtitles: true };
    });
    const registerReviewForUpload = jest.fn(() => ({ clipIds: [901, 902] }));
    const notifyTopicClipResults = jest.fn(async () => true);
    const legacyCopy = jest.fn(async () => 'STALE CANDIDATE COPY');
    const options = { config: rootConfig, originalMediaPath: mediaPath, srtPath, mediaGenerator,
      coverGenerator: async () => null, registerReviewForUpload, notifyTopicClipResults,
      titleGenerator: legacyCopy, descriptionGenerator: legacyCopy };
    try {
      const results = await topicClipper.generateTopicClips(options);
      expect(results).toHaveLength(2);
      expect(request).toHaveBeenCalledTimes(3);
      expect(legacyCopy).not.toHaveBeenCalled();
      expect(mediaGenerator.mock.calls.map(call => [call[1].start, call[1].end])).toEqual([[sourceStart, 7087], [7090, 7159]]);
      expect(results.every(result => result.autoUploadEnabled === false && result.editorial.status === 'planned')).toBe(true);
      const firstSubtitle = fs.readFileSync(results[0].output.srtPath, 'utf8');
      expect(firstSubtitle).toContain('roles reverse');
      expect(firstSubtitle).not.toContain('NEW TOPIC');
      expect(registerReviewForUpload.mock.calls[0][1]).toHaveLength(2);
      expect(notifyTopicClipResults.mock.calls[0][0]).toHaveLength(2);
      const review = fs.readFileSync(path.join(dir, 'topic_clips', 'REVIEW.md'), 'utf8');
      expect(review.match(/^\d+\./gm)).toHaveLength(2);
      const plan = JSON.parse(fs.readFileSync(path.join(dir, 'topic_clips', 'recording_TOPIC_PLAN.json'), 'utf8'));
      expect(plan.groups).toHaveLength(1);
      expect(plan.candidates).toHaveLength(2);
      if (failCopy) {
        expect(results.every(result => result.status === 'partial' && result.editorial.copyStatus === 'fallback')).toBe(true);
        expect(review).toContain('copy provider unavailable');
      } else {
        expect(results[0].copy).toMatchObject({ title: 'The comforting roles reverse', description: 'The host reacts to a retold story.' });
        expect(results[0].editorial).toMatchObject({ copyStatus: 'generated', copyWindow: { start: sourceStart, end: 7087 } });
        expect(plan.requests).toHaveLength(3);
        expect(plan.failures).toEqual([]);
        await topicClipper.generateTopicClips(options);
        expect(request).toHaveBeenCalledTimes(3);
      }
    } finally {
      request.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
