import { loadConfigLayers } from '../../../core/config/ConfigLayers';
import { WeChatWorkNotifier } from '../../notification/WeChatWorkNotifier';
import { createCommentPauseNotify } from './CommentAlertRuntime';

jest.mock('../../../core/config/ConfigLayers', () => ({ loadConfigLayers: jest.fn() }));
jest.mock('../../notification/WeChatWorkNotifier', () => ({ WeChatWorkNotifier: jest.fn() }));

test('uses only the explicit production notification configuration, without a model-selected destination', async () => {
  const sendText = jest.fn(async () => true), webhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture';
  (loadConfigLayers as jest.Mock).mockReturnValue({ wechatWork: { webhookUrl } });
  (WeChatWorkNotifier as jest.Mock).mockImplementation(() => ({ sendText }));
  await expect(createCommentPauseNotify('fixed-config')('鹿饼自动回复已暂停')).resolves.toBe(true);
  expect(loadConfigLayers).toHaveBeenCalledWith({ configPath: 'fixed-config' });
  expect(WeChatWorkNotifier).toHaveBeenCalledWith(webhookUrl); expect(sendText).toHaveBeenCalledTimes(1);
});

test('a missing configured destination returns a failed receipt instead of pretending an alert was delivered', async () => {
  (loadConfigLayers as jest.Mock).mockReturnValue({});
  await expect(createCommentPauseNotify('fixed-config')('暂停')).resolves.toBe(false);
});
