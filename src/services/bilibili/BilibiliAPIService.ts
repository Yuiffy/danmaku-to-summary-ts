/**
 * B站API服务实现
 */
import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
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

const execAsync = promisify(exec);

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
      // 确保 offset 以字符串形式记录日志，避免大数精度丢失
      this.logger.debug(`获取主播动态: ${uid}`, { offset: String(offset || '') });

      const url = `${this.baseUrl}/x/polymer/web-dynamic/v1/feed/space`;
      const params = new URLSearchParams({
        host_mid: uid,
        offset: offset ? offset.toString() : '',
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
        // 避免大数精度丢失，只记录关键字段
        this.logger.error('获取动态失败', {
          status: response.status,
          uid
        });
        throw new AppError(`获取动态失败: HTTP ${response.status}`, 'API_ERROR', response.status);
      }

      const data: BilibiliAPIResponse = await response.json();

      if (data.code !== 0) {
        // 避免大数精度丢失，只记录关键字段
        this.logger.error('获取动态失败', {
          code: data.code,
          message: data.message,
          uid
        });
        throw new AppError(`获取动态失败: ${data.message}`, 'API_ERROR', data.code);
      }

      const dynamics = this.parseDynamics(data.data);
      // 确保 dynamicId 以字符串形式记录日志，避免大数精度丢失
      this.logger.debug(`获取到 ${dynamics.length} 条动态`, {
        uid,
        dynamicIds: dynamics.map(d => String(d.id))
      });

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
        // 避免 JSON.stringify 导致大数精度丢失，只记录关键字段
        this.logger.warn('解析动态失败', {
          error,
          itemId: String(item?.desc?.dynamic_id_str || '')
        });
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
   * 使用 Python bilibili-api 库处理评论功能
   */
  async publishComment(request: PublishCommentRequest): Promise<PublishCommentResponse> {
    try {
      // 确保 dynamicId 以字符串形式记录日志，避免大数精度丢失
      this.logger.info(`发布评论: ${request.dynamicId}`, {
        dynamicId: String(request.dynamicId),
        contentLength: request.content.length,
        hasImages: !!(request.images && request.images.length > 0),
        images: request.images
      });

      // 解析 Cookie 获取必要的参数
      const sessdata = this.extractCookieValue(this.cookie, 'SESSDATA');
      const bili_jct = this.extractCookieValue(this.cookie, 'bili_jct');
      const dedeuserid = this.extractCookieValue(this.cookie, 'DedeUserID');

      if (!sessdata || !bili_jct || !dedeuserid) {
        throw new AppError('Cookie中缺少必要的参数 (SESSDATA, bili_jct, DedeUserID)', 'CONFIGURATION_ERROR', 400);
      }

      // 调用 Python 脚本发布评论
      // 使用 process.cwd() 获取项目根目录，确保路径正确
      const scriptPath = path.join(process.cwd(), 'src/scripts/bilibili_comment.py');
      const command = `python "${scriptPath}" "${request.dynamicId}" "${request.content}" "${sessdata}" "${bili_jct}" "${dedeuserid}"`;

      this.logger.info('调用Python脚本发布评论', { command });

      const { stdout, stderr } = await execAsync(command);

      // 输出Python脚本的日志（stderr）
      if (stderr) {
        // 按行分割日志并逐行输出
        const logLines = stderr.trim().split('\n');
        for (const line of logLines) {
          if (line.includes('[ERROR]')) {
            this.logger.error(`Python: ${line}`);
          } else if (line.includes('[WARNING]')) {
            this.logger.warn(`Python: ${line}`);
          } else if (line.includes('[OK]')) {
            this.logger.info(`Python: ${line}`);
          } else {
            this.logger.info(`Python: ${line}`);
          }
        }
      }

      // 解析 Python 脚本的输出（stdout只包含JSON）
      const result = JSON.parse(stdout);

      if (!result.success) {
        this.logger.error('Python脚本返回错误', { result });
        throw new AppError(`发布评论失败: ${result.message || result.error}`, 'API_ERROR', 500);
      }

      this.logger.info('评论发布成功', { replyId: result.reply_id });

      return {
        replyId: result.reply_id,
        replyTime: Date.now()
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
   * 从Cookie中提取指定值
   */
  private extractCookieValue(cookie: string, name: string): string | null {
    const match = cookie.match(new RegExp(`${name}=([^;]+)`));
    return match ? match[1] : null;
  }

  /**
   * 上传图片
   */
  async uploadImage(imagePath: string): Promise<string> {
    try {
      this.logger.info(`上传图片: ${path.basename(imagePath)}`, { fullPath: imagePath });

      // 检查文件是否存在
      if (!fs.existsSync(imagePath)) {
        throw new AppError(`图片文件不存在: ${imagePath}`, 'FILE_NOT_FOUND_ERROR', 404);
      }

      // 获取上传URL
      const uploadUrl = await this.getUploadUrl();
      this.logger.info('获取上传URL成功', { uploadUrl });

      // 读取文件
      const fileBuffer = fs.readFileSync(imagePath);
      const fileName = path.basename(imagePath);
      this.logger.info('读取文件成功', { fileName, fileSize: fileBuffer.length });

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

      this.logger.info('发送图片上传请求', { uploadUrl, boundary });

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
        const errorText = await response.text();
        // 避免大数精度丢失，只记录关键字段
        this.logger.error('上传图片HTTP错误', {
          status: response.status,
          errorText: errorText.substring(0, 200)
        });
        throw new AppError(`上传图片失败: HTTP ${response.status}`, 'API_ERROR', response.status);
      }

      const data: BilibiliAPIResponse = await response.json();
      // 避免大数精度丢失，只记录关键字段
      this.logger.info('图片上传API响应', {
        code: data.code,
        message: data.message,
        imageUrl: data.data?.image_url || ''
      });

      if (data.code !== 0) {
        // 避免大数精度丢失，只记录关键字段
        this.logger.error('上传图片失败', {
          code: data.code,
          message: data.message
        });
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
      // 避免大数精度丢失，只记录关键字段
      this.logger.error('获取上传URL失败', {
        status: response.status
      });
      throw new AppError(`获取上传URL失败: HTTP ${response.status}`, 'API_ERROR', response.status);
    }

    const data: BilibiliAPIResponse = await response.json();

    if (data.code !== 0) {
      // 避免大数精度丢失，只记录关键字段
      this.logger.error('获取上传URL失败', {
        code: data.code,
        message: data.message
      });
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
        // 避免大数精度丢失，只记录关键字段
        this.logger.warn('检查Cookie有效性失败', {
          status: response.status
        });
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
