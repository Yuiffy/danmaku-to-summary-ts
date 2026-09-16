const fetch = require('node-fetch');

// 企业微信机器人 Markdown 的限制按 UTF-8 字节计算，而不是 JavaScript 字符数。
const WECHAT_WORK_MARKDOWN_MAX_BYTES = 4096;

function normalizeWeChatWorkContent(content) {
    return String(content ?? '').replace(/\\+/g, '/');
}

function resolveMaxBytes(maxBytes) {
    const value = Number(maxBytes);
    return Number.isFinite(value) && value > 0
        ? Math.max(1, Math.floor(value))
        : WECHAT_WORK_MARKDOWN_MAX_BYTES;
}

/**
 * Split Markdown at line boundaries where possible, then at Unicode code-point
 * boundaries for an individual oversized line. Every returned message stays
 * within the official byte limit.
 */
function splitWeChatMarkdown(content, maxBytes = WECHAT_WORK_MARKDOWN_MAX_BYTES) {
    const limit = resolveMaxBytes(maxBytes);
    const lines = String(content ?? '').split('\n');
    const chunks = [];
    let current = '';

    const byteLength = value => Buffer.byteLength(String(value ?? ''), 'utf8');
    const takeByBytes = value => {
        const text = String(value ?? '');
        let bytes = 0;
        let index = 0;
        while (index < text.length) {
            const codePoint = text.codePointAt(index);
            const character = String.fromCodePoint(codePoint);
            const characterBytes = byteLength(character);
            if (bytes + characterBytes > limit) break;
            bytes += characterBytes;
            index += character.length;
        }
        return [text.slice(0, index), text.slice(index)];
    };

    const flush = () => {
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

/**
 * Send one or more Markdown messages in order. A later failure is surfaced
 * after any earlier parts have already been accepted by the webhook.
 */
async function sendWeChatMarkdown(webhookUrl, content, requestOptions = {}) {
    const url = String(webhookUrl || '').trim();
    if (!url) return false;

    const options = requestOptions && typeof requestOptions === 'object' ? requestOptions : {};
    const normalized = normalizeWeChatWorkContent(content);
    const messages = splitWeChatMarkdown(normalized, options.maxBytes);
    const { maxBytes: _maxBytes, ...fetchOptions } = options;

    for (const [index, message] of messages.entries()) {
        const response = await fetch(url, {
            ...fetchOptions,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(fetchOptions.headers || {})
            },
            body: JSON.stringify({
                msgtype: 'markdown',
                markdown: { content: message }
            })
        });
        if (!response.ok) {
            throw new Error(`企业微信第 ${index + 1}/${messages.length} 段请求失败: HTTP ${response.status}`);
        }

        const result = await response.json();
        if (result.errcode !== 0) {
            throw new Error(
                `企业微信第 ${index + 1}/${messages.length} 段返回错误: ${result.errcode} ${result.errmsg || ''}`.trim()
            );
        }
    }

    return true;
}

module.exports = {
    WECHAT_WORK_MARKDOWN_MAX_BYTES,
    normalizeWeChatWorkContent,
    splitWeChatMarkdown,
    sendWeChatMarkdown
};
