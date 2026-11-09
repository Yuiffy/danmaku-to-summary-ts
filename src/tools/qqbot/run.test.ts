import { parseQQArgs, sendQQReply } from './run';
import type { QQRequest } from '../../services/qqbot/QQPolicy';

test('defaults to read-only validation and requires an explicit live mode', () => {
  expect(parseQQArgs([]).mode).toBe('check');
  expect(parseQQArgs(['--live']).mode).toBe('live');
  expect(() => parseQQArgs(['--live', '--resume'])).toThrow();
  expect(() => parseQQArgs(['--config'])).toThrow();
  expect(() => parseQQArgs(['--model', 'other'])).toThrow();
});

const request: QQRequest = { key: 'request', user: 'user', scope: 'group', targetId: 'group-openid', msgId: 'message-id',
  text: '你好', createdAt: Date.parse('2026-10-28T02:00:00Z') };

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
