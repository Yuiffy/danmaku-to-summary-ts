import { QQImageEnvelope, qqImageAttachmentUrl, qqImageReferenceId } from './QQImageInputPolicy';

export interface QQVideoInput { urls: string[]; invalid?: boolean }
export const QQ_VIDEO_INPUT_LIMIT = 3;

/** Only authenticated attachments, including the selected quote, supply reference videos. */
export function qqVideoInput(message: QQImageEnvelope): QQVideoInput | undefined {
  const isVideo = (item: { content_type?: string }) => typeof item?.content_type === 'string' && /^video\//iu.test(item.content_type.trim());
  const elements = Array.isArray(message.msgElements) ? message.msgElements : [];
  const selected = qqImageReferenceId(message.refMsgIdx) ? elements.find(item => item?.msg_idx === message.refMsgIdx) : undefined;
  const element = qqImageReferenceId(message.refMsgIdx) ? selected :
    elements.find(item => Array.isArray(item?.attachments) && item.attachments.some(isVideo));
  const quoted = element?.attachments;
  const attachments = Array.isArray(quoted) && quoted.some(isVideo) ? quoted : message.attachments;
  const videos = Array.isArray(attachments) ? attachments.filter(isVideo) : [];
  if (!videos.length) return;
  const urls = videos.slice(0, QQ_VIDEO_INPUT_LIMIT).map(item => qqImageAttachmentUrl(item.url));
  return { urls: urls.filter((url): url is string => !!url),
    ...(videos.length > QQ_VIDEO_INPUT_LIMIT || urls.some(url => !url) ? { invalid: true } : {}) };
}
