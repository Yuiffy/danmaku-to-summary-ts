import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  appendReview,
  buildProfileDescription,
  deriveOutputDir,
  deriveSrt,
  formatRecordedDate,
  normalizeOldSuiTitle,
  parseArgs,
  resolveQueueProfile,
} from './manual_clip_queue';

describe('manual_clip_queue', () => {
  test('parses auto-upload task options', () => {
    const options = parseArgs([
      'add', '--media', 'recording.flv', '--start', '1', '--end', '10',
      '--title', '标题', '--cover-text', '封面', '--auto-upload'
    ]);
    expect(options.command).toBe('add');
    expect(options.autoUpload).toBe(true);
    expect(options.coverText).toBe('封面');
  });

  test('resolves old-sui profile without changing the default profile', () => {
    expect(resolveQueueProfile()).toMatchObject({
      name: 'small_sui',
      titlePrefix: '【小岁】',
    });
    expect(resolveQueueProfile('老岁片')).toMatchObject({
      name: 'old_sui',
      titlePrefix: '【老岁片】',
      tags: expect.arrayContaining(['老岁片']),
    });
    expect(resolveQueueProfile('shiori')).toMatchObject({
      name: 'shiori',
      titlePrefix: '【小栞】',
      tags: expect.arrayContaining(['AI切片']),
    });
  });

  test('adds the recording date and source title to old-sui copy', () => {
    const context = {
      recordedAt: '2025-10-08T21:59:48+08:00',
      streamTitle: '【岁己SUI】3D麦温柔小鸟 伴你入眠',
    };
    expect(formatRecordedDate(context.recordedAt)).toBe('2025年10月08日');
    expect(normalizeOldSuiTitle('键盘修好了，但岁己还是不用', context))
      .toBe('键盘修好了，但岁己还是不用 2025年10月08日');
    expect(normalizeOldSuiTitle('键盘修好了，但岁己还是不用 2025年10月08日', context))
      .toBe('键盘修好了，但岁己还是不用 2025年10月08日');
    expect(buildProfileDescription(resolveQueueProfile('old_sui'), '片中简介', context))
      .toContain('直播日期：2025年10月08日');
    expect(buildProfileDescription(resolveQueueProfile('old_sui'), '片中简介', context))
      .toContain('直播标题：【岁己SUI】3D麦温柔小鸟 伴你入眠');
  });

  test('parses profile option for queue tasks', () => {
    const options = parseArgs([
      'add', '--profile', 'old_sui', '--media', 'recording.flv',
      '--start', '1', '--end', '10', '--title', '旧片'
    ]);
    expect(options.profile).toBe('old_sui');
  });

  test('derives sibling SRT and manual output directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-clip-queue-'));
    const media = path.join(root, 'recording.flv');
    fs.writeFileSync(path.join(root, 'recording.srt'), '');
    expect(deriveSrt(media)).toBe(path.join(root, 'recording.srt'));
    expect(deriveOutputDir(media)).toBe(path.join(root, 'manual_requested_clips'));
  });

  test('appends a review entry only once', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-clip-review-'));
    const reviewPath = path.join(root, 'REVIEW.md');
    const task = { mediaPath: 'recording.flv', start: 1, end: 10, title: '标题' } as any;
    const result = { output: { mediaPath: path.join(root, 'clip.mp4'), coverPath: path.join(root, 'cover.jpg') } } as any;
    appendReview(reviewPath, task, result);
    appendReview(reviewPath, task, result);
    expect(fs.readFileSync(reviewPath, 'utf8').match(/标题/g)?.length).toBe(1);
  });
});
