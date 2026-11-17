import { parseQQArgs, sendQQReply, sendQQRejectionNotice } from './run';
import type { QQRequest } from '../../services/qqbot/QQPolicy';
import { QQSendRejectedError } from '../../services/qqbot/QQSendReceipt';
import { newQQState } from '../../services/qqbot/QQState';
import { QQ_LIMITS } from '../../services/qqbot/QQPolicy';

test('defaults to read-only validation and requires an explicit live mode', () => {
  expect(parseQQArgs([]).mode).toBe('check');
  expect(parseQQArgs(['--live']).mode).toBe('live');
  expect(() => parseQQArgs(['--live', '--resume'])).toThrow();
  expect(() => parseQQArgs(['--config'])).toThrow();
  expect(() => parseQQArgs(['--model', 'other'])).toThrow();
});

test('long text is sent in paced native replies with the original message binding on every part', async () => {
  const send = jest.fn(async () => ({ id: 'receipt' })), pace = jest.fn(async () => {});
  await sendQQReply({ send, uploadMedia: jest.fn() } as any, request, '景'.repeat(4500), undefined, undefined, undefined, undefined, pace);
  expect(send).toHaveBeenCalledTimes(4); expect(pace).toHaveBeenCalledTimes(3);
  for (const [index, [options]] of send.mock.calls.entries() as any) {
    expect(options).toMatchObject({ target: { msgId: request.msgId }, messageReference: { message_id: request.msgId } });
    expect(options.content).toContain(`（${index + 1}/4）`);
  }
});

test.each(['throw', 'missing-id'])('a failed partial reply stops subsequent parts without replay: %s', async failure => {
  const send = jest.fn().mockResolvedValueOnce({ id: 'first' });
  if (failure === 'throw') send.mockRejectedValueOnce(new Error('network'));
  else send.mockResolvedValueOnce({});
  await expect(sendQQReply({ send, uploadMedia: jest.fn() } as any, request, '景'.repeat(4500), undefined, undefined, undefined, undefined, async () => {})).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(2);
});

test('multipart delivery requires pacing and stops when its next durable checkpoint fails', async () => {
  const send = jest.fn(async () => ({ id: 'receipt' }));
  await expect(sendQQReply({ send, uploadMedia: jest.fn() } as any, request, '景'.repeat(4500))).rejects.toThrow('durable pacing');
  expect(send).not.toHaveBeenCalled();
  await expect(sendQQReply({ send, uploadMedia: jest.fn() } as any, request, '景'.repeat(4500), undefined, undefined, undefined, undefined,
    async () => { throw new Error('expired'); })).rejects.toThrow('expired');
  expect(send).toHaveBeenCalledTimes(1);
});

const request: QQRequest = { key: 'request', user: 'user', scope: 'group', targetId: 'group-openid', msgId: 'message-id',
  text: '你好', createdAt: Date.parse('2026-10-28T02:00:00Z') };

test('uploads completed video as QQ video and quotes the current passive request exactly once', async () => {
  const send = jest.fn(async () => ({ id: 'video-receipt' })), uploadMedia = jest.fn(async () => ({ file_info: 'video-info' }));
  await sendQQReply({ send, uploadMedia } as any, request, '视频生成完成。', undefined, undefined, undefined, { file: 'video.mp4' });
  expect(uploadMedia).toHaveBeenCalledWith({ target: { scope: 'group', targetId: request.targetId, msgId: request.msgId }, fileType: 2, localPath: 'video.mp4', srvSendMsg: false });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ msgType: 7, media: { file_info: 'video-info' }, messageReference: { message_id: request.msgId } }));
  expect(send).toHaveBeenCalledTimes(1);
});

test('a completed image send without an ID reports only safe structure and never retries or invents a receipt', async () => {
  const receipt = { code: 304023, message: 'private-body', data: { id: 'private-nested-id', message_audit: { audit_id: 'private-audit' } } };
  const send = jest.fn(async () => receipt);
  const uploadMedia = jest.fn(async () => ({ file_info: 'private-file-info' }));
  const observe = jest.fn();
  await expect(sendQQReply({ send, uploadMedia } as any, request, '完成',
    { file: 'reply.png', model: 'image-model', sha256: 'a'.repeat(64), prompt: 'scene' }, observe)).resolves.toBe(receipt);
  expect(observe).toHaveBeenCalledWith({ version: 1, step: 'message', outcome: 'invalid_receipt', kind: 'object', hasId: false, hasTimestamp: false,
    hasReference: false, hasNestedId: true, hasAudit: true, platformCode: 304023 });
  expect(JSON.stringify(observe.mock.calls)).not.toContain('private');
  expect(send).toHaveBeenCalledTimes(1); expect(uploadMedia).toHaveBeenCalledTimes(1);
});

test.each(['upload', 'message'])('structured SDK errors are diagnosed without leaking bodies or changing %s failures', async step => {
  const error = Object.assign(new Error('private-body private-openid'), { name: 'ApiError', httpStatus: 503,
    bizCode: 12345, path: '/private-target', bizMessage: 'private-message' });
  const uploadMedia = jest.fn(async () => ({ file_info: 'private-file-info' }));
  const send = jest.fn(async () => ({ id: 'reply', timestamp: 1 }));
  (step === 'upload' ? uploadMedia : send).mockRejectedValueOnce(error);
  const observe = jest.fn();
  await expect(sendQQReply({ send, uploadMedia } as any, request, '完成',
    { file: 'reply.png', model: 'image-model', sha256: 'a'.repeat(64), prompt: 'scene' }, observe)).rejects.toBe(error);
  expect(observe).toHaveBeenCalledWith({ version: 1, step, outcome: 'failed', errorName: 'ApiError', httpStatus: 503, platformCode: 12345 });
  expect(JSON.stringify(observe.mock.calls)).not.toContain('private');
  expect(send).toHaveBeenCalledTimes(step === 'upload' ? 0 : 1); expect(uploadMedia).toHaveBeenCalledTimes(1);
});

test('diagnostic failures cannot turn a confirmed send into a send failure', async () => {
  const receipt = { id: 'reply', timestamp: 1 };
  const send = jest.fn(async () => receipt);
  await expect(sendQQReply({ send, uploadMedia: jest.fn() } as any, request, '你好', undefined,
    () => { throw new Error('observer'); })).resolves.toBe(receipt);
  expect(send).toHaveBeenCalledTimes(1);
});

test('a parsed QQ HTTP 400 message rejection is isolated without retrying the image or leaking SDK details', async () => {
  const error = Object.assign(new Error('private-body'), { name: 'ApiError', httpStatus: 400,
    bizCode: 40034006, bizMessage: 'private-message', path: '/private-target' });
  const uploadMedia = jest.fn(async () => ({ file_info: 'private-file-info' }));
  const send = jest.fn(async () => { throw error; });
  const observe = jest.fn();
  await expect(sendQQReply({ send, uploadMedia } as any, request, '完成',
    { file: 'reply.png', model: 'image-model', sha256: 'a'.repeat(64), prompt: 'scene' }, observe))
    .rejects.toBeInstanceOf(QQSendRejectedError);
  expect(observe).toHaveBeenCalledWith({ version: 1, step: 'message', outcome: 'failed', errorName: 'ApiError', httpStatus: 400, platformCode: 40034006 });
  expect(JSON.stringify(observe.mock.calls)).not.toContain('private');
  expect(send).toHaveBeenCalledTimes(1); expect(uploadMedia).toHaveBeenCalledTimes(1);
});

test.each([
  { name: 'ApiError', httpStatus: 400 },
  { name: 'ApiError', httpStatus: 400, bizCode: '40034006' },
  { name: 'ApiError', httpStatus: 400, bizCode: 0 },
  { name: 'ApiError', httpStatus: 401, bizCode: 40034006 },
  { name: 'ApiError', httpStatus: 408, bizCode: 40034006 },
  { name: 'ApiError', httpStatus: 0, bizCode: 40034006 },
  { name: 'Error', httpStatus: 400, bizCode: 40034006 }
])('unconfirmed or non-business failures retain their original error: %j', async fields => {
  const error = Object.assign(new Error('private-body'), fields);
  const send = jest.fn(async () => { throw error; });
  await expect(sendQQReply({ send, uploadMedia: jest.fn() } as any, request, '你好')).rejects.toBe(error);
  expect(send).toHaveBeenCalledTimes(1);
});

test('an upload HTTP 400 remains an upload error and is never classified as a message rejection', async () => {
  const error = Object.assign(new Error('private-body'), { name: 'ApiError', httpStatus: 400, bizCode: 40034006 });
  const uploadMedia = jest.fn(async () => { throw error; });
  const send = jest.fn();
  await expect(sendQQReply({ send, uploadMedia } as any, request, '完成',
    { file: 'reply.png', model: 'image-model', sha256: 'a'.repeat(64), prompt: 'scene' })).rejects.toBe(error);
  expect(send).not.toHaveBeenCalled(); expect(uploadMedia).toHaveBeenCalledTimes(1);
});

test('only a rejected image invokes the notice handler, and a failed notice cannot replace the rejection', async () => {
  const error = Object.assign(new Error('private-body'), { name: 'ApiError', httpStatus: 400, bizCode: 40034006 });
  const send = jest.fn(async () => { throw error; }), uploadMedia = jest.fn(async () => ({ file_info: 'private-file' }));
  const onRejected = jest.fn(async () => { throw new Error('private notice failure'); });
  const image = { file: 'reply.png', model: 'image-model', sha256: 'a'.repeat(64), prompt: 'scene' };
  await expect(sendQQReply({ send, uploadMedia } as any, request, '完成', image, undefined, onRejected)).rejects.toBeInstanceOf(QQSendRejectedError);
  expect(onRejected).toHaveBeenCalledTimes(1);
  expect(onRejected.mock.calls[0]).toEqual([expect.objectContaining({ platformCode: 40034006 })]);
  await expect(sendQQReply({ send, uploadMedia } as any, request, '提示', undefined, undefined, onRejected)).rejects.toBeInstanceOf(QQSendRejectedError);
  expect(onRejected).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(2);
});

test('the rejection text honors shared throttling, checkpoints first and quotes the same inbound without uploading', async () => {
  let now = request.createdAt;
  const state = newQQState('900000001'); state.lastSendAt = now;
  const io = { now: () => now, sleep: jest.fn(async (ms: number) => { now += ms; }), save: jest.fn(async () => {}), stopping: () => false };
  const send = jest.fn(async () => { expect(io.save).toHaveBeenCalledTimes(1); return { id: 'notice-receipt', timestamp: 1 }; });
  const uploadMedia = jest.fn();
  await expect(sendQQRejectionNotice({ send, uploadMedia } as any, request, 'QQ拒绝发图', state, io)).resolves.toBe('sent');
  expect(io.sleep).toHaveBeenCalledWith(QQ_LIMITS.sendIntervalMs);
  expect(state.lastSendAt).toBe(request.createdAt + QQ_LIMITS.sendIntervalMs);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ msgType: 0, content: 'QQ拒绝发图',
    target: expect.objectContaining({ msgId: request.msgId }), messageReference: { message_id: request.msgId } }));
  expect(uploadMedia).not.toHaveBeenCalled();
});

test('a reply window expiring during throttle wait suppresses the notice instead of sending a stale message', async () => {
  let now = request.createdAt + QQ_LIMITS.maxAgeMs - 1000;
  const state = newQQState('900000001'); state.lastSendAt = now;
  const io = { now: () => now, sleep: async (ms: number) => { now += ms; }, save: jest.fn(), stopping: () => false };
  const send = jest.fn();
  await expect(sendQQRejectionNotice({ send, uploadMedia: jest.fn() } as any, request, 'QQ拒绝发图', state, io)).resolves.toBe('expired');
  expect(send).not.toHaveBeenCalled(); expect(io.save).not.toHaveBeenCalled();
});

test('a notice without a confirmed ID is not reported as sent or retried', async () => {
  const state = newQQState('900000001'), send = jest.fn(async () => ({}));
  await expect(sendQQRejectionNotice({ send, uploadMedia: jest.fn() } as any, request, 'QQ拒绝发图', state,
    { now: () => request.createdAt, sleep: async () => {}, save: async () => {}, stopping: () => false })).rejects.toThrow('notice receipt missing');
  expect(send).toHaveBeenCalledTimes(1);
});

test('sends text replies with both passive binding and a native quote reference', async () => {
  const send = jest.fn(async () => ({ id: 'reply-id', timestamp: Date.now() }));
  const bot = { send, uploadMedia: jest.fn() } as any;
  await sendQQReply(bot, request, '鹿饼收到啦');
  expect(send).toHaveBeenCalledWith({ target: { scope: 'group', targetId: 'group-openid', msgId: 'message-id' }, msgType: 0,
    content: '鹿饼收到啦', messageReference: { message_id: 'message-id' } });
});

test('sends image replies with the same quote reference after upload', async () => {
  const uploadMedia = jest.fn(async () => ({ file_info: 'file-info' }));
  const send = jest.fn(async () => ({ id: 'reply-id', timestamp: Date.now() }));
  const bot = { send, uploadMedia } as any;
  await sendQQReply(bot, request, '图片完成', { file: 'reply.png', model: 'image-model', sha256: 'a'.repeat(64), prompt: 'scene' });
  expect(uploadMedia).toHaveBeenCalledWith({ target: { scope: 'group', targetId: 'group-openid', msgId: 'message-id' }, fileType: 1,
    localPath: 'reply.png', srvSendMsg: false });
  expect(send).toHaveBeenCalledWith({ target: { scope: 'group', targetId: 'group-openid', msgId: 'message-id' }, msgType: 7,
    media: { file_info: 'file-info' }, content: '图片完成', messageReference: { message_id: 'message-id' } });
});

test('supplemental images quote the creation message while spending the fresh passive window', async () => {
  const uploadMedia = jest.fn(async () => ({ file_info: 'file-info' }));
  const send = jest.fn(async () => ({ id: 'reply-id', timestamp: Date.now() }));
  const supplemental = { ...request, replyMsgId: 'original-image-message' };
  await sendQQReply({ send, uploadMedia } as any, supplemental, '图片补发',
    { file: 'reply.png', model: 'image-model', sha256: 'a'.repeat(64), prompt: 'scene' });
  expect(uploadMedia).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ msgId: request.msgId }) }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ msgId: request.msgId }),
    messageReference: { message_id: 'original-image-message' } }));
});
