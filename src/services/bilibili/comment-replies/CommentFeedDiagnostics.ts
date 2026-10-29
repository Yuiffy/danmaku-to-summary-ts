import { createHash } from 'crypto';
import { CommentFeedDiagnostic } from './CommentPolling';

const valueType = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

/** Shape and fingerprint only: notification text, headers and arbitrary error messages never enter logs/alerts. */
export function commentFeedResponse(status: number, contentType?: string | null, text?: string, body?: any): Partial<CommentFeedDiagnostic> {
  const mime = (contentType || '').split(';')[0].trim().toLowerCase();
  return { httpStatus: status,
    contentType: !mime ? 'missing' : mime === 'application/json' || mime.endsWith('+json') ? 'json' :
      mime === 'text/html' ? 'html' : mime === 'text/plain' ? 'text' : 'other',
    ...(text === undefined ? {} : { bodyBytes: Buffer.byteLength(text, 'utf8'),
      bodySha256: createHash('sha256').update(text).digest('hex'),
      bodyFormat: /^[\s\uFEFF]*[\[{]/u.test(text) ? 'json' as const :
        /^[\s\uFEFF]*<(?:!doctype|html|head|body)\b/iu.test(text) ? 'html' as const : 'text' as const }),
    ...(body === undefined ? {} : { itemsType: valueType(body?.data?.items),
      ...(Array.isArray(body?.data?.items) ? { itemCount: body.data.items.length } : {}),
      cursorType: valueType(body?.data?.cursor), endType: valueType(body?.data?.cursor?.is_end),
      idType: valueType(body?.data?.cursor?.id), timeType: valueType(body?.data?.cursor?.time) }) };
}
