import fetch from 'node-fetch';
import { createCommentAnswerer } from './CommentAgent';
import { CommentAgentSources, runCommentModel } from './CommentAgentTools';
import { CommentEvent, CommentPlatformBlocked, COMMENT_TOOL_LIMITS } from './CommentPolicy';
import { commentReplyMode } from './CommentReplyStyle';
import { needsCommentEvidence, videoOnlyQuestion } from './CommentContext';

const settings = { url: 'https://provider.invalid', apiKey: 'private-model-key' };
const signal = () => new AbortController().signal;
const response = (content: unknown, tool_calls?: unknown[]) => ({ ok: true, json: async () => ({ choices: [
  { finish_reason: tool_calls ? 'tool_calls' : 'stop', message: { content, ...(tool_calls ? { tool_calls } : {}) } }
] }) });
const call = (name: string, args: unknown, id = 'call_1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const event: CommentEvent = { key: '1:123:5', uid: '10', oid: '123', type: 1, trigger: 'mention', root: '5', parent: '5',
  text: '@鹿饼Shikamochi 来学一下', createdAt: Date.parse('2026-10-28T12:00:00+08:00') };
function sources() {
  const read = jest.fn(async () => [{ source: 'clipping', label: '切片能力', kind: 'guide', revision: 'abcd1234',
    text: '已有带时间映射的抽帧和字幕边界审核,外部场景自适应拼图仍待评估。' }]);
  return { projects: { catalog: [{ id: 'clipping', label: '切片能力', kind: 'guide' }], read },
    video: jest.fn(async () => ({ title: '用场景检测做拼图', description: '', publishedAt: event.createdAt,
      transcript: { language: 'zh', partial: false, cues: [{ at: 10, text: '场景变化时多取帧,拼成总览图,降低重复画面输入。' }] } })),
    report: jest.fn() } as unknown as CommentAgentSources;
}

test.each(['@鹿饼Shikamochi 来学一下', '@鹿饼Shikamochi 学习一下', '@鹿饼Shikamochi 看看这个咋样'])(
  'short real mentions %s acquire current-video evidence rather than chat', text => {
    expect(needsCommentEvidence(text, 1)).toBe(true); expect(videoOnlyQuestion(text)).toBe(true);
    if (text.includes('学')) expect(commentReplyMode(text, 1)).toBe('project');
  });

test('model chooses video then public project by ID and receives both before producing a comparison', async () => {
  const io = sources(), answer = '值得吸收的是按场景变化调整采样；我们已有抽帧、时间映射和字幕边界审核，新增价值在减少重复帧，同时保住短促事件。拼图不能代替原音校对。建议固定同一段素材和模型，对比漏检率、耗时与实际用量，再决定接入。';
  const transport = jest.fn().mockResolvedValueOnce(response(null, [call('read_current_video', { focus: '场景采样技术' })]))
    .mockResolvedValueOnce(response(null, [call('read_project', { sourceIds: ['clipping'] }, 'call_2')]))
    .mockResolvedValueOnce(response(answer));
  const reply = createCommentAnswerer(settings, transport as unknown as typeof fetch, undefined, undefined, undefined, () => io);
  await expect(reply(event.text, signal(), event)).resolves.toMatchObject({ reply: answer, tokens: expect.any(Number) });
  expect(io.video).toHaveBeenCalledTimes(1); expect(io.projects!.read).toHaveBeenCalledWith(['clipping'], expect.any(AbortSignal));
  const bodies = transport.mock.calls.map(([, options]) => JSON.parse(options.body));
  expect(bodies[0].tools.map((tool: any) => tool.function.name)).toEqual(['read_current_video', 'read_project']);
  expect(bodies[0].messages[0].content).toContain('真正新增部分');
  expect(bodies[2].tool_choice).toBe('none');
  expect(JSON.stringify(bodies[2].messages)).toContain('场景变化时多取帧');
  expect(JSON.stringify(bodies[2].messages)).toContain('外部场景自适应拼图仍待评估');
  expect(JSON.stringify(bodies)).not.toContain(settings.apiKey);
  expect(io.report).toHaveBeenCalledWith(expect.objectContaining({ event: 'comment_agent_tool', name: 'read_project', status: 'ok' }));
});

test('ordinary entertainment can finish directly without reading unrelated project files', async () => {
  const io = sources(), transport = jest.fn().mockResolvedValue(response('猫咪一脸认真,反差挺好笑。'));
  await runCommentModel(settings, transport as unknown as typeof fetch, [{ role: 'user', content: '看看这个咋样' }], signal(), io);
  expect(io.video).not.toHaveBeenCalled(); expect(io.projects!.read).not.toHaveBeenCalled();
  expect(transport).toHaveBeenCalledTimes(1);
});

test('a model-selected video read supplies preview frames for an unclassified invitation without captions', async () => {
  const invitation = { ...event, text: '@鹿饼Shikamochi 你来回复一下' };
  const io = sources();
  (io.video as jest.Mock).mockResolvedValue({ title: '当前视频', description: '', publishedAt: event.createdAt,
    visualTarget: { cid: '456', duration: 58 } });
  const visual = jest.fn(async () => ({ jpeg: Buffer.from('preview-fixture'), times: [0, 30, 55] }));
  const transport = jest.fn().mockResolvedValueOnce(response(null, [call('read_current_video', { focus: '当前视频的内容和笑点' })]))
    .mockResolvedValueOnce(response('画面中的字幕前后反差挺逗。'));
  const reply = createCommentAnswerer(settings, transport as unknown as typeof fetch, undefined, undefined, visual, () => io);
  await expect(reply(invitation.text, signal(), invitation)).resolves.toMatchObject({ reply:
    '没获取到字幕，以下仅据抽样预览画面。画面中的字幕前后反差挺逗。' });
  expect(visual).toHaveBeenCalledTimes(1);
  expect(visual).toHaveBeenCalledWith(invitation, expect.any(AbortSignal), { cid: '456', duration: 58 });
  const initial = JSON.parse(transport.mock.calls[0][1].body);
  expect(initial.messages[0].content).toContain('你来回复一下');
  expect(initial.messages[0].content).toContain('read_current_video');
  const next = JSON.parse(transport.mock.calls[1][1].body);
  expect(next.messages).toContainEqual(expect.objectContaining({ role: 'user', content: expect.arrayContaining([
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from('preview-fixture').toString('base64')}`, detail: 'low' } }
  ]) }));
  expect(JSON.stringify(next.messages)).toContain('visualPreviewSeconds');
  expect(io.report).toHaveBeenCalledWith(expect.objectContaining({ event: 'comment_agent_tool', name: 'read_current_video',
    subtitles: false, preview: true }));
});

test('a generic invitation with model-selected subtitles has content and no missing-content disclaimer', async () => {
  const invitation = { ...event, text: '@鹿饼Shikamochi 你来回复一下' }, io = sources();
  const visual = jest.fn(), transport = jest.fn()
    .mockResolvedValueOnce(response(null, [call('read_current_video', { focus: '视频内容' })]))
    .mockResolvedValueOnce(response('这里用场景变化调整取帧数量，关键是减少重复画面。'));
  const reply = createCommentAnswerer(settings, transport as unknown as typeof fetch, undefined, undefined, visual, () => io);
  await expect(reply(invitation.text, signal(), invitation)).resolves.toMatchObject({ reply: '这里用场景变化调整取帧数量，关键是减少重复画面。' });
  expect(visual).not.toHaveBeenCalled();
  expect(JSON.stringify(JSON.parse(transport.mock.calls[1][1].body).messages)).toContain('场景变化时多取帧');
});

test('a short video tool read retains the complete available transcript when it fits the evidence budget', async () => {
  const io = sources(), cues = Array.from({ length: 25 }, (_, at) => ({ at, text: `连续原句第${at}行` }));
  (io.video as jest.Mock).mockResolvedValue({ title: '短视频', description: '', publishedAt: event.createdAt,
    transcript: { language: 'zh', partial: false, cues } });
  const transport = jest.fn().mockResolvedValueOnce(response(null, [call('read_current_video', { focus: '内容和反差' })]))
    .mockResolvedValueOnce(response('关键是铺垫与后续选择形成反差。'));
  const result = await runCommentModel(settings, transport as unknown as typeof fetch, [], signal(), io, event);
  expect(result.video?.excerpts).toEqual(cues); expect(result.video?.sampled).toBe(false);
});

test('a failed tool preview retains metadata and reports its evidence gap; platform blocks propagate', async () => {
  const invitation = { ...event, text: '@鹿饼Shikamochi 你来回复一下' }, io = sources();
  (io.video as jest.Mock).mockResolvedValue({ title: '当前视频', description: '作者简介', publishedAt: event.createdAt });
  const visual = jest.fn().mockRejectedValue(new Error('private-path'));
  const transport = jest.fn().mockResolvedValueOnce(response(null, [call('read_current_video', { focus: '视频内容' })]))
    .mockResolvedValueOnce(response('这次只能取得作者简介，不能据此复述具体台词。'));
  const reply = createCommentAnswerer(settings, transport as unknown as typeof fetch, undefined, undefined, visual, () => io);
  await expect(reply(invitation.text, signal(), invitation)).resolves.toMatchObject({ reply: expect.stringContaining('没获取到这个视频的字幕') });
  const next = transport.mock.calls[1][1].body;
  expect(next).toContain('作者简介'); expect(next).not.toContain('private-path');
  expect(io.report).toHaveBeenCalledWith(expect.objectContaining({ event: 'comment_agent_tool', preview: false }));
  visual.mockRejectedValueOnce(new CommentPlatformBlocked());
  transport.mockResolvedValueOnce(response(null, [call('read_current_video', { focus: '视频内容' })]));
  await expect(reply(invitation.text, signal(), invitation)).rejects.toBeInstanceOf(CommentPlatformBlocked);
});

test('missing subtitles still permit a qualified technical comparison using the author description and public baseline', async () => {
  const io = sources(), transport = jest.fn()
    .mockResolvedValueOnce(response(null, [call('read_project', { sourceIds: ['clipping'] })]))
    .mockResolvedValueOnce(response('作者说明它依赖平台字幕,只做到粗剪；我们已有字幕边界审核,可借鉴交互方式,不能替代原音校对。'));
  const reply = createCommentAnswerer(settings, transport as unknown as typeof fetch,
    async () => ({ anchorDay: '2026-10-28', clues: [], coverage: 'unavailable', video: {
      title: '杂谈粗剪工具', description: '只适用于有平台自动字幕的视频,输出到粗剪。', content: 'unavailable' } }),
    undefined, undefined, () => io);
  await expect(reply(event.text, signal(), event)).resolves.toMatchObject({ reply:
    '未取到视频字幕，以下据作者简介与项目资料对比。作者说明它依赖平台字幕,只做到粗剪；我们已有字幕边界审核,可借鉴交互方式,不能替代原音校对。', tokens: expect.any(Number) });
});

test('tool failures are visible to the model, while platform blocks escape and pause the worker', async () => {
  const io = sources(); (io.video as jest.Mock).mockRejectedValueOnce(new Error('private path'));
  const transport = jest.fn().mockResolvedValueOnce(response(null, [call('read_current_video', { focus: '技术' })]))
    .mockResolvedValueOnce(response('关键字幕未取得,暂时无法判断是否适合。'));
  await runCommentModel(settings, transport as unknown as typeof fetch, [], signal(), io);
  expect(transport.mock.calls[1][1].body).toContain('工具未取得可靠资料');
  expect(transport.mock.calls[1][1].body).not.toContain('private path');
  (io.video as jest.Mock).mockRejectedValueOnce(new CommentPlatformBlocked());
  transport.mockResolvedValueOnce(response(null, [call('read_current_video', { focus: '技术' })]));
  const reply = createCommentAnswerer(settings, transport as unknown as typeof fetch, undefined, undefined, undefined, () => io);
  await expect(reply(event.text, signal(), event)).rejects.toBeInstanceOf(CommentPlatformBlocked);
});

test('arbitrary tools, parallel calls and tool calls after the final turn never execute', async () => {
  const io = sources();
  for (const calls of [[call('shell', { cmd: 'private' })], [call('read_project', {}), call('read_current_video', {})]]) {
    const transport = jest.fn().mockResolvedValue(response(null, calls));
    await expect(runCommentModel(settings, transport as unknown as typeof fetch, [], signal(), io)).rejects.toThrow();
  }
  const transport = jest.fn().mockResolvedValue(response(null, [call('read_current_video', { focus: '技术' })]));
  await expect(runCommentModel(settings, transport as unknown as typeof fetch, [], signal(), io)).rejects.toThrow('tool calls');
  expect(transport).toHaveBeenCalledTimes(COMMENT_TOOL_LIMITS.turns);
  expect(io.video).toHaveBeenCalledTimes(1);
});

test('aggregate reservation is enforced before another provider call and cancellation is propagated', async () => {
  const transport = jest.fn();
  await expect(runCommentModel(settings, transport as unknown as typeof fetch, [{ role: 'user', content: '字'.repeat(30000) }],
    signal(), sources())).rejects.toThrow('budget');
  expect(transport).not.toHaveBeenCalled();
  const controller = new AbortController(); controller.abort();
  await expect(runCommentModel(settings, transport as unknown as typeof fetch, [], controller.signal, sources())).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

test('successful model usage is summed across tool turns, while missing usage uses a conservative estimate', async () => {
  const io = sources();
  const transport = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ usage: { total_tokens: 100 },
    choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [call('read_project', { sourceIds: ['clipping'] })] } }] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ usage: { total_tokens: 200 },
      choices: [{ finish_reason: 'stop', message: { content: '值得评估交互效率,不能替代字幕审核。' } }] }) });
  await expect(runCommentModel(settings, transport as unknown as typeof fetch, [], signal(), io)).resolves.toMatchObject({ tokens: 300 });
  transport.mockResolvedValueOnce(response('资料不足,暂不建议替换。'));
  const result = await runCommentModel(settings, transport as unknown as typeof fetch, [], signal(), io);
  expect(result.tokens).toBeGreaterThan(200); expect(result.tokens).toBeLessThanOrEqual(COMMENT_TOOL_LIMITS.tokenReservation);
});
