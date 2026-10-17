import { collectClipIntentSignals, clipIntentForWindow, clipIntentReasons, parseClipIntentCommand } from './ClipIntent';

test.each(['@鹿饼 我要这段', '＠鹿饼：我要这段！'])('parses exact request %s', text => {
  expect(parseClipIntentCommand(text)).toBe('request');
});
test.each(['@鹿饼 这段别切', '@鹿饼：这段不要切。'])('parses exact hold %s', text => {
  expect(parseClipIntentCommand(text)).toBe('hold');
});
test.each(['我要这段', '观众说@鹿饼 这段别切', '@鹿饼 我要这段并立即投稿', '@鹿饼\n这段别切', '@鹿饼 今天聊什么'])('does not interpret other text as commands: %s', text => {
  expect(parseClipIntentCommand(text)).toBeNull();
});
test('split ASR and audience evidence remain distinct, bounded to the window and its immediate ending', () => {
  const signals = collectClipIntentSignals([
    { start: 100, end: 102, text: '这段别' }, { start: 102.2, end: 104, text: '切了，真的' },
    { start: 300, end: 302, text: '不要切歌' }, { start: 400, end: 402, text: '别' },
    { start: 410, end: 412, text: '切' }
  ], [{ time: 99, text: '@鹿饼 我要这段' }, { time: 105, text: '@鹿饼 这段别切' }, { time: 500, text: '这段别切' }]);
  expect(signals).toHaveLength(3);
  const intent = clipIntentForWindow(signals, { start: 80, end: 100 });
  expect(intent.needsHumanReview).toBe(true);
  expect(clipIntentReasons(intent)).toEqual([expect.stringContaining('ASR疑似'), expect.stringContaining('弹幕@鹿饼')]);
  expect(clipIntentForWindow(signals, { start: 106, end: 120 }).needsHumanReview).toBe(false);
  expect(clipIntentForWindow(signals, { start: 0, end: 69 }).signals).toHaveLength(0);
});

test('grouped subtitles are inspected through their actual items and requests never cancel holds', () => {
  const signals = collectClipIntentSignals([{ start: 0, end: 20, text: '分组摘要', items: [
    { start: 2, end: 3, text: '这个别切了' }]
  }], [{ time: 4, text: '@鹿饼 我要这段' }]);
  expect(clipIntentForWindow(signals, { start: 0, end: 10 })).toMatchObject({ needsHumanReview: true,
    signals: [{ source: 'asr', action: 'hold' }, { source: 'danmaku', action: 'request' }] });
});
