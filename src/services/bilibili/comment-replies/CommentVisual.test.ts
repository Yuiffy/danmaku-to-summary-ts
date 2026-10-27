import fetch from 'node-fetch';
import sharp from 'sharp';
import { createCommentAnswerer } from './CommentAgent';
import { CommentApi } from './CommentApi';
import { CommentContext } from './CommentContext';
import { CommentEvent, CommentPlatformBlocked, LIMITS } from './CommentPolicy';
import { COMMENT_IMAGE_ALLOWANCE, createCommentVisualReader, needsCommentVisual, previewCells } from './CommentVisual';

const event: CommentEvent = { key: '1:123:5', uid: '10', oid: '123', type: 1, trigger: 'mention', root: '5', parent: '5',
  text: '画面里是什么颜色', createdAt: Date.now() };
const context: CommentContext = { anchorDay: '2026-10-28', coverage: 'available', clues: [], visualTarget: { cid: '456', duration: 50 },
  video: { title: '颜色演示', description: '', content: 'subtitles', scope: 'first-page', excerpts: [{ at: 1, text: '这是一段演示' }] } };
const signal = () => new AbortController().signal;
const url = '//bimp.hdslb.com/videoshotpvhdboss/456_demo-0001.jpg';
const shots = () => ({ img_x_len: 3, img_y_len: 2, img_x_size: 40, img_y_size: 30,
  image: [url], index: [0, 10, 20, 30, 40, 49] });

test('routes only visual requests or subtitle-missing target overviews, preserving cheap text questions', () => {
  expect(needsCommentVisual(event, context)).toBe(true);
  expect(needsCommentVisual({ ...event, text: '这个插件耗token多吗' }, context)).toBe(false);
  expect(needsCommentVisual({ ...event, text: '总结这个视频' })).toBe(true);
  expect(needsCommentVisual({ ...event, text: '来看看' })).toBe(true);
  for (const text of ['你好', '你会做什么', '上次小岁联动的原话在哪里', '总结小岁上次联动', '分析矩阵乘法']) expect(needsCommentVisual({ ...event, text })).toBe(false);
  expect(needsCommentVisual({ ...event, type: 17 })).toBe(false);
  expect(needsCommentVisual({ ...event, trigger: 'reply' })).toBe(false);
});

test.each([
  { image: ['https://127.0.0.1/456_demo.jpg'] }, { image: ['https://bimp.hdslb.com.evil.test/videoshotpvhdboss/456_a.jpg'] },
  { image: ['//bimp.hdslb.com/videoshotpvhdboss/999_a.jpg'] }, { image: ['http://bimp.hdslb.com/videoshotpvhdboss/456_a.jpg'] },
  { index: [0, 51] }, { index: [10, 0] }, { img_x_size: 9000 }, { index: [] }, { index: [NaN] }
])('rejects invalid remote assets or timelines before fetching: %j', change => {
  expect(() => previewCells({ ...shots(), ...change }, context.visualTarget!)).toThrow();
});

test('long timelines use at most two sprites and retain the actual first/last preview timestamps', () => {
  const cells = previewCells({ ...shots(), image: Array.from({ length: 5 }, (_, i) => url.replace('0001', String(i))),
    index: Array.from({ length: 30 }, (_, i) => i) }, context.visualTarget!);
  expect(new Set(cells.map(cell => cell.url)).size).toBe(2);
  expect(cells.map(cell => cell.at)).toEqual([0, 2, 4, 25, 27, 29]);
});

test('downloads once without credentials, crops a bounded sheet and expires its memory cache', async () => {
  const bytes = await sharp({ create: { width: 120, height: 60, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const transport = jest.fn().mockResolvedValue({ ok: true, buffer: async () => bytes });
  let now = 0;
  const io = { target: jest.fn().mockResolvedValue(context.visualTarget), shots: jest.fn().mockResolvedValue(shots()), now: () => now };
  const read = createCommentVisualReader(io, transport as unknown as typeof fetch);
  const preview = await read(event, signal());
  expect(preview!.times).toEqual([0, 10, 20, 30, 40, 49]);
  expect(await sharp(preview!.jpeg).metadata()).toMatchObject({ width: 504, height: 220, format: 'jpeg' });
  expect(preview!.jpeg.length).toBeLessThanOrEqual(96 * 1024);
  expect(transport.mock.calls[0][1]).toMatchObject({ redirect: 'error', size: 2 * 1024 * 1024, timeout: 2000 });
  expect(transport.mock.calls[0][1].headers.Cookie).toBeUndefined();
  expect(await read(event, signal())).toBe(preview);
  expect(transport).toHaveBeenCalledTimes(1);
  now = 60001; await read(event, signal()); expect(transport).toHaveBeenCalledTimes(2);
});

function fixture(evidence: CommentContext | undefined = context, failure?: Error, feedback = false) {
  const transport = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: {
    content: feedback ? '{"reply":"抽样画面里主要是红色。","feedback":null}' : '抽样画面里主要是红色。' } }] }) });
  const visual = jest.fn().mockImplementation(async () => { if (failure) throw failure; return { jpeg: Buffer.from('fixture'), times: [0, 49] }; });
  const answer = createCommentAnswerer({ url: 'https://provider.invalid', apiKey: 'secret' }, transport as unknown as typeof fetch,
    async () => evidence, { config: { botUid: '99', ...(feedback ? { feedbackOwnerUids: ['99'] } : {}) } as any,
      hotComments: async () => [] }, visual);
  return { answer, transport, visual };
}

test('one existing answer call contains one low-detail image, with explicit timestamps and the same reservation', async () => {
  const { answer, transport, visual } = fixture();
  await expect(answer(event.text, signal(), event)).resolves.toContain('红色');
  expect(visual).toHaveBeenCalledWith(event, expect.anything(), context.visualTarget);
  expect(transport).toHaveBeenCalledTimes(1);
  const request = JSON.parse(transport.mock.calls[0][1].body);
  const content = request.messages[1].content;
  expect(content.filter((item: any) => item.type === 'image_url')).toHaveLength(1);
  expect(content[2].image_url.detail).toBe('low');
  expect(JSON.parse(content[1].text)).toEqual({ visualPreviewSeconds: [0, 49] });
  expect(content[0].text).not.toContain('visualTarget');
  const textual = [request.messages[0], { role: 'user', content: content[0].text }];
  expect(Buffer.byteLength(JSON.stringify(textual)) + Buffer.byteLength(content[1].text) + COMMENT_IMAGE_ALLOWANCE + LIMITS.outputTokens + 256)
    .toBeLessThanOrEqual(LIMITS.tokenReservation);
});

test('subtitle-sufficient cost questions never call the image adapter', async () => {
  const { answer, visual, transport } = fixture();
  const request = { ...event, text: '这个插件耗token多吗' };
  await answer(request.text, signal(), request);
  expect(visual).not.toHaveBeenCalled();
  expect(typeof JSON.parse(transport.mock.calls[0][1].body).messages[1].content).toBe('string');
});

test('missing subtitles with pictures uses an honest sampled-picture disclosure', async () => {
  const { answer } = fixture({ ...context, video: { ...context.video!, excerpts: [], content: 'unavailable' } });
  await expect(answer(event.text, signal(), event)).resolves.toMatch(/^没获取到字幕，以下仅据抽样预览画面。/u);
});

test('ordinary preview failure degrades to text without provider retries; risk blocks stop generation', async () => {
  const failed = fixture({ ...context, video: { ...context.video!, excerpts: [], content: 'unavailable' } }, new Error('preview unavailable'));
  const request = { ...event, text: '总结视频画面' };
  await expect(failed.answer(request.text, signal(), request)).resolves.toMatch(/^没获取到这个视频的字幕，我看不到视频内容。/u);
  expect(failed.transport).toHaveBeenCalledTimes(1);
  const blocked = fixture(context, new CommentPlatformBlocked('blocked'));
  await expect(blocked.answer(event.text, signal(), event)).rejects.toBeInstanceOf(CommentPlatformBlocked);
  expect(blocked.transport).not.toHaveBeenCalled();
});

test('preview catalogue uses only fixed authenticated aid/cid API and propagates platform risk', async () => {
  const transport = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: shots() }) });
  const api = new CommentApi('99', () => 'DedeUserID=99; SESSDATA=session; bili_jct=csrf', transport as unknown as typeof fetch);
  await expect(api.videoShots('123', '456', signal())).resolves.toEqual(shots());
  expect(transport.mock.calls[0][0]).toBe('https://api.bilibili.com/x/player/videoshot?aid=123&cid=456&index=1');
  expect(transport.mock.calls[0][1]).toMatchObject({ redirect: 'error', size: 1024 * 1024, timeout: 3000 });
  await expect(api.videoShots('https://evil.test', '456', signal())).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(1);
  transport.mockResolvedValueOnce({ status: 401 });
  await expect(api.videoShots('123', '456', signal())).rejects.toBeInstanceOf(CommentPlatformBlocked);
});

test('own-video feedback keeps its existing structured single call with a visual attachment', async () => {
  const { answer, transport } = fixture({ ...context, videoOwnerUid: '99' }, undefined, true);
  await expect(answer(event.text, signal(), event)).resolves.toContain('红色');
  expect(transport).toHaveBeenCalledTimes(1);
  expect(JSON.parse(transport.mock.calls[0][1].body).messages[0].content).toContain('输出JSON');
});
