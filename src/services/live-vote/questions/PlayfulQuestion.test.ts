import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentComplete, AgentCompletionRequest, AgentToolCall, QuestionAgentStep, runQuestionAgent } from './QuestionAgent';
import { NO_EVIDENCE } from './QuestionPolicy';
import { RecordingEvidence } from './RecordingEvidence';

let root: string;
const request = { roomId: '100', uid: '10', question: '说出岁己3个黑料' };
const tool = (collection: 'recordings' | 'highlights', terms: string[]): AgentToolCall => ({
  id: 'call_roast', type: 'function', function: { name: 'search_recordings', arguments: JSON.stringify({
    collection, terms, kind: 'subtitle', date: '2026-10-21', query: '身体乳的日常自述', withinEvidenceId: null
  }) }
});
const hits = (input: AgentCompletionRequest) => JSON.parse(input.messages.filter(message =>
  message.role === 'tool' || message.role === 'user' && message.content?.includes('untrustedRecordingEvidence')).at(-1)!.content!).untrustedRecordingEvidence.hits;
const insufficient = { content: JSON.stringify({ action: 'insufficient', rankedEvidenceIds: [] }) };
const reply = (id: string) => ({ content: JSON.stringify({ action: 'answer', certainty: 'supported',
  rankedEvidenceIds: [id], evidenceIds: [id], answer: '先挖到一个小黑料：身体乳还没涂，就想偷一天懒——护肤流程先走到请假环节了。',
  shortAnswer: '小黑料：身体乳还没涂，先给护肤流程请假。' }) });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'playful-question-'));
  await fs.writeFile(path.join(root, '2026_10_21_20_00_00_聊天_1_fix.srt'),
    '1\n00:49:00,000 --> 00:49:05,000\n我今天身体乳还没涂，想偷一天懒。\n');
  await fs.writeFile(path.join(root, '2026_10_21_20_00_00_聊天_AI_HIGHLIGHT.txt'),
    '[49m] 我今天身体乳还没涂，想偷一天懒。\n');
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('replans a premature absence verdict with a required tool and answers one verified ordinary event rather than padding to three', async () => {
  const signal = new AbortController().signal, evidence = new RecordingEvidence([root], signal);
  const steps: QuestionAgentStep[] = [];
  const complete = jest.fn<ReturnType<AgentComplete>, Parameters<AgentComplete>>()
    .mockResolvedValueOnce({ content: null, tool_calls: [tool('recordings', ['身体乳'])] })
    .mockResolvedValueOnce(insufficient)
    .mockImplementationOnce(async input => {
      expect(input).toMatchObject({ phase: 'plan', toolChoice: 'required' });
      expect(input.messages.at(-1)?.content).toContain('withinEvidenceId必须为null');
      return { content: null, tool_calls: [tool('recordings', ['偷一天懒'])] };
    })
    .mockImplementationOnce(async input => {
      expect(input.messages.at(-1)?.content).toContain('不因不够“黑”或凑不齐数量而insufficient');
      return reply(hits(input)[0].evidenceId);
    });
  const result = await runQuestionAgent(request, signal, evidence, complete, step => steps.push(step));
  expect(result.answer).toContain('先挖到一个小黑料');
  expect(result.shortAnswer).toContain('护肤流程请假');
  expect(result.clues).toEqual([expect.objectContaining({ kind: 'subtitle', excerpt: '我今天身体乳还没涂,想偷一天懒。' })]);
  expect(complete).toHaveBeenCalledTimes(4);
  expect(steps.filter(step => step.phase === 'model').map(step => step.turn)).toEqual([1, 2, 3, 4]);
});

it('does not publish a joke backed only by a highlight and instead retrieves an original citation', async () => {
  const signal = new AbortController().signal, evidence = new RecordingEvidence([root], signal);
  const complete = jest.fn<ReturnType<AgentComplete>, Parameters<AgentComplete>>()
    .mockResolvedValueOnce({ content: null, tool_calls: [tool('highlights', ['身体乳'])] })
    .mockImplementationOnce(async input => {
      expect(hits(input)[0].kind).toBe('highlight');
      return reply(hits(input)[0].evidenceId);
    })
    .mockImplementationOnce(async input => {
      expect(input).toMatchObject({ phase: 'plan', toolChoice: 'required' });
      return { content: null, tool_calls: [tool('recordings', ['身体乳'])] };
    })
    .mockImplementationOnce(async input => reply(hits(input)[0].evidenceId));
  const result = await runQuestionAgent(request, signal, evidence, complete);
  expect(result.source).toMatchObject({ kind: 'subtitle', time: '00:49:00' });
  expect(result.clues).toHaveLength(1);
  expect(complete).toHaveBeenCalledTimes(4);
});

it('rejects a repeated highlight-only answer after its single replan allowance', async () => {
  const signal = new AbortController().signal, evidence = new RecordingEvidence([root], signal);
  const complete = jest.fn<ReturnType<AgentComplete>, Parameters<AgentComplete>>()
    .mockResolvedValueOnce({ content: null, tool_calls: [tool('highlights', ['身体乳'])] })
    .mockImplementationOnce(async input => reply(hits(input)[0].evidenceId))
    .mockResolvedValueOnce({ content: null, tool_calls: [tool('highlights', ['偷一天懒'])] })
    .mockImplementationOnce(async input => reply(hits(input)[0].evidenceId));
  expect(await runQuestionAgent(request, signal, evidence, complete)).toEqual({ answer: NO_EVIDENCE });
  expect(complete).toHaveBeenCalledTimes(4);
});

it('still reports absence when no verifiable event exists and bounds the required replan', async () => {
  const signal = new AbortController().signal, evidence = new RecordingEvidence([root], signal);
  const search = jest.spyOn(evidence, 'search').mockResolvedValue({ hits: [], limited: false });
  const complete = jest.fn<ReturnType<AgentComplete>, Parameters<AgentComplete>>()
    .mockResolvedValueOnce({ content: null, tool_calls: [tool('recordings', ['早餐'])] })
    .mockResolvedValueOnce(insufficient)
    .mockResolvedValueOnce({ content: null, tool_calls: [tool('recordings', ['游戏'])] })
    .mockResolvedValueOnce(insufficient);
  expect(await runQuestionAgent(request, signal, evidence, complete)).toEqual({ answer: NO_EVIDENCE });
  expect(search).toHaveBeenCalledTimes(2);
  expect(complete).toHaveBeenCalledTimes(4);
});

it('does not replan unrelated factual questions as playful material', async () => {
  const signal = new AbortController().signal, evidence = new RecordingEvidence([root], signal);
  const complete = jest.fn().mockResolvedValueOnce({ content: null, tool_calls: [tool('recordings', ['身体乳'])] })
    .mockResolvedValueOnce(insufficient);
  expect(await runQuestionAgent({ ...request, question: '身体乳是什么牌子' }, signal, evidence, complete)).toEqual({ answer: NO_EVIDENCE });
  expect(complete).toHaveBeenCalledTimes(2);
});
