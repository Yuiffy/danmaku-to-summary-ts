import { parseVoteChoice, parseVoteCommand, VoteSession } from './VoteSession';

const now = 1790259000000;
const message = (uid: string, text: string, sentAt = now) => ({ uid, text, sentAt });

describe('live vote', () => {
  it.each([
    ['#投票 A复联2 B法环 C美队3 D第三集', 30, ['A', 'B', 'C', 'D'], ['复联2', '法环', '美队3', '第三集']],
    ['#投票60 b.法环 c.美队3', 60, ['B', 'C'], ['法环', '美队3']],
    ['＃投票 Ｂ、法环 Ｃ：美队3', 30, ['B', 'C'], ['法环', '美队3']],
    ['#投票 C.甲 A.乙 I.丙', 30, ['C', 'A', 'I'], ['甲', '乙', '丙']],
    ['#投票 A.Apple Pie B.Banana', 30, ['A', 'B'], ['Apple Pie', 'Banana']]
  ])('parses letter keys without renumbering: %s', (text, duration, keys, labels) => {
    expect(parseVoteCommand(text as string)).toEqual({ duration, keys, labels, numbering: 'letter' });
  });

  it.each(['#投票 B甲', '#投票 B甲 b乙', '#投票 B C乙', '#投票 B甲 2乙',
    '#投票 1甲 B乙', '#投票 J甲 K乙', '#投票 A甲 B乙 C丙 D丁 E戊 F己 G庚 H辛 I壬 J癸'])
  ('rejects invalid letter options: %s', text => {
    expect(parseVoteCommand(text)).toBeNull();
  });

  it('matches only the actual keys and accepts fullwidth, mixed-case repeated letters', () => {
    for (const text of ['b', 'BBB', 'bBb', ' ＢｂＢ ']) expect(parseVoteChoice(text, 2, ['B', 'C'])).toBe(1);
    expect(parseVoteChoice('ccc', 2, ['B', 'C'])).toBe(2);
    for (const text of ['A', 'D', '1', '2', 'BC', 'B B', 'B法环', '']) {
      expect(parseVoteChoice(text, 2, ['B', 'C'])).toBeNull();
    }
    expect(parseVoteChoice('B', 2)).toBeNull();
    expect(parseVoteChoice('333', 2, ['2', '3'])).toBe(2);
    expect(parseVoteChoice('1', 2, ['2', '3'])).toBeNull();
  });

  it.each([false, true])('keeps subset keys in announcements and final results (early=%s)', early => {
    const notices: string[] = [];
    const session = new VoteSession({ authorizedUids: ['42'], botUid: '99' }, text => notices.push(text));
    session.ingest(message('7', '#投票 B法环 C美队3'), now);
    expect(notices).toEqual([]);
    session.ingest(message('42', '#投票 B法环 C美队3'), now);
    session.ingest(message('10', 'bBb'), now);
    session.ingest(message('10', 'ccc'), now);
    session.ingest(message('11', 'ＣＣＣ'), now);
    session.ingest(message('12', 'c'), now);
    for (const [uid, text] of [['13', 'A'], ['14', 'D'], ['15', '2'], ['99', 'B']]) {
      session.ingest(message(uid, text), now);
    }
    session.tick(now + 10000);
    if (early) session.ingest(message('42', '#结束投票', now + 11000), now + 11000);
    session.tick(now + 33000);
    expect(notices).toEqual([
      '投票30秒，发字母：B.法环 C.美队3',
      '剩余20秒~B.法环:1票 C.美队3:2票',
      '结束：B.法环:1票 C.美队3:2票 【美队3】胜~'
    ]);
  });

  it.each([20, 40])('packs long letter options within %i characters without renumbering', maxMessageChars => {
    const notices: string[] = [];
    const label = '甲'.repeat(16);
    const session = new VoteSession({ authorizedUids: ['42'], maxMessageChars }, text => notices.push(text));
    session.ingest(message('42', `#投票 C${label} B乙`), now);
    session.ingest(message('10', 'CCC'), now);
    session.tick(now + 10000);
    session.tick(now + 33000);
    expect(notices.join(' ')).toContain(`C.${label}`);
    expect(notices.join(' ')).toContain(`【${label}】胜~`);
    expect(notices.join(' ')).toContain(maxMessageChars === 20 ? 'C号：1票' : `C.${label}:1票`);
    expect(notices.every(text => Array.from(text).length <= maxMessageChars)).toBe(true);
  });

  it('allows an authorized fresh end command to publish one immediate result and close voting', () => {
    const notices: string[] = [];
    const invalidate = jest.fn();
    const session = new VoteSession({ authorizedUids: ['42'] }, text => notices.push(text), invalidate);
    session.ingest(message('42', '#结束投票'), now);
    expect(notices).toEqual([]);
    session.ingest(message('42', '#投票60 1复联2 2老头环 3美队3'), now);
    session.ingest(message('10', '333', now + 100), now + 100);
    session.ingest(message('7', '#结束投票', now + 200), now + 200);
    session.ingest(message('42', '#结束投票', now - 1), now + 200);
    session.ingest(message('42', '#结束投票', now + 100), now + 10200);
    expect(invalidate).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    session.ingest(message('42', ' ＃结束投票 ', now + 11000), now + 11000);
    expect(notices).toEqual([
      '投票60秒，发序号：1.复联2 2.老头环 3.美队3',
      '结束：1.复联2:0票 2.老头环:0票 3.美队3:1票 【美队3】胜~'
    ]);
    expect(invalidate).toHaveBeenCalledTimes(1);
    session.ingest(message('11', '2', now + 12000), now + 12000);
    session.ingest(message('42', '#结束投票', now + 13000), now + 13000);
    session.tick(now + 63000);
    expect(notices).toHaveLength(2);
    session.ingest(message('42', '#投票 1甲 2乙', now + 64000), now + 64000);
    expect(notices[2]).toBe('投票30秒，发序号：1.甲 2.乙');
  });
  it('accepts concise numbered options with bounded duration and preserves digits in names', () => {
    expect(parseVoteCommand('#投票 1.复联2 2.法环')).toEqual({ duration: 30, labels: ['复联2', '法环'], keys: ['1', '2'], numbering: 'number' });
    expect(parseVoteCommand('#投票60 1复联2 2法环')).toEqual({ duration: 60, labels: ['复联2', '法环'], keys: ['1', '2'], numbering: 'number' });
    expect(parseVoteCommand('#投票 60 1、甲 2、乙')).toEqual({ duration: 60, labels: ['甲', '乙'], keys: ['1', '2'], numbering: 'number' });
    expect(parseVoteCommand('#投票 1复联2 2老头环 3美队3')).toEqual({ duration: 30, labels: ['复联2', '老头环', '美队3'], keys: ['1', '2', '3'], numbering: 'number' });
    expect(parseVoteCommand('#投票 1.2048 2.法环')).toEqual({ duration: 30, labels: ['2048', '法环'], keys: ['1', '2'], numbering: 'number' });
    expect(parseVoteCommand('#投票999 1甲 2乙')).toBeNull();
    expect(parseVoteCommand('#投票 1甲')).toBeNull();
    expect(parseVoteChoice(' １１１１ ')).toBe(1);
    expect(parseVoteChoice('2222')).toBe(2);
    expect(parseVoteChoice('121')).toBeNull();
    expect(parseVoteChoice('2法环')).toBeNull();
    expect(parseVoteChoice('３３３', 3)).toBe(3);
    expect(parseVoteChoice('333', 2)).toBeNull();
    expect(parseVoteChoice('444', 3)).toBeNull();
    expect(parseVoteCommand('#投票 1甲 3乙')).toEqual({ duration: 30, labels: ['甲', '乙'], keys: ['1', '3'], numbering: 'number' });
    expect(parseVoteCommand('#投票 1甲 2 3丙')).toBeNull();
    expect(parseVoteCommand('#投票 1甲 2乙 2丙')).toBeNull();
    expect(parseVoteCommand('#投票 ' + Array.from({ length: 10 }, (_, i) => `${i + 1}.选项`).join(' '))).toBeNull();
  });

  it('keeps every announcement within the configured limit', () => {
    const notices: string[] = [];
    const session = new VoteSession({ authorizedUids: ['42'] }, text => notices.push(text));
    session.ingest(message('42', '#投票60 1复联2 2法环'), now);
    session.ingest(message('10', '１１１'), now);
    session.tick(now + 10000);
    session.tick(now + 63000);
    expect(notices).toEqual(['投票60秒，发序号：1.复联2 2.法环', '剩余50秒~1.复联2:1票 2.法环:0票', '结束：1.复联2:1票 2.法环:0票 【复联2】胜~']);
    expect(notices.every(text => Array.from(text).length <= 40)).toBe(true);
  });

  it('authorizes by UID, counts first vote only, announces progress and final', () => {
    const notices: string[] = [];
    const session = new VoteSession({ authorizedUids: ['1954091502', '42'], botUid: '99' }, text => notices.push(text));
    session.ingest(message('7', '#投票 1甲 2乙'), now);
    expect(notices).toEqual([]);
    session.ingest(message('1954091502', '#投票60 1甲 2乙'), now);
    session.ingest(message('1', '1111', now + 1000), now + 1000);
    session.ingest(message('1', '2', now + 2000), now + 2000);
    session.ingest(message('2', '222', now + 3000), now + 3000);
    session.ingest(message('99', '1', now + 3000), now + 3000);
    session.ingest(message('3', '1', now - 1), now + 3000);
    session.ingest(message('42', '#投票 1丙 2丁', now + 4000), now + 4000);
    session.tick(now + 10000);
    session.tick(now + 11000);
    session.ingest(message('3', '2', now + 60001), now + 62000);
    session.ingest(message('4', '1', now + 59000), now + 62000);
    session.tick(now + 63000);
    expect(notices).toEqual([
      '投票60秒，发序号：1.甲 2.乙',
      '剩余50秒~1.甲:1票 2.乙:1票',
      '结束：1.甲:2票 2.乙:1票 【甲】胜~'
    ]);
  });

  it('ignores stale commands, permits cancellation, and rejects long announcements', () => {
    const notices: string[] = [];
    const onCancel = jest.fn();
    const session = new VoteSession({ authorizedUids: ['42'], maxMessageChars: 20 }, text => notices.push(text), onCancel);
    session.ingest(message('42', '#投票 1甲 2乙', now - 11000), now);
    expect(notices).toEqual([]);
    session.ingest(message('42', '#投票 1甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲 2乙'), now);
    expect(notices).toEqual(['格式有误，用1-9或A-I，勿重复']);
    session.ingest(message('42', '#投票 1甲 2乙'), now);
    session.ingest(message('42', '#取消投票', now + 1), now + 1);
    session.tick(now + 40000);
    expect(notices).toContain('投票已取消');
    expect(notices).not.toContain(expect.stringContaining('结束：'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('handles the reported three-option command and keeps names in all three announcement stages', () => {
    const notices: string[] = [];
    const session = new VoteSession({ authorizedUids: ['42'] }, text => notices.push(text));
    session.ingest(message('42', '#投票 1复联2 2老头环 3美队3'), now);
    session.ingest(message('10', '222', now + 100), now + 100);
    session.ingest(message('10', '3', now + 200), now + 200);
    session.ingest(message('11', '333', now + 300), now + 300);
    session.ingest(message('12', '3', now + 400), now + 400);
    session.ingest(message('13', '4', now + 500), now + 500);
    session.tick(now + 10000);
    session.tick(now + 33000);
    expect(notices).toEqual([
      '投票30秒，发序号：1.复联2 2.老头环 3.美队3',
      '剩余20秒~1.复联2:0票 2.老头环:1票 3.美队3:2票',
      '结束：1.复联2:0票 2.老头环:1票 3.美队3:2票 【美队3】胜~'
    ]);
  });

  it.each([20, 40])('packs long options without losing labels or exceeding %i characters', maxMessageChars => {
    const notices: string[] = [];
    const labels = ['甲'.repeat(16), '乙'.repeat(16), '丙'.repeat(16)];
    const session = new VoteSession({ authorizedUids: ['42'], maxMessageChars }, text => notices.push(text));
    session.ingest(message('42', '#投票 ' + labels.map((label, i) => `${i + 1}.${label}`).join(' ')), now);
    for (const label of labels) expect(notices.join('\n')).toContain(label);
    notices.length = 0;
    session.tick(now + 10000);
    for (const label of labels) expect(notices.join('\n')).toContain(label);
    session.tick(now + 33000);
    expect(notices.join('\n')).toContain('无人投票');
    expect(notices.every(text => Array.from(text).length <= maxMessageChars)).toBe(true);
  });

  it.each([20, 40])('keeps a maximum-length bracketed winner intact within %i characters', maxMessageChars => {
    const notices: string[] = [];
    const label = '甲'.repeat(16);
    const session = new VoteSession({ authorizedUids: ['42'], maxMessageChars }, text => notices.push(text));
    session.ingest(message('42', `#投票 1${label} 2乙`), now);
    session.ingest(message('10', '1', now + 100), now + 100);
    notices.length = 0;
    session.tick(now + 33000);
    expect(notices[notices.length - 1]).toBe(`${maxMessageChars === 20 ? '' : '结束：'}【${label}】胜~`);
    expect(notices.every(text => Array.from(text).length <= maxMessageChars)).toBe(true);
  });

  it('shows remaining time from the deadline and named counts, including delayed ticks', () => {
    const notices: string[] = [];
    const session = new VoteSession({ authorizedUids: ['42'] }, text => notices.push(text));
    session.ingest(message('42', '#投票 1第三集 2法环'), now);
    for (let i = 0; i < 13; i++) session.ingest(message(String(100 + i), '1', now + 100), now + 100);
    for (let i = 0; i < 10; i++) session.ingest(message(String(200 + i), '2', now + 100), now + 100);
    notices.length = 0;
    session.tick(now + 10450);
    session.tick(now + 22450);
    session.tick(now + 30000);
    expect(notices).toEqual([
      '剩余20秒~1.第三集:13票 2.法环:10票',
      '剩余8秒~1.第三集:13票 2.法环:10票'
    ]);
    session.tick(now + 33000);
    expect(notices[2]).toBe('结束：1.第三集:13票 2.法环:10票 【第三集】胜~');
  });

  it.each([
    { limit: 40, first: '甲'.repeat(12), second: '乙'.repeat(11), timed: true },
    { limit: 40, first: '甲'.repeat(12), second: '乙'.repeat(12), timed: false },
    { limit: 40, first: '🍪'.repeat(12), second: '乙'.repeat(11), timed: true },
    { limit: 20, first: '甲甲', second: '乙乙', timed: false }
  ])('adds the countdown only if the whole tally fits one $limit-character message', ({ limit, first, second, timed }) => {
    const notices: string[] = [];
    const session = new VoteSession({ authorizedUids: ['42'], maxMessageChars: limit }, text => notices.push(text));
    session.ingest(message('42', `#投票 1${first} 2${second}`), now);
    notices.length = 0;
    session.tick(now + 10000);
    expect(notices).toEqual([`${timed ? '剩余20秒~' : '票型：'}1.${first}:0票 2.${second}:0票`]);
    expect(Array.from(notices[0]).length).toBeLessThanOrEqual(limit);
  });

  it('counts repeated digits for the ninth option and reports a tie with named counts', () => {
    const notices: string[] = [];
    const session = new VoteSession({ authorizedUids: ['42'] }, text => notices.push(text));
    session.ingest(message('42', '#投票 ' + Array.from({ length: 9 }, (_, i) => `${i + 1}.选项${i + 1}`).join(' ')), now);
    session.ingest(message('8', '8888'), now);
    session.ingest(message('9', '9999'), now);
    notices.length = 0;
    session.tick(now + 33000);
    expect(notices.join(' ')).toContain('8.选项8:1票');
    expect(notices.join(' ')).toContain('9.选项9:1票');
    expect(notices.join(' ')).toContain('【选项8和选项9平票】');
    expect(notices.every(text => Array.from(text).length <= 40)).toBe(true);
  });

  it.each([false, true])('names both winners in the reported four-option tie (early=%s)', early => {
    const notices: string[] = [];
    const session = new VoteSession({ authorizedUids: ['42'] }, text => notices.push(text));
    session.ingest(message('42', '#投票 A股票喵喵 B银护 C美队3 D法环'), now);
    const counts = [26, 11, 26, 20];
    let uid = 100;
    for (const [index, count] of counts.entries()) {
      for (let i = 0; i < count; i++) session.ingest(message(String(uid++), 'ABCD'[index], now + 100), now + 100);
    }
    notices.length = 0;
    if (early) session.ingest(message('42', '#结束投票', now + 11000), now + 11000);
    else session.tick(now + 33000);
    expect(notices).toEqual([
      '结束：A.股票喵喵:26票 B.银护:11票 C.美队3:26票',
      '结束：D.法环:20票 【股票喵喵和美队3平票】'
    ]);
    expect(notices.every(text => Array.from(text).length <= 40)).toBe(true);
  });

  it.each([20, 40])('keeps all tied names when the summary exceeds %i characters', maxMessageChars => {
    const notices: string[] = [];
    const labels = ['甲'.repeat(16), '乙'.repeat(16), '丙'.repeat(16)];
    const session = new VoteSession({ authorizedUids: ['42'], maxMessageChars }, text => notices.push(text));
    session.ingest(message('42', '#投票 ' + labels.map((label, index) => `${index + 1}.${label}`).join(' ')), now);
    session.ingest(message('10', '1', now + 100), now + 100);
    session.ingest(message('11', '2', now + 100), now + 100);
    session.ingest(message('12', '3', now + 100), now + 100);
    notices.length = 0;
    session.tick(now + 33000);
    for (const label of labels) expect(notices.join(' ')).toContain(`【${label}】`);
    expect(notices.join(' ')).toContain('平票');
    expect(notices.every(text => Array.from(text).length <= maxMessageChars)).toBe(true);
  });
});
