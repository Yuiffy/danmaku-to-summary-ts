/**
 * 企业微信机器人通知服务
 */
import fetch from 'node-fetch';
import { getLogger } from '../../core/logging/LogManager';
import FormData = require('form-data');
import { createReadStream, statSync } from 'fs';
import { basename, join } from 'path';

/**
 * 企业微信消息类型
 */
export type WeChatWorkMessageType = 'text' | 'markdown' | 'image';

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
  image?: {
    media_id: string;
  };
}

/**
 * 上传素材响应
 */
interface UploadMediaResponse {
  errcode: number;
  errmsg: string;
  type: string;
  media_id: string;
  created_at: number;
}

/**
 * 企业微信通知服务
 */
export class WeChatWorkNotifier {
  private logger = getLogger('WeChatWorkNotifier');
  private webhookUrl: string;
  private uploadUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
    // 从webhook URL中提取key，构建上传URL
    const keyMatch = webhookUrl.match(/key=([^&]+)/);
    const key = keyMatch ? keyMatch[1] : '';
    this.uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key=${key}&type=image`;
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
   * 发送图片消息
   */
  async sendImage(mediaId: string): Promise<boolean> {
    try {
      const message: WeChatWorkMessage = {
        msgtype: 'image',
        image: {
          media_id: mediaId
        }
      };

      return await this.sendMessage(message);
    } catch (error) {
      this.logger.error('发送企业微信图片消息失败', undefined, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * 上传图片到企业微信临时素材
   * @param imagePath 图片文件路径
   * @returns media_id，失败返回null
   */
  async uploadImage(imagePath: string): Promise<string | null> {
    try {
      this.logger.debug('上传图片到企业微信', { imagePath });

      // 1. 获取文件大小和文件名
      // statSync 既能获取大小，也能检查文件是否存在（不存在会直接抛错，被catch捕获）
      const fileStat = statSync(imagePath);
      const fileSize = fileStat.size;
      const fileName = basename(imagePath); // 自动从路径提取文件名

      const form = new FormData();
      
      // 2. 添加文件流，显式指定 knownLength 和 filename
      form.append('media', createReadStream(imagePath), {
        filename: fileName,      // 必填：显式指定文件名，防止乱码或识别失败
        contentType: 'image/png', // 选填：指定类型
        knownLength: fileSize     // 关键：告诉 form-data 库流的大小
      });

      // 3. 构建请求头，必须包含 Content-Length
      const headers = form.getHeaders();
      headers['Content-Length'] = fileSize.toString(); // 关键：显式设置 HTTP 头

      const response = await fetch(this.uploadUrl, {
        method: 'POST',
        body: form,
        headers: headers
      });

      if (!response.ok) {
        this.logger.error('企业微信上传图片请求失败', {
          status: response.status,
          statusText: response.statusText
        });
        return null;
      }

      const result: UploadMediaResponse = await response.json() as UploadMediaResponse;

      if (result.errcode !== 0) {
        this.logger.error('企业微信上传图片返回错误', {
          errcode: result.errcode,
          errmsg: result.errmsg
        });
        return null;
      }

      this.logger.debug('企业微信图片上传成功', { media_id: result.media_id });
      return result.media_id;
    } catch (error) {
      this.logger.error('上传企业微信图片异常', undefined, error instanceof Error ? error : new Error(String(error)));
      return null;
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
    imageUrl?: string,
    imagePath?: string
  ): Promise<boolean> {
    const replyUrl = `https://www.bilibili.com/opus/${dynamicId}#reply${replyId}`;

    // 如果提供了本地图片路径，先上传图片并发送图片消息
    if (imagePath) {
      const mediaId = await this.uploadImage(imagePath);
      if (mediaId) {
        // 发送图片消息
        await this.sendImage(mediaId);
        // 发送文本消息补充信息
        let content = anchorName
          ? `✅ 动态回复成功\n\n主播: ${anchorName}\n动态ID: ${dynamicId}\n回复ID: ${replyId}`
          : `✅ 动态回复成功\n\n动态ID: ${dynamicId}\n回复ID: ${replyId}`;
        
        if (replyContent) {
          // const truncatedContent = replyContent.length > 200 ? replyContent.substring(0, 200) + '...' : replyContent;
          content += `\n\n回复内容:\n${replyContent}`;
        }
        
        content += `\n\n[查看回复](${replyUrl})`;
        return await this.sendMarkdown(content);
      }
      // 上传失败，降级到使用链接方式
    }
    
    // 原有的markdown方式
    let content = anchorName
      ? `✅ 动态回复成功\n\n主播: ${anchorName}\n动态ID: ${dynamicId}\n回复ID: ${replyId}`
      : `✅ 动态回复成功\n\n动态ID: ${dynamicId}\n回复ID: ${replyId}`;
    
    // 添加回复内容（截取前200字符）
    if (replyContent) {
      // const truncatedContent = replyContent.length > 200 ? replyContent.substring(0, 200) + '...' : replyContent;
      content += `\n\n回复内容:\n${replyContent}`;
    }
    
    // 添加图片信息
    if (imageUrl) {
      content += `\n\n[查看附图](${imageUrl})`;
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
