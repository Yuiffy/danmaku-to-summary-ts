export {};

const { dedupeClipsByStart, normalizeAiClipSelection } = require('./topic_selection');

function makeClip(index: string, start: number, end: number) {
  return {
    burst: { index },
    window: { index, start, end, duration: end - start },
    aiTitle: `Title ${index}`,
    aiDescription: `Description ${index}`
  };
}

function expectNonOverlapping(clips: ReturnType<typeof makeClip>[]) {
  for (let index = 1; index < clips.length; index += 1) {
    expect(clips[index].window.start).toBeGreaterThanOrEqual(clips[index - 1].window.end);
  }
}

describe('topic clip overlap selection', () => {
  test('removes the overlapping middle clip from the 2026-09-06 Mofu batch', () => {
    const clips = [
      makeClip('1-1', 2271, 2327.684),
      makeClip('2-1', 6743, 6923),
      makeClip('3-1', 6849, 7029),
      makeClip('4-1', 7015, 7168.814),
      makeClip('5-1', 7401, 7536.055),
      makeClip('6-1', 11472, 11640.7),
      makeClip('7-1', 11932, 12074.409),
      makeClip('8-1', 14181, 14361)
    ];

    const selected = dedupeClipsByStart(clips);

    expect(selected.map(clip => clip.window.index)).toEqual([
      '1-1', '2-1', '4-1', '5-1', '6-1', '7-1', '8-1'
    ]);
    expectNonOverlapping(selected);
    selected.forEach(clip => expect(clips).toContain(clip));
    expect(dedupeClipsByStart(selected)).toEqual(selected);
  });

  test.each([0.001, 1, 14, 74])('rejects even a %s-second overlap across bursts', overlap => {
    const longer = makeClip('longer', 100, 280);
    const shorter = makeClip('shorter', 280 - overlap, 400 - overlap);

    expect(dedupeClipsByStart([shorter, longer])).toEqual([longer]);
  });

  test('keeps touching and separate ranges with the strict default and an explicit zero ratio', () => {
    const first = makeClip('first', 100, 200);
    const touching = makeClip('touching', 200, 280);
    const separate = makeClip('separate', 300, 390);
    const input = [separate, touching, first];

    expect(dedupeClipsByStart(input)).toEqual([first, touching, separate]);
    expect(dedupeClipsByStart(input, { duplicateOverlapRatio: 0 }))
      .toEqual([first, touching, separate]);
  });

  test('checks all retained clips when a longer candidate bridges earlier groups', () => {
    const first = makeClip('first', 100, 170);
    const last = makeClip('last', 190, 260);
    const bridge = makeClip('bridge', 130, 230);

    expect(dedupeClipsByStart([first, last, bridge])).toEqual([bridge]);
    expect(dedupeClipsByStart([bridge, last, first])).toEqual([bridge]);
  });

  test('does not let an already rejected candidate suppress a non-overlapping tail', () => {
    const longest = makeClip('longest', 100, 280);
    const middle = makeClip('middle', 200, 370);
    const tail = makeClip('tail', 285, 405);

    expect(dedupeClipsByStart([middle, tail, longest])).toEqual([longest, tail]);
  });

  test('keeps the first candidate on equal duration without changing ranges or copy', () => {
    const first = makeClip('first', 150, 250);
    const second = makeClip('second', 100, 200);
    Object.freeze(first.window);
    Object.freeze(second.window);
    const clips = Object.freeze([Object.freeze(first), Object.freeze(second)]);

    expect(dedupeClipsByStart(clips)).toEqual([first]);
    expect(clips).toEqual([first, second]);
  });

  test('still supports an explicit nonzero overlap ratio for callers that request it', () => {
    const first = makeClip('first', 100, 280);
    const second = makeClip('second', 206, 386);

    expect(dedupeClipsByStart([first, second], { duplicateOverlapRatio: 0.5 }))
      .toEqual([first, second]);
  });

  test('checks final ranges after subtitle boundary extension introduces overlap', () => {
    const burst = {
      start: 0,
      end: 300,
      minClipSeconds: 30,
      maxClipSeconds: 180,
      boundaryEndExtensionSeconds: 60,
      matchSegments: [{ start: 10, end: 12, text: 'SUI' }],
      boundarySegments: [{ start: 39, end: 42, text: 'A complete sentence!' }]
    };
    const normalized = normalizeAiClipSelection({
      startTime: '00:00:00',
      endTime: '00:00:40'
    }, burst);
    const first = makeClip('first', normalized.start, normalized.end);
    const next = makeClip('next', 41, 81);

    expect(normalized).toMatchObject({ start: 0, end: 42, boundaryAdjusted: true });
    expect(dedupeClipsByStart([first, next])).toEqual([first]);
  });

  test('only generates, registers, and notifies non-overlapping clips across AI bursts', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const topicClipper = require('../topic_clipper');
    const aiTextGenerator = require('../ai_text_generator');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-overlap-'));
    const mediaPath = path.join(dir, 'source.mp4');
    const srtPath = path.join(dir, 'source.srt');
    fs.writeFileSync(mediaPath, 'fake video', 'utf8');
    fs.writeFileSync(srtPath, [
      '1', '01:52:23,289 --> 01:52:26,095', 'SUI first event', '',
      '2', '01:56:57,960 --> 01:57:00,039', 'SUI second event', '',
      '3', '01:59:00,739 --> 01:59:04,239', 'SUI third event', ''
    ].join('\n'), 'utf8');
    const ai = jest.spyOn(aiTextGenerator, 'generateTextWithDaiYu');
    for (const [startTime, endTime] of [
      ['01:52:23', '01:55:23'],
      ['01:54:09', '01:57:09'],
      ['01:56:55', '01:59:28.814']
    ]) {
      ai.mockResolvedValueOnce({
        text: JSON.stringify({ clips: [{
          startTime, endTime, title: 'Selected event',
          description: 'Selected event description', coverText: 'First\nSecond'
        }] })
      });
    }
    const mediaGenerator = jest.fn(async (_source, _window, _srt, outputPath) => {
      fs.writeFileSync(outputPath, 'generated clip', 'utf8');
      return { path: outputPath, burnedSubtitles: true };
    });
    const registerReviewForUpload = jest.fn(() => ({ clipIds: [901, 902] }));
    const notifyTopicClipResults = jest.fn(async () => true);

    try {
      const results = await topicClipper.generateTopicClips({
        config: {
          clipTopics: { enabled: true, keywords: ['SUI'], mergeGapSeconds: 60, maxClipSeconds: 180,
            editorial: { enabled: false } },
          ai: { text: { provider: 'daiYu' } }
        },
        originalMediaPath: mediaPath,
        srtPath,
        mediaGenerator,
        coverGenerator: async () => null,
        registerReviewForUpload,
        notifyTopicClipResults
      });

      expect(ai).toHaveBeenCalledTimes(3);
      expect(results.map(result => result.window.index)).toEqual(['1-1', '3-1']);
      expectNonOverlapping(results);
      expect(mediaGenerator).toHaveBeenCalledTimes(2);
      expect(registerReviewForUpload).toHaveBeenCalledTimes(1);
      expect(registerReviewForUpload.mock.calls[0][1]).toHaveLength(2);
      expect(notifyTopicClipResults).toHaveBeenCalledTimes(1);
      expect(notifyTopicClipResults.mock.calls[0][0]).toHaveLength(2);
      const review = fs.readFileSync(path.join(dir, 'topic_clips', 'REVIEW.md'), 'utf8');
      expect(review.match(/^\d+\./gm)).toHaveLength(2);
    } finally {
      ai.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
