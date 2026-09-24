import { parseVoteChoice, parseVoteCommand, VoteSession } from './VoteSession';

const now = 1790259000000;
const message = (uid: string, text: string, sentAt = now) => ({ uid, text, sentAt });

describe('live vote', () => {
  it('accepts concise and punctuated two-choice commands with bounded duration', () => {
    expect(parseVoteCommand('#投票 1.复联2 2.法环')).toEqual({ duration: 30, labels: ['复联2', '法环'] });
    expect(parseVoteCommand('#投票60 1复联2 2法环')).toEqual({ duration: 60, labels: ['复联2', '法环'] });
    expect(parseVoteCommand('#投票 60 1、甲 2、乙')).toEqual({ duration: 60, labels: ['甲', '乙'] });
    expect(parseVoteCommand('#投票999 1甲 2乙')).toBeNull();
    expect(parseVoteCommand('#投票 1甲')).toBeNull();
    expect(parseVoteChoice(' １１１１ ')).toBe(1);
    expect(parseVoteChoice('2222')).toBe(2);
    expect(parseVoteChoice('121')).toBeNull();
    expect(parseVoteChoice('2法环')).toBeNull();
  });

  it('keeps every announcement within the configured limit', () => {
    const notices: string[] = [];
    const session = new VoteSession({ authorizedUids: ['42'] }, text => notices.push(text));
    session.ingest(message('42', '#投票60 1复联2 2法环'), now);
    session.ingest(message('10', '１１１'), now);
    session.tick(now + 10000);
    session.tick(now + 63000);
    expect(notices).toEqual(['投票60秒：发1投复联2', '发2投法环', '票型 1:1票 2:0票', '结束 1:1票 2:0票 1胜']);
    expect(notices.every(text => Array.from(text).length <= 20)).toBe(true);
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
      '投票60秒：发1投甲',
      '发2投乙',
      '票型 1:1票 2:1票',
      '结束 1:2票 2:1票 1胜'
    ]);
  });

  it('ignores stale commands, permits cancellation, and rejects long announcements', () => {
    const notices: string[] = [];
    const onCancel = jest.fn();
    const session = new VoteSession({ authorizedUids: ['42'], maxMessageChars: 20 }, text => notices.push(text), onCancel);
    session.ingest(message('42', '#投票 1甲 2乙', now - 11000), now);
    expect(notices).toEqual([]);
    session.ingest(message('42', '#投票 1甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲 2乙'), now);
    expect(notices).toEqual(['投票选项太长，请缩短后重试']);
    session.ingest(message('42', '#投票 1甲 2乙'), now);
    session.ingest(message('42', '#取消投票', now + 1), now + 1);
    session.tick(now + 40000);
    expect(notices).toContain('投票已取消');
    expect(notices).not.toContain(expect.stringContaining('结束 1:'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
