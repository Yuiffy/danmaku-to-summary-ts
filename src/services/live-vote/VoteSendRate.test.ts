import fetch from 'node-fetch';
import { VoteSender } from './runVoteBot';

jest.mock('node-fetch', () => jest.fn());

it('shares the send interval across rooms and skips a queued send if its room becomes invalid', async () => {
  jest.useFakeTimers({ now: 1000000 });
  const log = jest.spyOn(console, 'log').mockImplementation();
  const request = fetch as jest.MockedFunction<typeof fetch>;
  request.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0 }) } as any);
  const cookie = 'DedeUserID=99; SESSDATA=test; bili_jct=test';
  const clock = { lastSentAt: 0 };
  try {
    const a = new VoteSender('100', '99', true, cookie, clock);
    const b = new VoteSender('200', '99', true, cookie, clock);
    await a.send('start');
    const second = b.send('start');
    await jest.advanceTimersByTimeAsync(2999);
    expect(request).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await second;
    expect(request).toHaveBeenCalledTimes(2);
    let current = true;
    const cancelled = a.send('obsolete', () => current);
    current = false;
    await jest.advanceTimersByTimeAsync(3000);
    await cancelled;
    expect(request).toHaveBeenCalledTimes(2);
  } finally { log.mockRestore(); jest.useRealTimers(); }
});
