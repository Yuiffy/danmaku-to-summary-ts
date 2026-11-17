const { postProcessAiClipMetadata } = require('./ai_clip_metadata');

test('limits merged upload tags to ten while reserving safe defaults', () => {
  const requiredTags = ['VirtuaReal', '小岁', '岁AI切片', '虚拟主播', '直播切片', 'AI切片'];
  const tags = ['新衣展示', '睡觉表情', '表情测试', '可爱', '搞笑', '饼干岁', ...requiredTags];
  expect(postProcessAiClipMetadata({ tags, requiredTags }).tags).toEqual([
    '新衣展示', '睡觉表情', '表情测试', '可爱', ...requiredTags
  ]);
});

test('reserves the AI marker even when no explicit defaults are supplied', () => {
  const tags = Array.from({ length: 12 }, (_, i) => `主题${i}`);
  expect(postProcessAiClipMetadata({ tags: [...tags, 'AI切片'] }).tags)
    .toEqual([...tags.slice(0, 9), 'AI切片']);
});

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
test('preferred clip names remain idempotent when they contain a formal name', () => {
  const { postProcessAiClipMetadata } = require('./ai_clip_metadata');
  const config = { ai: { streamerRegistry: { guest: { displayName: 'Guest', aiClipName: 'GuestClip' } } } };
  const first = postProcessAiClipMetadata({ title: 'Guest asked GuestClip' }, config);
  expect(first.title).toBe('GuestClip asked GuestClip');
  expect(postProcessAiClipMetadata(first, config).title).toBe(first.title);
});

test('maps formal or alias topic mentions to safe public nicknames', () => {
  const { deriveMentionedStreamerTags } = require('./ai_clip_metadata');
  const config = { ai: { streamerRegistry: {
    sui: { displayName: '岁己SUI', searchTags: ['岁己'], aliases: ['小岁'], aiClipName: '小岁' },
    shiori: { displayName: '栞栞', searchTags: ['栞栞'], aliases: ['小栞'], aiClipName: '小栞' }
  } } };
  expect(deriveMentionedStreamerTags({ matchedKeywords: ['岁己'] }, config)).toEqual(['小岁']);
  expect(deriveMentionedStreamerTags({ text: '小栞今晚要开播' }, config)).toEqual(['小栞']);
});
