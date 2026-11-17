import * as path from 'path';
import { loadConfigLayers } from '../../core/config/ConfigLayers';
import { WeChatWorkNotifier } from '../notification/WeChatWorkNotifier';
import { QQImageRejections, QQImageRejectionIO } from './QQImageRejections';

/** Reuse the operator's production notification destination, independently of QQ's dedicated model credentials. */
export function createQQImageRejections(root: string, appId: string, configPath: string | undefined,
  io: Pick<QQImageRejectionIO, 'sendNotice' | 'report'>): QQImageRejections {
  const notifier = () => {
    if (!configPath) return undefined;
    const config = loadConfigLayers({ root, configPath: path.resolve(root, configPath) });
    const webhook = (config.wechatWork as { webhookUrl?: unknown } | undefined)?.webhookUrl;
    if (typeof webhook !== 'string' || !webhook) return undefined;
    const url = new URL(webhook);
    if (url.protocol !== 'https:' || url.hostname !== 'qyapi.weixin.qq.com' || url.pathname !== '/cgi-bin/webhook/send' ||
      url.username || url.password || !url.searchParams.get('key')) throw new Error('Invalid QQ operator notification destination');
    // QQ emits only bounded delivery statuses; the shared notifier's raw errors may contain webhook credentials.
    return new WeChatWorkNotifier(webhook, undefined, { info() {}, debug() {}, warn() {}, error() {} });
  };
  return new QQImageRejections(root, appId, { ...io,
    sendText: async text => await notifier()?.sendText(text) || false,
    sendImage: async file => await notifier()?.sendImage(file) || false });
}
