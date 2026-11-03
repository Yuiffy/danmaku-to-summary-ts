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
  urlDiagnosticsVersion?: 1;
  rejectedImageUrls?: Array<{ source: 'attachment' | 'element'; reason: string; shape: string; hostname?: string }>;
}
export const QQ_IMAGE_INPUT_LIMIT = 8;
export const qqImageReferenceId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\p{Cc}\p{Cf}]/u.test(value);

export function qqImageAttachmentUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.hash ||
      !['multimedia.nt.qq.com', 'multimedia.nt.qq.com.cn', 'gchat.qpic.cn', 'c2cpicdw.qpic.cn'].includes(url.hostname)) return;
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

/** Observe rejected URL structure without retaining paths, queries, credentials or raw values. No admission changes. */
function rejectedImageUrl(value: unknown): { reason: string; shape: string; hostname?: string } | undefined {
  if (qqImageAttachmentUrl(value)) return;
  if (typeof value !== 'string') return { reason: 'not_string', shape: 'not_string' };
  const shape = !value ? 'empty' : value.startsWith('//') ? 'protocol_relative' : /^[a-z][a-z\d+.-]*:/iu.test(value) ? 'absolute' : 'no_scheme';
  if (value.length > 4096) return { reason: 'too_long', shape };
  let url: URL;
  try { url = new URL(value.startsWith('//') ? `https:${value}` : value); }
  catch { return { reason: 'malformed_url', shape }; }
  // Hostnames only: never output url.href, port, username, password, path, hash or query.
  const hostname = /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,24}$/iu.test(url.hostname) && url.hostname.length <= 128 ? url.hostname : undefined;
  return { reason: !['https:', 'http:'].includes(url.protocol) ? 'protocol' : url.username || url.password ? 'credentials' :
    url.port ? 'port' : url.hash ? 'fragment' : 'hostname', shape, ...(hostname ? { hostname } : {}) };
}

/** Log only bounded structure and rejected hostnames, never URLs, quoted content or platform identifiers. */
export function qqImageInputDiagnostic(message: QQImageEnvelope, input?: QQImageInput): QQImageInputDiagnostic {
  const elements = Array.isArray(message.msgElements) ? message.msgElements : [];
  const count = (items: unknown) => Array.isArray(items) ? Math.min(32, items.length) : 0;
  const rejectedImageUrls: NonNullable<QQImageInputDiagnostic['rejectedImageUrls']> = [];
  const inspect = (items: unknown, source: 'attachment' | 'element') => {
    if (!Array.isArray(items)) return;
    for (const item of items.slice(0, 32)) {
      if (rejectedImageUrls.length >= QQ_IMAGE_INPUT_LIMIT) break;
      if (typeof item?.content_type !== 'string' || !item.content_type.startsWith('image/')) continue;
      const diagnostic = rejectedImageUrl(item.url);
      if (diagnostic) rejectedImageUrls.push({ source, ...diagnostic });
    }
  };
  inspect(message.attachments, 'attachment');
  for (const element of elements.slice(0, 32)) inspect(element?.attachments, 'element');
  return {
    ...(Number.isSafeInteger(message.msgType) && message.msgType! >= 0 && message.msgType! <= 65535 ? { messageType: message.msgType } : {}),
    hasReference: !!input?.reply || qqImageReferenceId(message.refMsgIdx), attachmentCount: count(message.attachments),
    elementCount: count(elements), elementAttachmentCount: Math.min(32, elements.slice(0, 32).reduce((sum, item) => sum + count(item?.attachments), 0)),
    sourceCount: input?.urls.length || 0, inputPresent: !!input, invalid: input?.invalid === true,
    ...(rejectedImageUrls.length ? { urlDiagnosticsVersion: 1, rejectedImageUrls } : {})
  };
}
