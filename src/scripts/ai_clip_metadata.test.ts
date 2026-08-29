const { postProcessAiClipMetadata } = require('./ai_clip_metadata');

const config = { ai: { streamerRegistry: {
  sui: { displayName: '岁己SUI', searchTags: ['岁己'], aiClipName: '小岁' },
  shiori: { displayName: '栞栞', searchTags: ['栞栞Shiori'], aiClipName: '小栞' }
} } };

test('replaces official names in titles and removes official search tags', () => {
  expect(postProcessAiClipMetadata({
    title: '栞栞问岁己SUI怎么了',
    tags: ['小栞', '栞栞', '栞栞Shiori', '岁己', '直播切片']
  }, config)).toEqual({ title: '小栞问小岁怎么了', tags: ['小栞', '直播切片'] });
});

test('keeps explicitly configured upload tags even when they are official names', () => {
  const activityConfig = { ai: { streamerRegistry: {
    harei: {
      displayName: '花礼Harei',
      searchTags: ['花礼'],
      uploadTags: ['花礼Harei', '芙娅之魂']
    }
  } } };

  expect(postProcessAiClipMetadata({
    title: '花礼Harei的直播片段',
    tags: ['花礼Harei', '花礼', '芙娅之魂', '直播切片']
  }, activityConfig)).toEqual({
    title: '花礼Harei的直播片段',
    tags: ['花礼Harei', '芙娅之魂', '直播切片']
  });
});
