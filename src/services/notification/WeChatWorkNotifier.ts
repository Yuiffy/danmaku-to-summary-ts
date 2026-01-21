/**
 * 企业微信机器人通知服务
 */
import fetch from 'node-fetch';
import { getLogger } from '../../core/logging/LogManager';
import FormData = require('form-data');
import { createReadStream, readFileSync, statSync } from 'fs';
import { basename, join } from 'path';
import * as crypto from 'crypto';

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
    media_id?: string;
    base64?: string;
    md5?: string;
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
   * 直接通过本地路径发送图片消息
   * 限制：图片大小不能超过 2MB
   */
  async sendImage(imagePath: string): Promise<boolean> {
    try {
      this.logger.debug('准备发送图片消息', { imagePath });
      
      // 1. 读取文件
      const fileBuffer = readFileSync(imagePath);
      
      // 2. 计算 MD5 (必须是原始二进制的 MD5)
      const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
      
      // 3. 转 Base64
      const base64 = fileBuffer.toString('base64');

      const message: WeChatWorkMessage = {
        msgtype: 'image',
        image: {
          base64,
          md5
        }
      };

      return await this.sendMessage(message);
    } catch (error) {
      this.logger.error('发送企业微信本地图片失败', undefined, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * 上传图片到企业微信临时素材（写得不对，这个只能上传文件，不能上传图片）
   * @param imagePath 图片文件路径
   * @returns media_id，失败返回null
   */
  async uploadImage(imagePath: string): Promise<string | null> {
  try {
    this.logger.debug('上传图片到企业微信', { imagePath });

    // 1. 直接读取文件为 Buffer，避免流式传输的各种坑
    const fileBuffer = readFileSync(imagePath);
    
    // 2. 创建 FormData
    const form = new FormData();
    
    // 关键点：手动指定一个简单的英文文件名
    // 企微机器人其实不在乎你上传时叫什么，只要后缀是 .png 且数据正确即可
    form.append('media', fileBuffer, {
      filename: 'image.png', 
      contentType: 'image/png',
    });

    // 3. 发起请求
    const response = await fetch(this.uploadUrl, {
      method: 'POST',
      body: form,
      headers: form.getHeaders() // 这里会自动包含正确的 Content-Length (因为是Buffer)
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
