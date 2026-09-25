import { parseVoteChoice, parseVoteCommand, VoteSession } from './VoteSession';

const now = 1790259000000;
const message = (uid: string, text: string, sentAt = now) => ({ uid, text, sentAt });

describe('live vote', () => {
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
      '结束：1.复联2:0票 2.老头环:0票 3.美队3:1票 美队3胜'
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
    expect(parseVoteCommand('#投票 1.复联2 2.法环')).toEqual({ duration: 30, labels: ['复联2', '法环'] });
    expect(parseVoteCommand('#投票60 1复联2 2法环')).toEqual({ duration: 60, labels: ['复联2', '法环'] });
    expect(parseVoteCommand('#投票 60 1、甲 2、乙')).toEqual({ duration: 60, labels: ['甲', '乙'] });
    expect(parseVoteCommand('#投票 1复联2 2老头环 3美队3')).toEqual({ duration: 30, labels: ['复联2', '老头环', '美队3'] });
    expect(parseVoteCommand('#投票 1.2048 2.法环')).toEqual({ duration: 30, labels: ['2048', '法环'] });
    expect(parseVoteCommand('#投票999 1甲 2乙')).toBeNull();
    expect(parseVoteCommand('#投票 1甲')).toBeNull();
    expect(parseVoteChoice(' １１１１ ')).toBe(1);
    expect(parseVoteChoice('2222')).toBe(2);
    expect(parseVoteChoice('121')).toBeNull();
    expect(parseVoteChoice('2法环')).toBeNull();
    expect(parseVoteChoice('３３３', 3)).toBe(3);
    expect(parseVoteChoice('333', 2)).toBeNull();
    expect(parseVoteChoice('444', 3)).toBeNull();
    expect(parseVoteCommand('#投票 1甲 3乙')).toBeNull();
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
    expect(notices).toEqual(['投票60秒，发序号：1.复联2 2.法环', '票型：1.复联2:1票 2.法环:0票', '结束：1.复联2:1票 2.法环:0票 复联2胜']);
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
      '票型：1.甲:1票 2.乙:1票',
      '结束：1.甲:2票 2.乙:1票 甲胜'
    ]);
  });

  it('ignores stale commands, permits cancellation, and rejects long announcements', () => {
    const notices: string[] = [];
    const onCancel = jest.fn();
    const session = new VoteSession({ authorizedUids: ['42'], maxMessageChars: 20 }, text => notices.push(text), onCancel);
    session.ingest(message('42', '#投票 1甲 2乙', now - 11000), now);
    expect(notices).toEqual([]);
    session.ingest(message('42', '#投票 1甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲 2乙'), now);
    expect(notices).toEqual(['投票格式有误，请连续编号1至9']);
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
      '票型：1.复联2:0票 2.老头环:1票 3.美队3:2票',
      '结束：1.复联2:0票 2.老头环:1票 3.美队3:2票 美队3胜'
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
    expect(notices.join(' ')).toContain('平票');
    expect(notices.every(text => Array.from(text).length <= 40)).toBe(true);
  });
});
