import { hasDanmakuText, parseDanmaku } from './DanmakuEvidence';

it('prefilters decoded normalized message text without confusing author attributes for message content', () => {
  const content = '<i><sc ts="1" user="原作者">&#x8eba;在床上 ＡＢＣ &amp;lt;</sc></i>';
  expect(hasDanmakuText(content, text => Number(text.includes('躺在床上 ABC &lt;')))).toBe(true);
  expect(hasDanmakuText(content, text => Number(text.includes('原作者')))).toBe(false);
  expect(hasDanmakuText(content, text => Number(text.includes('不存在')))).toBe(false);
});

it('reads SC alongside ordinary comments and retains the recorded sender and cross-midnight time', () => {
  const cues = parseDanmaku('<i><BililiveRecorderRecordInfo start_time="2026-06-17T22:35:56.486+08:00" />' +
    '<d user="甲 &amp; 乙" p="2,1,25,0,1781706958486,0,123,0">正文 &amp; &#x1f600;</d>' +
    '<sc ts="8089.015" user="L1f3n0w0v3R710w_" uid="288811455" price="30" time="60">躺在床上莫名又会想</sc></i>');
  expect(cues).toEqual([
    expect.objectContaining({ seconds: 2, text: '正文 & 😀', senderName: '甲 & 乙', senderUid: '123', messageType: 'danmaku' }),
    expect.objectContaining({ seconds: 8089.015, text: '躺在床上莫名又会想', senderName: 'L1f3n0w0v3R710w_', senderUid: '288811455',
      messageType: 'superchat', sentAt: '2026-06-18T00:50:45.501+08:00', sentAtBasis: 'recording_start' })
  ]);
});

it('does not resolve external entities or invent missing identities/timestamps and still filters bot SC', () => {
  const cues = parseDanmaku('<!DOCTYPE i [<!ENTITY xxe SYSTEM "file:///secret">]><i>' +
    '<sc ts="1" user="甲 &lt;admin&gt;" uid="bad">内容 &xxe; &amp;lt;</sc>' +
    '<sc ts="2" user="鹿饼" uid="99">目标词</sc>' +
    '<sc ts="3" uid="123">@鹿饼 目标词</sc><sc ts="-1">无效</sc></i>', '99');
  expect(cues).toEqual([expect.objectContaining({ text: '内容 &xxe; &lt;', senderName: '甲 <admin>', seconds: 1 })]);
  expect(cues[0].senderUid).toBeUndefined();
  expect(cues[0].sentAt).toBeUndefined();
});
