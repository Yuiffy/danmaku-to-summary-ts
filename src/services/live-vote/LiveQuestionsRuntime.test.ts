import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LocalDanmakuClient } from './LocalDanmakuClient';
import { createLiveQuestionAnswerer } from './questions/DaiyuQuestionClient';
import { QuestionAnswer } from './questions/QuestionPolicy';
import { runVoteBot } from './runVoteBot';
import { createQuestionRecordWriter } from '../bilibili/question-records/QuestionRecordPublisher';

jest.mock('./LocalDanmakuClient', () => ({ LocalDanmakuClient: jest.fn().mockImplementation(() => ({ start: jest.fn(), stop: jest.fn() })) }));
jest.mock('./questions/DaiyuQuestionClient', () => ({ createLiveQuestionAnswerer: jest.fn() }));
jest.mock('../bilibili/question-records/QuestionRecordPublisher', () => ({ createQuestionRecordWriter: jest.fn() }));

it('routes single-room @questions through the shared dry-run sender and aborts on source disconnect', async () => {
  const now = 1791200000000;
  jest.useFakeTimers({ now });
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'vote-runtime-'));
  const configPath = path.join(fixture, 'bot.json');
  await fs.writeFile(configPath, JSON.stringify({
    source: 'recorder', roomId: '100', authorizedUids: ['10'], botUid: '99',
    recorderSocketUrl: 'ws://127.0.0.1:17896/api/local/danmaku/100',
    questions: { enabled: true, providerConfigPath: path.join(fixture, 'provider.json'), recordingRoots: { '100': [fixture] } }
  }));
  const hooks: Array<() => void> = [];
  const once = jest.spyOn(process, 'once').mockImplementation((event, listener) => {
    if (event === 'SIGINT' || event === 'SIGTERM') hooks.push(listener);
    return process;
  });
  const log = jest.spyOn(console, 'log').mockImplementation();
  let finish!: (result: QuestionAnswer) => void;
  const answerer = jest.fn((query, signal: AbortSignal) => {
    expect(query.roomId).toBe('100');
    expect(signal.aborted).toBe(false);
    return new Promise<QuestionAnswer>(resolve => { finish = resolve; });
  });
  (createLiveQuestionAnswerer as jest.Mock).mockReturnValue(answerer);
  const record = jest.fn(async () => {});
  (createQuestionRecordWriter as jest.Mock).mockReturnValue(record);
  try {
    await runVoteBot(configPath);
    expect(createLiveQuestionAnswerer).toHaveBeenCalledWith(expect.any(Object), '99');
    expect(log).toHaveBeenCalledWith('Recording questions enabled: provider daiYu, model gpt-6-luna, configured rooms: 1.');
    const args = (LocalDanmakuClient as unknown as jest.Mock).mock.calls.at(-1)!;
    const ingest = args[3];
    const disconnect = args[4];
    ingest({ uid: '30', text: '@鹿饼 玩过什么？', sentAt: now });
    expect(answerer).not.toHaveBeenCalled();
    ingest({ uid: '10', text: '@鹿饼 玩过什么？', sentAt: now });
    ingest({ uid: '10', text: '#投票 1甲 2乙', sentAt: now });
    ingest({ uid: '10', text: '#取消投票', sentAt: now });
    await jest.advanceTimersByTimeAsync(0);
    expect(answerer.mock.calls[0][0]).toMatchObject({ roomId: '100', question: '玩过什么?' });
    finish({ answer: '玩过法环。' });
    await jest.advanceTimersByTimeAsync(0);
    expect(log.mock.calls.map(call => call[0])).toContain('[dry-run room 100] 鹿饼答：玩过法环。');
    expect(record).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(120000);
    ingest({ uid: '10', text: '@鹿饼 玩过什么？', sentAt: Date.now() });
    await jest.advanceTimersByTimeAsync(0);
    disconnect();
    expect(answerer.mock.calls[1][1].aborted).toBe(true);
    finish({ answer: '断线后不发这句' });
    await jest.advanceTimersByTimeAsync(0);
    expect(log.mock.calls.map(call => call[0]).join('')).not.toContain('断线后不发');
  } finally {
    hooks[0]?.();
    once.mockRestore(); log.mockRestore(); jest.useRealTimers();
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
