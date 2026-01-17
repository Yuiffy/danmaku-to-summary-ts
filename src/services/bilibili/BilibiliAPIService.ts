/**
 * B站API服务实现
 */
import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../core/logging/LogManager';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { AppError } from '../../core/errors/AppError';
import { IBilibiliAPIService } from './interfaces/IBilibiliAPIService';
import {
  BilibiliDynamic,
  PublishCommentRequest,
  PublishCommentResponse,
  DynamicType,
  BilibiliAPIResponse
} from './interfaces/types';

/**
 * B站API服务实现
 */
export class BilibiliAPIService implements IBilibiliAPIService {
  private logger = getLogger('BilibiliAPIService');
  private cookie!: string;
  private csrf!: string;
  private baseUrl = 'https://api.bilibili.com';
  private webUrl = 'https://www.bilibili.com';

  constructor() {
    this.loadConfig();
  }

  /**
   * 加载配置
   */
  private loadConfig(): void {
    try {
      const config = ConfigProvider.getConfig();
      const bilibiliSecret = config.bilibili as any;

      if (!bilibiliSecret || !bilibiliSecret.cookie) {
        throw new AppError('B站Cookie未配置', 'CONFIGURATION_ERROR', 400);
      }

      this.cookie = bilibiliSecret.cookie;
      this.csrf = bilibiliSecret.csrf || this.extractCSRF(this.cookie);

      this.logger.info('B站API服务配置加载完成');
    } catch (error) {
      this.logger.error('加载B站配置失败', { error });
      throw error;
    }
  }

  /**
   * 获取主播动态列表
   */
  async getDynamics(uid: string, offset?: string): Promise<BilibiliDynamic[]> {
    try {
      this.logger.debug(`获取主播动态: ${uid}`, { offset });

      const url = `${this.baseUrl}/x/polymer/web-dynamic/v1/feed/space`;
      const params = new URLSearchParams({
        host_mid: uid,
        offset: offset || '',
        timezone_offset: '-480',
        features: 'itemOpusStyle'
      });

      const response = await fetch(`${url}?${params}`, {
        method: 'GET',
        headers: {
          'Cookie': this.cookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': `${this.webUrl}/`
        }
      });

      if (!response.ok) {
        throw new AppError(`获取动态失败: HTTP ${response.status}`, 'API_ERROR', response.status);
      }

      const data: BilibiliAPIResponse = await response.json();

      if (data.code !== 0) {
        throw new AppError(`获取动态失败: ${data.message}`, 'API_ERROR', data.code);
      }

      const dynamics = this.parseDynamics(data.data);
      this.logger.debug(`获取到 ${dynamics.length} 条动态`, { uid });

      return dynamics;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        `获取动态失败: ${error instanceof Error ? error.message : error}`,
        'API_ERROR',
        500
      );
    }
  }

  /**
   * 解析动态数据
   */
  private parseDynamics(data: any): BilibiliDynamic[] {
    const dynamics: BilibiliDynamic[] = [];

    if (!data || !data.items) {
      return dynamics;
    }

    for (const item of data.items) {
      try {
        const dynamic = this.parseDynamicItem(item);
        if (dynamic) {
          dynamics.push(dynamic);
        }
      } catch (error) {
        this.logger.warn('解析动态失败', { error, item });
      }
    }

    return dynamics;
  }

  /**
   * 解析单个动态项
   */
  private parseDynamicItem(item: any): BilibiliDynamic | null {
    const card = item.card;
    if (!card) {
      return null;
    }

    const cardData = typeof card === 'string' ? JSON.parse(card) : card;
    const desc = item.desc;

    // 解析动态类型
    let type: DynamicType;
    let content = '';
    let images: string[] = [];

    if (cardData.item) {
      // 视频动态
      if (cardData.item.uri) {
        type = DynamicType.AV;
        content = cardData.item.description || '';
      }
      // 图片动态
      else if (cardData.item.pictures) {
        type = DynamicType.DRAW;
        content = cardData.item.description || '';
        images = cardData.item.pictures.map((pic: any) => pic.img_src);
      }
      // 纯文本动态
      else if (cardData.item.content) {
        type = DynamicType.WORD;
        content = cardData.item.content;
      }
      // 文章动态
      else if (cardData.item.title) {
        type = DynamicType.ARTICLE;
        content = cardData.item.title;
      } else {
        return null;
      }
    } else {
      return null;
    }

    return {
      id: desc.dynamic_id_str,
      uid: desc.user_profile.info.uid,
      type,
      content,
      images: images.length > 0 ? images : undefined,
      publishTime: new Date(desc.timestamp * 1000),
      url: `${this.webUrl}/opus/${desc.dynamic_id_str}`,
      rawData: item
    };
  }

  /**
   * 发布动态评论
   */
  async publishComment(request: PublishCommentRequest): Promise<PublishCommentResponse> {
    try {
      this.logger.info(`发布评论: ${request.dynamicId}`, { contentLength: request.content.length });

      // 构建请求参数
      const params: any = {
        oid: request.dynamicId,
        type: 17, // 17表示动态
        message: request.content,
        csrf: this.csrf
      };

      // 如果有图片，添加图片参数
      if (request.images && request.images.length > 0) {
        params.pics = request.images.join(',');
      }

      const url = `${this.baseUrl}/x/v2/reply/add`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Cookie': this.cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': `${this.webUrl}/`,
          'Origin': this.webUrl
        },
        body: new URLSearchParams(params).toString()
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error('发布评论HTTP错误', { status: response.status, errorText });
        throw new AppError(`发布评论失败: HTTP ${response.status}`, 'API_ERROR', response.status);
      }

      const data: BilibiliAPIResponse = await response.json();

      if (data.code !== 0) {
        this.logger.error('发布评论API错误', { code: data.code, message: data.message });
        throw new AppError(`发布评论失败: ${data.message}`, 'API_ERROR', data.code);
      }

      this.logger.info('评论发布成功', { replyId: data.data.reply.reply_id });

      return {
        replyId: data.data.reply.reply_id.toString(),
        replyTime: data.data.reply.like_timestamp || Date.now()
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      this.logger.error('发布评论异常', { error });
      throw new AppError(
        `发布评论失败: ${error instanceof Error ? error.message : error}`,
        'API_ERROR',
        500
      );
    }
  }

  /**
   * 上传图片
   */
  async uploadImage(imagePath: string): Promise<string> {
    try {
      this.logger.info(`上传图片: ${path.basename(imagePath)}`);

      // 检查文件是否存在
      if (!fs.existsSync(imagePath)) {
        throw new AppError(`图片文件不存在: ${imagePath}`, 'FILE_NOT_FOUND_ERROR', 404);
      }

      // 获取上传URL
      const uploadUrl = await this.getUploadUrl();

      // 读取文件
      const fileBuffer = fs.readFileSync(imagePath);
      const fileName = path.basename(imagePath);

      // 构建multipart/form-data
      const boundary = `----WebKitFormBoundary${Date.now()}`;
      const formData = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
        'Content-Type: image/jpeg',
        '',
        fileBuffer.toString('base64'),
        `--${boundary}`,
        'Content-Disposition: form-data; name="biz"',
        '',
        'new_dyn',
        `--${boundary}`,
        'Content-Disposition: form-data; name="csrf"',
        '',
        this.csrf,
        `--${boundary}--`
      ].join('\r\n');

      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Cookie': this.cookie,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': `${this.webUrl}/`
        },
        body: Buffer.from(formData, 'utf-8')
      });

      if (!response.ok) {
        throw new AppError(`上传图片失败: HTTP ${response.status}`, 'API_ERROR', response.status);
      }

      const data: BilibiliAPIResponse = await response.json();

      if (data.code !== 0) {
        throw new AppError(`上传图片失败: ${data.message}`, 'API_ERROR', data.code);
      }

      const imageUrl = data.data.image_url;
      this.logger.info('图片上传成功', { imageUrl });

      return imageUrl;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        `上传图片失败: ${error instanceof Error ? error.message : error}`,
        'API_ERROR',
        500
      );
    }
  }

  /**
   * 获取图片上传URL
   */
  private async getUploadUrl(): Promise<string> {
    const url = `${this.baseUrl}/x/dynamic/feed/draw/upload_bfs`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Cookie': this.cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': `${this.webUrl}/`
      }
    });

    if (!response.ok) {
      throw new AppError(`获取上传URL失败: HTTP ${response.status}`, 'API_ERROR', response.status);
    }

    const data: BilibiliAPIResponse = await response.json();

    if (data.code !== 0) {
      throw new AppError(`获取上传URL失败: ${data.message}`, 'API_ERROR', data.code);
    }

    return data.data.url;
  }

  /**
   * 检查Cookie是否有效
   */
  async isCookieValid(): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/x/web-interface/nav`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Cookie': this.cookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': `${this.webUrl}/`
        }
      });

      if (!response.ok) {
        return false;
      }

      const data: BilibiliAPIResponse = await response.json();
      return data.code === 0 && data.data.isLogin;
    } catch (error) {
      this.logger.warn('检查Cookie有效性失败', { error });
      return false;
    }
  }

  /**
   * 从Cookie中提取CSRF Token
   */
  extractCSRF(cookie: string): string {
    const match = cookie.match(/bili_jct=([^;]+)/);
    if (!match) {
      throw new AppError('无法从Cookie中提取CSRF Token', 'CONFIGURATION_ERROR', 400);
    }
    return match[1];
  }
}
