const configLoader = require('./config-loader');
const topicClipper = require('./topic_clipper');
const backgroundClipRunner = require('./background_clip_runner');

describe('background_clip_runner', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('song/viewing workflow triggers for Sui even when highlight clippers and XML are absent', () => {
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({
      clipTopics: { enabled: false }, ownStreamClips: { enabled: false },
      streamActivityClips: { enabled: true, roomIds: ['25788785'] }
    });
    expect(backgroundClipRunner.shouldRunAnyClipper('25788785', null)).toBe(true);
    expect(backgroundClipRunner.shouldRunAnyClipper('22470216', null)).toBe(false);
  });

  test('activity failure preserves the recording while existing stages continue', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const activity = require('./clipping/stream_activity_clipper');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-activity-'));
    const media = path.join(dir, 'recording.flv'), payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(media, 'source');
    fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: media, srtPath: 'source.srt', roomId: '25788785', videoPathToDelete: media }));
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({ clipTopics: { enabled: false }, ownStreamClips: { enabled: false } });
    jest.spyOn(activity, 'generateStreamActivities').mockRejectedValue(new Error('activity detection unavailable'));
    try {
      await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
      expect(fs.existsSync(media)).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('successful activity rendering preserves its source until human review', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const activity = require('./clipping/stream_activity_clipper');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-activity-review-'));
    const media = path.join(dir, 'recording.flv'), payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(media, 'source');
    fs.writeFileSync(payloadPath, JSON.stringify({ originalMediaPath: media, srtPath: 'source.srt', roomId: '25788785', videoPathToDelete: media }));
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({ clipTopics: { enabled: false }, ownStreamClips: { enabled: false } });
    jest.spyOn(activity, 'generateStreamActivities').mockResolvedValue({ status: 'rendered', submissions: 2, pendingReview: true });
    try {
      await backgroundClipRunner.runBackgroundClipsFromPayload(payloadPath);
      expect(fs.readFileSync(media, 'utf8')).toBe('source');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('notifies a fatal topic clipping failure and resolves so later stages can continue', async () => {
    const config = {
      clipTopics: {
        enabled: true,
        outputDirName: 'topic_clips',
        notify: { enabled: true }
      },
      ai: {
        roomSettings: {
          '26966466': { anchorName: '小栞' }
        }
      }
    };
    jest.spyOn(configLoader, 'getConfig').mockReturnValue(config);
    jest.spyOn(topicClipper, 'generateTopicClips').mockRejectedValue(new Error('fatal topic failure'));
    const notifyTopicClipFailure = jest
      .spyOn(topicClipper, 'notifyTopicClipFailure')
      .mockResolvedValue(true);

    await expect(backgroundClipRunner.generateTopicClipsForMedia(
      'D:\\recordings\\录制-26966466-20260805-102031-440-早安獭獭栞！.flv',
      null,
      'D:\\recordings\\recording.srt',
      '26966466',
      {}
    )).resolves.toEqual([]);

    expect(notifyTopicClipFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'fatal topic failure' }),
      expect.objectContaining({
        streamerName: '小栞',
        roomId: '26966466',
        stage: 'topic_clipper'
      }),
      config
    );
  });
});
