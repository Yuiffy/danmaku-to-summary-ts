import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  appendReview,
  buildProfileDescription,
  cutTask,
  deriveOutputDir,
  deriveSrt,
  formatRecordedDate,
  normalizeOldSuiTitle,
  parseArgs,
  resolveQueueProfile,
} from './manual_clip_queue';

describe('manual_clip_queue', () => {
  test.each([
    '旅行搭子', '正常同事交往', '攻击方式单一', '蜘蛛侠宿命', '',
    '想找旅行搭子\\n“必须一起玩”', '想找旅行搭子\n“必须一起玩”',
  ])('uses the same two-level copy fallback for manual and rebuilt clips: %s', async coverText => {
    const topic = require('./topic_clipper');
    const own = require('./own_stream_clipper');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-cover-copy-'));
    const title = '想找旅行搭子又怕吵架？小岁：我必须要跟别人一起玩才好玩';
    const task = {
      mediaPath: path.join(directory, 'source.mp4'), srtPath: path.join(directory, 'source.srt'),
      start: 0, end: 5, title, coverText, description: '已经核对的文案',
      outputDir: path.join(directory, 'render'), outputStem: 'clip', reviewPath: path.join(directory, 'REVIEW.md'),
      sourceMetadata: { mode: 'own_stream_fun_review' },
    } as any;
    fs.writeFileSync(task.mediaPath, 'source');
    fs.writeFileSync(task.srtPath, '1\n00:00:00,000 --> 00:00:04,000\nSource speech.\n');
    const cut = jest.spyOn(topic, 'cutClipMedia').mockResolvedValue({ burnedSubtitles: true });
    const cover = jest.spyOn(topic, 'generateClipCover').mockResolvedValue(path.join(directory, 'cover.jpg'));
    try {
      const rendered = await cutTask(task, {}, { enabled: false, getProfile: () => ({ mode: 'idle' }) });
      expect(cover.mock.calls[0][1]).toBe(own.buildCoverTitle(title, coverText));
      expect(cover.mock.calls[0][1]).toBe(coverText.includes('\\n') || coverText.includes('\n')
        ? coverText.replace(/\\n/g, '\n') : title);
      expect(rendered.copy.coverText).toBe(coverText);
      expect(rendered.copy.title).toBe(title);
    } finally {
      cut.mockRestore();
      cover.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

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
    for (const alias of ['izayoi', '十六萤', '十六萤Izayoi']) {
      expect(resolveQueueProfile(alias)).toMatchObject({
        name: 'izayoi',
        titlePrefix: '【十六萤】',
        tags: expect.arrayContaining(['十六萤Izayoi']),
      });
    }
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
