import express, { Express, NextFunction, Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import { QuestionAnswerer } from '../questions/QuestionPolicy';
import { parseEvidenceQuery, queryRecordingEvidence, questionRooms, QuestionRuntime, validateLabQuestion } from '../questions/EvidenceQuery';
import { LabBusy, LabGate } from './LabGate';
import { questionLabPage } from './QuestionLabPage';

export interface LabAdapters {
  runtime: QuestionRuntime;
  answer: QuestionAnswerer;
  search?: typeof queryRecordingEvidence;
  gate?: LabGate;
}

/** Loopback-only HTTP composition. Contains no Bilibili send or publication capability. */
export function createQuestionLab(adapters: LabAdapters, origin: string): { app: Express; stop: () => void } {
  const app = express(), gate = adapters.gate || new LabGate(), token = randomBytes(32).toString('hex');
  app.disable('x-powered-by');
  const address = new URL(origin);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1') throw new Error('Question lab requires loopback origin');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (req.headers.host !== address.host || req.headers.origin && req.headers.origin !== origin ||
      req.headers['sec-fetch-site'] === 'cross-site') { res.status(403).json({ error: '仅允许本机页面访问。' }); return; }
    next();
  });
  app.get('/', (_req, res) => {
    const nonce = randomBytes(18).toString('base64');
    res.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    res.type('html').send(questionLabPage(nonce, token));
  });
  app.get('/favicon.ico', (_req, res) => { res.status(204).end(); });
  app.use('/api', (req, res, next) => {
    const supplied = req.headers['x-lab-token'];
    if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/u.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
      res.status(403).json({ error: '请从本机问答页面发起查询。' }); return;
    }
    next();
  });
  app.get('/api/rooms', (_req, res) => { res.json({ rooms: questionRooms(adapters.runtime) }); });
  app.use(express.json({ limit: '8kb', strict: true }));
  const query = (mode: 'ask' | 'search') => async (req: Request, res: Response) => {
    let input;
    try {
      if (!req.is('application/json')) throw new Error('JSON required');
      if (mode === 'ask') {
        if (Object.keys(req.body || {}).some(key => !['roomId', 'question'].includes(key))) throw new Error('Unknown field');
        input = validateLabQuestion(req.body, adapters.runtime.questions);
      } else input = parseEvidenceQuery(req.body, adapters.runtime.questions);
    } catch { res.status(400).json({ error: '请检查直播间、问题和检索条件；不接受路径、命令或凭据请求。' }); return; }
    const controller = new AbortController(), started = Date.now();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnect);
    try {
      const result = await gate.run<unknown>(signal => mode === 'ask' ?
        adapters.answer({ roomId: input.roomId, question: input.question, uid: 'local-test', askedAt: Date.now() }, signal) :
        (adapters.search || queryRecordingEvidence)(adapters.runtime, parseEvidenceQuery(input, adapters.runtime.questions), signal), controller.signal);
      if (!res.destroyed) res.json(mode === 'ask' ? { result, elapsedMs: Date.now() - started } : result);
    } catch (error) {
      if (!res.destroyed) res.status(error instanceof LabBusy ? 429 : 503).json({
        error: error instanceof LabBusy ? '正在处理其他测试问题，请稍后再试。' : '查询超时、已取消或服务暂不可用，请稍后再试。'
      });
    } finally { res.off('close', disconnect); }
  };
  app.post('/api/ask', query('ask'));
  app.post('/api/search', query('search'));
  app.use((_req, res) => { res.status(404).json({ error: '未找到此入口。' }); });
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next; // Express recognizes error handlers by their four-argument signature.
    res.status(400).json({ error: '请求格式不正确或内容过长。' });
  });
  return { app, stop: () => gate.stop() };
}
