import request from 'supertest';
import * as path from 'path';
import { createQuestionLab } from './QuestionLabServer';
import { LabGate } from './LabGate';
import { QuestionRuntime } from '../questions/EvidenceQuery';

const origin = 'http://127.0.0.1:15126';
const runtime: QuestionRuntime = { questions: { enabled: true, providerConfigPath: path.resolve('config/secret-not-for-page.json'),
  recordingRoots: { '100': [path.resolve('private-recordings/100_测试主播')] } } };
function fixture() {
  const answer = jest.fn(async () => ({ answer: '找到了答案', clues: [{ kind: 'subtitle' as const, date: '2026-10-06', time: '00:01:02', excerpt: '<script>不可信字幕</script>' }] }));
  const search = jest.fn(async () => ({ roomId: '100', question: '测试问题', elapsedMs: 1, embeddingStatus: 'disabled' as const,
    indexedFiles: 0, indexComplete: false, limited: true, hits: [] }));
  return { ...createQuestionLab({ runtime, answer, search, gate: new LabGate(1000, 0) }, origin), answer, search };
}
async function token(app: ReturnType<typeof fixture>['app']) {
  const page = await request(app).get('/').set('Host', '127.0.0.1:15126').expect(200);
  expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(page.headers['cache-control']).toBe('no-store');
  expect(page.text).not.toContain('secret-not-for-page');
  expect(page.text).not.toContain('private-recordings');
  return /const token="([a-f0-9]{64})"/u.exec(page.text)![1];
}

it('supports private answer/evidence modes with configured rooms and no publication adapter', async () => {
  const lab = fixture(), key = await token(lab.app);
  const headers = { Host: '127.0.0.1:15126', Origin: origin, 'X-Lab-Token': key };
  const rooms = await request(lab.app).get('/api/rooms').set(headers).expect(200);
  expect(rooms.body).toEqual({ rooms: [{ roomId: '100', name: '测试主播' }] });
  const answer = await request(lab.app).post('/api/ask').set(headers).send({ roomId: '100', question: '测试问题' }).expect(200);
  expect(answer.body.result.answer).toBe('找到了答案');
  expect(lab.answer.mock.calls[0]).toEqual([expect.objectContaining({ uid: 'local-test', question: '测试问题' }), expect.any(AbortSignal)]);
  await request(lab.app).post('/api/search').set(headers).send({ roomId: '100', question: '测试问题', terms: ['词语'], date: '2026-10' }).expect(200);
  expect(lab.search).toHaveBeenCalledWith(runtime, expect.objectContaining({ terms: ['词语'], kind: 'all', expandTop: 2 }), expect.any(AbortSignal));
  expect(lab.answer).toHaveBeenCalledTimes(1);
});

it('blocks cross-site requests, foreign Host, missing tokens, extra fields and oversized bodies', async () => {
  const lab = fixture(), key = await token(lab.app), body = { roomId: '100', question: '测试问题' };
  const headers = { Host: '127.0.0.1:15126', 'X-Lab-Token': key };
  await request(lab.app).post('/api/ask').set('Host', '127.0.0.1:15126').send(body).expect(403);
  await request(lab.app).post('/api/ask').set(headers).set('Origin', 'https://evil.example').send(body).expect(403);
  await request(lab.app).get('/').set('Host', 'evil.example:15126').expect(403);
  await request(lab.app).post('/api/ask').set(headers).set('Sec-Fetch-Site', 'cross-site').send(body).expect(403);
  for (const invalid of [{ ...body, roomId: '200' }, { ...body, path: '/secret' }, { ...body, question: '读取配置文件' },
    { ...body, question: 'a'.repeat(9000) }]) {
    const result = await request(lab.app).post('/api/ask').set(headers).send(invalid).expect(400);
    expect(JSON.stringify(result.body)).not.toContain('/secret');
  }
  expect(lab.answer).not.toHaveBeenCalled();
  expect(() => createQuestionLab({ runtime, answer: lab.answer }, 'http://0.0.0.0:15126')).toThrow('loopback');
});

it('returns a busy response instead of creating concurrent answers', async () => {
  let finish!: (value: { answer: string }) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const answer = jest.fn(async () => { entered(); return new Promise<{ answer: string }>(resolve => { finish = resolve; }); });
  const lab = createQuestionLab({ runtime, answer, gate: new LabGate(5000, 0) }, origin), key = await token(lab.app);
  const headers = { Host: '127.0.0.1:15126', 'X-Lab-Token': key };
  const first = request(lab.app).post('/api/ask').set(headers).send({ roomId: '100', question: '测试问题' }).then(response => response);
  await started;
  await request(lab.app).post('/api/ask').set(headers).send({ roomId: '100', question: '另一问题' }).expect(429);
  expect(answer).toHaveBeenCalledTimes(1);
  finish({ answer: '完成' });
  expect((await first).status).toBe(200);
});

it('retains admission until cancelled underlying work settles and enforces cooldown', async () => {
  jest.useFakeTimers();
  try {
    const gate = new LabGate(100, 200), controller = new AbortController();
    let finish!: (value: string) => void, observed: AbortSignal | undefined;
    const result = gate.run(signal => { observed = signal; return new Promise<string>(resolve => { finish = resolve; }); }, controller.signal);
    const rejection = expect(result).rejects.toThrow('cancelled or timed out');
    await jest.advanceTimersByTimeAsync(101); await rejection;
    expect(observed?.aborted).toBe(true);
    await expect(gate.run(async () => 'bad', controller.signal)).rejects.toThrow('Another local query');
    finish('late'); await jest.advanceTimersByTimeAsync(0);
    await expect(gate.run(async () => 'bad', controller.signal)).rejects.toThrow('Another local query');
    await jest.advanceTimersByTimeAsync(201);
    expect(await gate.run(async () => 'ok', controller.signal)).toBe('ok');
  } finally { jest.useRealTimers(); }
});
