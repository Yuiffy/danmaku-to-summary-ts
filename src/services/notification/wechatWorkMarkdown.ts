/** 企业微信机器人 Markdown 的官方内容上限（按 UTF-8 字节计算）。 */
export const WECHAT_WORK_MARKDOWN_MAX_BYTES = 4096;

function resolveMaxBytes(maxBytes: number): number {
  return Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.max(1, Math.floor(maxBytes))
    : WECHAT_WORK_MARKDOWN_MAX_BYTES;
}

/**
 * Split Markdown at line boundaries where possible, then at Unicode code-point
 * boundaries for an individual oversized line.
 */
export function splitWeChatMarkdown(
  content: string,
  maxBytes = WECHAT_WORK_MARKDOWN_MAX_BYTES
): string[] {
  const limit = resolveMaxBytes(Number(maxBytes));
  const lines = String(content ?? '').split('\n');
  const chunks: string[] = [];
  let current = '';

  const byteLength = (value: string): number => Buffer.byteLength(String(value ?? ''), 'utf8');
  const takeByBytes = (value: string): [string, string] => {
    const text = String(value ?? '');
    let bytes = 0;
    let index = 0;
    while (index < text.length) {
      const codePoint = text.codePointAt(index);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      const characterBytes = byteLength(character);
      if (bytes + characterBytes > limit) break;
      bytes += characterBytes;
      index += character.length;
    }
    return [text.slice(0, index), text.slice(index)];
  };

  const flush = (): void => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };

  for (let line of lines) {
    while (byteLength(line) > limit) {
      const [head, tail] = takeByBytes(line);
      flush();
      if (!head) {
        throw new Error(`企微 Markdown 单字符超过 ${limit} bytes 限制`);
      }
      chunks.push(head);
      line = tail;
    }

    if (!current) {
      current = line;
      continue;
    }

    const next = `${current}\n${line}`;
    if (byteLength(next) > limit) {
      flush();
      current = line;
    } else {
      current = next;
    }
  }
  flush();
  return chunks.length ? chunks : [''];
}
