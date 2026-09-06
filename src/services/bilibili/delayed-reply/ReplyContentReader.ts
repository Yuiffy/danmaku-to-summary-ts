import * as fs from 'fs';
import { getLogger } from '../../../core/logging/LogManager';

/** Reads generated Markdown and validates the public comment body. */
export class ReplyContentReader {
  private readonly logger = getLogger('ReplyContentReader');

  /**
   * 读取晚安回复文本
   */
  async readReplyText(textPath: string): Promise<string> {
    try {
      this.logger.debug('开始读取晚安回复文本', { textPath });
      
      if (!fs.existsSync(textPath)) {
        const errorMsg = `晚安回复文件不存在: ${textPath}`;
        this.logger.error(errorMsg, { textPath, exists: false });
        throw new Error(errorMsg);
      }

      this.logger.debug('文件存在，开始读取内容', { textPath });
      
      const content = fs.readFileSync(textPath, 'utf8');
      this.logger.debug('文件读取成功', { textPath, contentLength: content.length });
      
      // 仅在文件开头存在 front matter 时才跳过元数据，避免正文中的 `---` 被误判。
      const lines = content.split('\n');
      const firstNonEmptyIndex = lines.findIndex(line => line.trim().length > 0);
      
      if (firstNonEmptyIndex >= 0 && lines[firstNonEmptyIndex].trim() === '---') {
        const endIndex = lines.findIndex(
          (line, index) => index > firstNonEmptyIndex && line.trim() === '---'
        );

        if (endIndex > firstNonEmptyIndex) {
          const result = this.sanitizeReplyText(lines.slice(endIndex + 1).join('\n'));
          this.assertReplyTextIsPublishable(result, textPath);
          this.logger.debug('提取正文成功（跳过 front matter 元数据）', { textPath, resultLength: result.length });
          return result;
        }
      }

      const result = this.sanitizeReplyText(content);
      this.assertReplyTextIsPublishable(result, textPath);
      this.logger.debug('提取正文成功（无元数据）', { textPath, resultLength: result.length });
      return result;
    } catch (error) {
      const errorInfo = {
        textPath,
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack
        } : String(error)
      };
      this.logger.error('读取晚安回复文本失败', errorInfo);
      throw error;
    }
  }

  sanitizeReplyText(text: string): string {
    return text
      .trim()
      .replace(/^\s*>+\s*(?:🔍\s*)?$/gmu, '')
      .replace(/^\s*>+\s*/gmu, '')
      .replace(/^\s*🔍\s*\*\*[^*\r\n]{2,30}\*\*/gmu, '')
      .replace(/^\s*🔍\s*/gmu, '')
      .replace(/\*\*([^*\r\n]+)\*\*/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
      .replace(/^\s*[（(]\s*共\s*\d+\s*字\s*[）)]\s*$/gmu, '')
      .replace(/[（(]\s*共\s*\d+\s*字\s*[）)]\s*$/u, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  assertReplyTextIsPublishable(text: string, textPath: string): void {
    const suspiciousPatterns = [
      /word\s*count\s*check/i,
      /(?:[\p{Script=Han}A-Za-z0-9！!？?。，、：；:;,.~～🌙☀️]\(\d+\)\s*){2,}/u,
      /字数\s*(?:检查|统计|校验)/u
    ];

    if (suspiciousPatterns.some(pattern => pattern.test(text))) {
      throw new Error(`晚安回复疑似模型调试/字数校验输出，拒绝发布: ${textPath}`);
    }
  }
}
