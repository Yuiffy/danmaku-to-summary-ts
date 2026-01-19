/**
 * 企业微信机器人通知服务
 */
import fetch from 'node-fetch';
import { getLogger } from '../../core/logging/LogManager';

/**
 * 企业微信消息类型
 */
export type WeChatWorkMessageType = 'text' | 'markdown';

/**
 * 企业微信消息接口
 */
export interface WeChatWorkMessage {
  msgtype: WeChatWorkMessageType;
  text?: {
    content: string;
    mentioned_list?: string[];
    mentioned_mobile_list?: string[];
  };
  markdown?: {
    content: string;
  };
}

/**
 * 企业微信通知服务
 */
export class WeChatWorkNotifier {
  private logger = getLogger('WeChatWorkNotifier');
  private webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  /**
   * 发送文本消息
   */
  async sendText(content: string): Promise<boolean> {
    try {
      const message: WeChatWorkMessage = {
        msgtype: 'text',
        text: {
          content
        }
      };

      return await this.sendMessage(message);
    } catch (error) {
      this.logger.error('发送企业微信文本消息失败', undefined, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * 发送Markdown消息
   */
  async sendMarkdown(content: string): Promise<boolean> {
    try {
      const message: WeChatWorkMessage = {
        msgtype: 'markdown',
        markdown: {
          content
        }
      };

      return await this.sendMessage(message);
    } catch (error) {
      this.logger.error('发送企业微信Markdown消息失败', undefined, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * 发送动态回复成功通知
   */
  async notifyReplySuccess(
    dynamicId: string,
    replyId: string,
    anchorName?: string,
    replyContent?: string,
    imageUrl?: string
  ): Promise<boolean> {
    const replyUrl = `https://www.bilibili.com/opus/${dynamicId}#reply${replyId}`;
    
    let content = anchorName
      ? `✅ 动态回复成功\n\n主播: ${anchorName}\n动态ID: ${dynamicId}\n回复ID: ${replyId}`
      : `✅ 动态回复成功\n\n动态ID: ${dynamicId}\n回复ID: ${replyId}`;
    
    // 添加回复内容（截取前200字符）
    if (replyContent) {
      const truncatedContent = replyContent.length > 200 ? replyContent.substring(0, 200) + '...' : replyContent;
      content += `\n\n回复内容:\n${truncatedContent}`;
    }
    
    // 添加图片信息
    if (imageUrl) {
      content += `\n\n附图: ${imageUrl}`;
    }
    
    // 添加查看链接
    content += `\n\n[查看回复](${replyUrl})`;
    
    return await this.sendMarkdown(content);
  }

  /**
   * 发送动态回复失败通知
   */
  async notifyReplyFailure(dynamicId: string, error: string, anchorName?: string): Promise<boolean> {
    const content = anchorName
      ? `❌ 动态回复失败\n\n主播: ${anchorName}\n动态ID: ${dynamicId}\n错误: ${error}`
      : `❌ 动态回复失败\n\n动态ID: ${dynamicId}\n错误: ${error}`;

    return await this.sendMarkdown(content);
  }

  /**
   * 发送消息到企业微信
   */
  private async sendMessage(message: WeChatWorkMessage): Promise<boolean> {
    try {
      this.logger.debug('发送企业微信消息', { msgtype: message.msgtype });

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      });

      if (!response.ok) {
        this.logger.error('企业微信API请求失败', {
          status: response.status,
          statusText: response.statusText
        });
        return false;
      }

      const result = await response.json();

      if (result.errcode !== 0) {
        this.logger.error('企业微信API返回错误', {
          errcode: result.errcode,
          errmsg: result.errmsg
        });
        return false;
      }

      this.logger.debug('企业微信消息发送成功');
      return true;
    } catch (error) {
      this.logger.error('发送企业微信消息异常', undefined, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }
}
