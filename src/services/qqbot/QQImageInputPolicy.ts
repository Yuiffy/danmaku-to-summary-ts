/** Only authenticated SDK attachment fields supply image URLs; message text is never a source. */
export interface QQImageAttachment { content_type: string; url: string }
export interface QQImageEnvelope {
  attachments?: QQImageAttachment[];
  refMsgIdx?: string;
  msgType?: number;
  msgElements?: Array<{ msg_idx?: string; attachments?: QQImageAttachment[] }>;
}
export interface QQImageInput { urls: string[]; reply?: string; invalid?: boolean }
export interface QQImageInputDiagnostic {
  messageType?: number; hasReference: boolean; attachmentCount: number; elementCount: number;
  elementAttachmentCount: number; sourceCount: number; inputPresent: boolean; invalid: boolean;
}
export const QQ_IMAGE_INPUT_LIMIT = 8;
export const qqImageReferenceId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\p{Cc}\p{Cf}]/u.test(value);

export function qqImageAttachmentUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.hash ||
      !['multimedia.nt.qq.com', 'gchat.qpic.cn', 'c2cpicdw.qpic.cn'].includes(url.hostname)) return;
    url.protocol = 'https:';
    return url.href;
  } catch { return; }
}

export function qqImageInput(message: QQImageEnvelope): QQImageInput | undefined {
  const elements = Array.isArray(message.msgElements) ? message.msgElements : [];
  const isImage = (item: QQImageAttachment) => typeof item?.content_type === 'string' && item.content_type.startsWith('image/');
  const element = (qqImageReferenceId(message.refMsgIdx) ? elements.find(item => item?.msg_idx === message.refMsgIdx) : undefined) ||
    elements.find(item => Array.isArray(item?.attachments) && item.attachments.some(isImage)) || elements[0];
  const reference = message.msgType === 103 ? element?.msg_idx || message.refMsgIdx : message.refMsgIdx;
  const reply = qqImageReferenceId(reference) ? reference : undefined;
  // These are authenticated attachment fields; optional quote indices/type are not prerequisites for image bytes.
  const quoted = element?.attachments;
  const attachments = Array.isArray(quoted) && quoted.some(isImage) ? quoted : message.attachments;
  const images = Array.isArray(attachments) ? attachments.filter(isImage) : [];
  if (!images.length && !reply) return;
  const urls = images.slice(0, QQ_IMAGE_INPUT_LIMIT).map(item => qqImageAttachmentUrl(item.url));
  const invalid = images.length > QQ_IMAGE_INPUT_LIMIT || urls.some(url => !url);
  return { urls: urls.filter((url): url is string => !!url), ...(reply ? { reply } : {}), ...(invalid ? { invalid } : {}) };
}

/** Log only bounded structure, never URLs, quoted content, or platform/conversation identifiers. */
export function qqImageInputDiagnostic(message: QQImageEnvelope, input?: QQImageInput): QQImageInputDiagnostic {
  const elements = Array.isArray(message.msgElements) ? message.msgElements : [];
  const count = (items: unknown) => Array.isArray(items) ? Math.min(32, items.length) : 0;
  return {
    ...(Number.isSafeInteger(message.msgType) && message.msgType! >= 0 && message.msgType! <= 65535 ? { messageType: message.msgType } : {}),
    hasReference: !!input?.reply || qqImageReferenceId(message.refMsgIdx), attachmentCount: count(message.attachments),
    elementCount: count(elements), elementAttachmentCount: Math.min(32, elements.slice(0, 32).reduce((sum, item) => sum + count(item?.attachments), 0)),
    sourceCount: input?.urls.length || 0, inputPresent: !!input, invalid: input?.invalid === true
  };
}
