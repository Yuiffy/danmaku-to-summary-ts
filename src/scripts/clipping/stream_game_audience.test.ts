const fs = require('fs');
const os = require('os');
const path = require('path');
const audience = require('./stream_game_audience');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'game-audience-'));

describe('recording audience signals', () => {
  test('reads BililiveRecorder danmaku with entities and times intact', () => {
    const dir = tempDir();
    try {
      const xml = path.join(dir, 'rec.xml');
      fs.writeFileSync(xml, `<?xml version="1.0" encoding="utf-8"?>
<i><chatserver>chat.bilibili.com</chatserver>
<d p="12.5,1,25,16777215,1,0,1,0" user="a">阿花好难 &amp; 再来</d>
<d p="61.0,4,25,16777215,2,0,2,0" user="b">这 boss 真肉</d>
</i>`, 'utf8');
      const rows = audience.parseDanmaku(xml);
      expect(rows).toEqual([{ time: 12.5, text: '阿花好难 & 再来' }, { time: 61, text: '这 boss 真肉' }]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('parses the merged SRT without depending on the ASR module', () => {
    const dir = tempDir();
    try {
      const srt = path.join(dir, 'rec.srt');
      fs.writeFileSync(srt, `1
00:00:10,000 --> 00:00:12,500
这个叶师傅好难打

2
00:01:20,500 --> 00:01:22,000
继续走
`, 'utf8');
      const rows = audience.parseSrt(srt);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ start: 10, end: 12.5, text: '这个叶师傅好难打' });
      expect(rows[1].start).toBeCloseTo(80.5, 3);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('counts mentions of any spelling and ignores unrelated chatter', () => {
    const data = {
      danmaku: [{ time: 10, text: '阿花好难' }, { time: 20, text: '这也太肉了' }, { time: 30, text: '新娘阿花倒了' }],
      subtitles: [{ start: 15, end: 18, text: '阿花这个二阶段' }],
      gifts: [{ time: 25, price: 30 }, { time: 26, price: 20 }],
      coins: []
    };
    const stats = audience.windowStats(data, 0, 60, ['阿花', '新娘阿花']);
    expect(stats.named).toBe(2);
    expect(stats.spoken).toBe(1);
    expect(stats.giftValue).toBe(50);
    // A one-minute peak window holds all three lines of this single-minute interval.
    expect(stats.peak).toBe(3);
    expect(audience.windowStats(data, 0, 60, ['不存在'])).toMatchObject({ named: 0, spoken: 0 });
  });

  test('SuperChats and gifts recorded in the XML land on the right second', () => {
    const dir = tempDir();
    try {
      const xml = path.join(dir, 'paid.xml');
      // Danmaku times are relative while sc/gift ts are absolute Unix ms.
      fs.writeFileSync(xml, `<i>
<d p="10.0,1,25,0,1700000010000,0,1,0" user="a">开始了</d>
<sc ts="1700000100000" price="30" user="b">加油</sc>
<gift ts="1700000200000" giftname="小心心" giftcount="5" user="c" />
<guard ts="1700000300000" level="3" user="d" />
</i>`, 'utf8');
      const rows = audience.parsePaidEvents(xml);
      expect(rows.map(row => [row.kind, Math.round(row.time)])).toEqual([['sc', 100], ['gift', 200], ['guard', 300]]);
      expect(rows[0]).toMatchObject({ price: 30 });
      expect(rows[1]).toMatchObject({ count: 5, name: '小心心' });
      const loaded = audience.loadAudience({ xmlPath: xml });
      expect(loaded.available.gifts).toBe(true);
      expect(loaded.gifts).toHaveLength(3);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a gift sidecar is optional and never breaks the title', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'rec.gifts.json');
      fs.writeFileSync(file, JSON.stringify({ gifts: [{ time: 5, price: '100', giftName: '小心心' }, { time: 70, price: 20 }] }), 'utf8');
      expect(audience.parseGifts([file])).toEqual([{ time: 5, price: 100, name: '小心心' }, { time: 70, price: 20, name: '' }]);
      expect(audience.parseGifts([path.join(dir, 'missing.json')])).toEqual([]);
      fs.writeFileSync(file, 'not json', 'utf8');
      expect(audience.parseGifts([file])).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a recording is parsed once and reused for every submission', () => {
    const dir = tempDir();
    try {
      const xml = path.join(dir, 'a.xml');
      fs.writeFileSync(xml, '<i><d p="1,1,25,0,0,0,0,0">hi</d></i>', 'utf8');
      const first = audience.loadAudience({ xmlPath: xml });
      const second = audience.loadAudience({ xmlPath: xml });
      expect(second).toBe(first);
      expect(first.available).toMatchObject({ danmaku: true, subtitles: false, gifts: false });
      expect(audience.loadAudience({ xmlPath: path.join(dir, 'absent.xml') }).danmaku).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
