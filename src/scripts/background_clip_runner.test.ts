const configLoader = require('./config-loader');
const topicClipper = require('./topic_clipper');
const backgroundClipRunner = require('./background_clip_runner');

describe('background_clip_runner', () => {
  afterEach(() => {
    jest.restoreAllMocks();
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
