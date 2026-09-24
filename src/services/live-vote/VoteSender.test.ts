import { VoteSender } from './runVoteBot';

describe('vote sender safeguards', () => {
  it('requires explicit matching credentials for live send', () => {
    expect(() => new VoteSender('628684', '42', true, '')).toThrow('BILIBILI_VOTE_COOKIE');
    expect(() => new VoteSender('628684', '42', true, 'DedeUserID=43; SESSDATA=x; bili_jct=y'))
      .toThrow('BILIBILI_VOTE_COOKIE');
    expect(() => new VoteSender('628684', '42', true, 'DedeUserID=42; SESSDATA=x; bili_jct=y'))
      .not.toThrow();
  });

  it('does not send in dry-run and skips invalidated queued announcements', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation();
    try {
      const sender = new VoteSender('628684', '', false);
      await sender.send('投票30秒', () => false);
      expect(log).not.toHaveBeenCalled();
      await sender.send('投票30秒');
      expect(log).toHaveBeenCalledWith('[dry-run] 投票30秒');
    } finally {
      log.mockRestore();
    }
  });
});
