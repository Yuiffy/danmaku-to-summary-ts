import { loadConfigLayers } from '../../core/config/ConfigLayers';
import { WeChatWorkNotifier } from '../notification/WeChatWorkNotifier';
import { QQImageRejections } from './QQImageRejections';
import { createQQImageRejections } from './QQImageRejectionRuntime';

jest.mock('../../core/config/ConfigLayers', () => ({ loadConfigLayers: jest.fn() }));
jest.mock('../notification/WeChatWorkNotifier', () => ({ WeChatWorkNotifier: jest.fn() }));
jest.mock('./QQImageRejections', () => ({ QQImageRejections: jest.fn() }));
beforeEach(() => jest.clearAllMocks());
const io = () => { createQQImageRejections('fixture-root', '900000001', 'config/production.json', { sendNotice: jest.fn(), report: jest.fn() });
  return (QQImageRejections as jest.Mock).mock.calls.at(-1)[2]; };

test('uses the explicit layered operator config and existing notifier for both text and compressed images', async () => {
  const webhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture';
  (loadConfigLayers as jest.Mock).mockReturnValue({ wechatWork: { webhookUrl } });
  const sendText = jest.fn(async () => true), sendImage = jest.fn(async () => true);
  (WeChatWorkNotifier as jest.Mock).mockImplementation(() => ({ sendText, sendImage }));
  const transport = io();
  await expect(transport.sendText('发图被拒绝')).resolves.toBe(true);
  await expect(transport.sendImage('fixture.png')).resolves.toBe(true);
  expect(loadConfigLayers).toHaveBeenCalledWith(expect.objectContaining({ root: 'fixture-root', configPath: expect.stringMatching(/production\.json$/u) }));
  expect(WeChatWorkNotifier).toHaveBeenCalledWith(webhookUrl, undefined, expect.objectContaining({ error: expect.any(Function) }));
  expect(sendImage).toHaveBeenCalledWith('fixture.png');
});

test('missing config or destination never produces a successful notification receipt', async () => {
  (loadConfigLayers as jest.Mock).mockReturnValue({});
  await expect(io().sendText('提示')).resolves.toBe(false);
  createQQImageRejections('fixture-root', '900000001', undefined, { sendNotice: jest.fn(), report: jest.fn() });
  await expect((QQImageRejections as jest.Mock).mock.calls.at(-1)[2].sendImage('fixture.png')).resolves.toBe(false);
  expect(WeChatWorkNotifier).not.toHaveBeenCalled();
});

test('an arbitrary or credential-bearing endpoint cannot redirect rejected images', async () => {
  for (const webhookUrl of ['https://untrusted.invalid/send?key=fixture', 'https://user:pass@qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture']) {
    (loadConfigLayers as jest.Mock).mockReturnValue({ wechatWork: { webhookUrl } });
    await expect(io().sendImage('fixture.png')).rejects.toThrow('Invalid QQ operator');
  }
  expect(WeChatWorkNotifier).not.toHaveBeenCalled();
});
