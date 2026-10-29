import { loadConfigLayers } from '../../../core/config/ConfigLayers';
import { WeChatWorkNotifier } from '../../notification/WeChatWorkNotifier';

/** Same operator-configured destination as existing production notifications; never selected by model or comment. */
export function createCommentPauseNotify(configPath: string): (text: string) => Promise<boolean> {
  return async text => {
    const config = loadConfigLayers({ configPath });
    const webhookUrl = (config.wechatWork as { webhookUrl?: unknown } | undefined)?.webhookUrl;
    if (typeof webhookUrl !== 'string' || !webhookUrl) return false;
    return new WeChatWorkNotifier(webhookUrl).sendText(text);
  };
}
