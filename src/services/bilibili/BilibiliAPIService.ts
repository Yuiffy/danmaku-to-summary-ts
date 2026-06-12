/**
 * B站API服务实现
 */
import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { getLogger } from '../../core/logging/LogManager';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { AppError } from '../../core/errors/AppError';
import { WeChatWorkNotifier } from '../notification/WeChatWorkNotifier';
import { IBilibiliAPIService } from './interfaces/IBilibiliAPIService';
import {
  BilibiliDynamic,
  PublishCommentRequest,
  PublishCommentResponse,
  BilibiliAPIResponse
} from './interfaces/types';
import { parseDynamicItems } from './DynamicParser';

/**
 * B站API服务实现
 */
export class BilibiliAPIService implements IBilibiliAPIService {
  private logger = getLogger('BilibiliAPIService');
  private cookie!: string;
  private csrf!: string;
  private acTimeValue = '';
  private baseUrl = 'https://api.bilibili.com';
  private webUrl = 'https://www.bilibili.com';
  private secretConfigMtimeMs = 0;
  private notifier?: WeChatWorkNotifier;
  private lastCredentialAlertAt = 0;

  constructor(notifier?: WeChatWorkNotifier) {
    this.notifier = notifier;
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
      this.csrf = this.extractCookieValue(this.cookie, 'bili_jct') || bilibiliSecret.csrf || '';
      this.acTimeValue = bilibiliSecret.ac_time_value || bilibiliSecret.acTimeValue || this.extractCookieValue(this.cookie, 'ac_time_value') || '';

      if (!this.csrf) {
        throw new AppError('无法从Cookie中提取CSRF Token (bili_jct)', 'CONFIGURATION_ERROR', 400);
      }

      this.logger.info('B站API服务配置加载完成');
    } catch (error) {
      this.logger.error('加载B站配置失败', undefined, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * 根据直播间ID获取主播UID
   */
  async getUidByRoomId(roomId: string): Promise<string> {
    try {
      await this.refreshConfigIfChanged();
      this.logger.debug(`根据直播间ID获取UID: ${roomId}`);

      // 解析 Cookie 获取必要的参数
      const sessdata = this.extractCookieValue(this.cookie, 'SESSDATA');
      const bili_jct = this.extractCookieValue(this.cookie, 'bili_jct');
      const dedeuserid = this.extractCookieValue(this.cookie, 'DedeUserID');

      if (!sessdata || !bili_jct || !dedeuserid) {
        throw new AppError('Cookie中缺少必要的参数 (SESSDATA, bili_jct, DedeUserID)', 'CONFIGURATION_ERROR', 400);
      }

      // 调用 Python 脚本获取直播间信息
      const scriptPath = path.join(process.cwd(), 'src/scripts/bilibili_room_info.py');
      const args = [scriptPath, roomId, sessdata, bili_jct, dedeuserid];

      this.logger.debug('调用Python脚本获取直播间信息', { scriptPath, argsCount: args.length });

      // 使用 spawn 替代 exec，避免弹出黑窗口
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const pythonProcess = spawn('python', args, {
          windowsHide: true
        });

        let stdout = '';
        let stderr = '';

        // 30秒超时：B站 API 偶尔卡住，不能无限等
        const timeout = setTimeout(() => {
          pythonProcess.kill();
          reject(this.buildPythonFailureError('', -1, '获取直播间信息超时(30s)'));
        }, 30000);

        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        pythonProcess.on('close', (code) => {
          clearTimeout(timeout);
          // 无论成功还是失败,都先输出日志
          if (stderr) {
            const logLines = stderr.trim().split('\n');
            for (const line of logLines) {
              if (line.includes('[ERROR]')) {
                this.logger.error(`Python: ${line}`);
              } else if (line.includes('[WARNING]')) {
                this.logger.warn(`Python: ${line}`);
              } else if (line.includes('[OK]') || line.includes('[INFO]')) {
                this.logger.info(`Python: ${line}`);
              } else if (line.trim()) {
                this.logger.debug(`Python: ${line}`);
              }
            }
          }
          
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }

          // exit code != 0：记录 stdout 和 stderr 用于排查
          if (stdout.trim()) {
            this.logger.error(`Python stdout: ${stdout.trim().slice(0, 500)}`);
          }
          if (stderr.trim()) {
            this.logger.error(`Python stderr: ${stderr.trim().slice(0, 500)}`);
          }
          reject(this.buildPythonFailureError(stdout, code, '获取直播间信息失败', stderr));
        });

        pythonProcess.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // 解析 Python 脚本的输出（stdout只包含JSON）
      const jsonResult = JSON.parse(result.stdout);

      if (!jsonResult.success) {
        this.logger.error('Python脚本返回错误', { result: jsonResult });
        throw new AppError(`获取直播间信息失败: ${jsonResult.message || jsonResult.error}`, 'API_ERROR', 500);
      }

      // 从返回的数据中获取UID
      const uid = String(jsonResult.data.room_info.uid);
      this.logger.debug(`通过直播间API获取UID成功: ${roomId} -> ${uid}`);

      return uid;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      this.logger.error('获取UID失败', undefined, error instanceof Error ? error : new Error(String(error)));
      throw new AppError(
        `获取UID失败: ${error instanceof Error ? error.message : error}`,
        'API_ERROR',
        500
      );
    }
  }

  /**
   * 获取主播动态列表
   */
  async getDynamics(uid: string, offset?: string): Promise<BilibiliDynamic[]> {
    try {
      await this.refreshConfigIfChanged();
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
        if (this.isCredentialErrorMessage(data.message, data.code)) {
          throw new AppError(
            `获取动态失败: ${data.message}${this.getCookieUpdateHint()}`,
            'AUTHENTICATION_ERROR',
            401
          );
        }
        throw new AppError(`获取动态失败: ${data.message}`, 'API_ERROR', data.code);
      }

      // 记录API返回的数据结构
      this.logger.debug('API返回数据结构', {
        hasData: !!data.data,
        dataKeys: data.data ? Object.keys(data.data) : [],
        hasItems: !!(data.data && data.data.items),
        itemsCount: data.data && data.data.items ? data.data.items.length : 0
      });

      const dynamics = this.parseDynamics(data.data);
      
      // 按发布时间降序排序，确保最新的动态排在前面（过滤置顶动态）
      dynamics.sort((a, b) => b.publishTime.getTime() - a.publishTime.getTime());
      
      // 确保 dynamicId 以字符串形式记录日志，避免大数精度丢失
      this.logger.debug(`获取到 ${dynamics.length} 条动态（已按时间排序）`, {
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
    if (!data) {
      this.logger.warn('API返回数据为空');
      return [];
    }

    if (!data.items) {
      this.logger.warn('API返回数据中没有items字段', { dataKeys: Object.keys(data) });
      return [];
    }

    this.logger.debug(`API返回 ${data.items.length} 条动态数据`);

    // 使用DynamicParser解析动态数据
    return parseDynamicItems(data.items);
  }

  /**
   * 发布动态评论
   * 使用 Python bilibili-api 库处理评论功能
   */
  async publishComment(request: PublishCommentRequest): Promise<PublishCommentResponse> {
    try {
      await this.refreshConfigIfChanged();
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

      // 使用 spawn 传递参数数组，避免 shell 解析问题
      const args = [
        scriptPath,
        request.dynamicId,
        request.content,
        sessdata,
        bili_jct,
        dedeuserid
      ];

      // 如果有图片，添加图片路径参数
      if (request.images && request.images.length > 0) {
        args.push(request.images[0]);
      } else {
        args.push('');
      }
      args.push(this.buildCredentialPayload());

      this.logger.info('调用Python脚本发布评论', { scriptPath, argsCount: args.length });

      // 使用 Promise 包装 spawn
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const pythonProcess = spawn('python', args, {
          windowsHide: true
        });

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        pythonProcess.on('close', (code) => {
          // 无论成功还是失败,都先输出日志
          if (stderr) {
            const logLines = stderr.trim().split('\n');
            for (const line of logLines) {
              if (line.includes('[ERROR]')) {
                this.logger.error(`Python: ${line}`);
              } else if (line.includes('[WARNING]')) {
                this.logger.warn(`Python: ${line}`);
              } else if (line.includes('[OK]') || line.includes('[INFO]')) {
                this.logger.info(`Python: ${line}`);
              } else if (line.trim()) {
                this.logger.info(`Python: ${line}`);
              }
            }
          }
          
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }

          if (stdout.trim()) {
            this.logger.error(`Python stdout: ${stdout.trim()}`);
          }
          reject(this.buildPythonFailureError(stdout, code, '发布评论失败'));
        });

        pythonProcess.on('error', (err) => {
          reject(err);
        });
      });

      // 解析 Python 脚本的输出（stdout只包含JSON）
      const jsonResult = this.parsePythonJsonResult(result.stdout) || JSON.parse(result.stdout);

      if (jsonResult.refreshed_credential) {
        await this.persistRefreshedCredential(jsonResult.refreshed_credential);
      }

      if (!jsonResult.success) {
        this.logger.error('Python脚本返回错误', { result: jsonResult });
        // 优先使用详细的 error 字段，它通常包含 B站 API 的具体报错信息
        const detailedError = this.normalizePythonResultError(jsonResult);
        const code = this.isCredentialErrorMessage(detailedError)
          ? 'AUTHENTICATION_ERROR'
          : 'API_ERROR';
        const status = code === 'AUTHENTICATION_ERROR' ? 401 : 500;
        if (
          (code === 'AUTHENTICATION_ERROR' || jsonResult.credential_invalid || jsonResult.credential_refresh_failed) &&
          !this.isTransientNetworkError(detailedError)
        ) {
          await this.notifyCredentialIssue(detailedError, {
            dynamicId: String(request.dynamicId),
            credentialInvalid: !!jsonResult.credential_invalid,
            credentialRefreshFailed: !!jsonResult.credential_refresh_failed,
            credentialRefreshed: !!jsonResult.credential_refreshed
          });
        }
        throw new AppError(`发布评论失败: ${detailedError}`, code, status);
      }

      this.logger.info('评论发布成功', { replyId: jsonResult.reply_id, imageUrl: jsonResult.image_url });

      return {
        replyId: jsonResult.reply_id,
        replyTime: Date.now(),
        imageUrl: jsonResult.image_url
      };
    } catch (error) {
      if (error instanceof AppError) {
        if (error.code === 'AUTHENTICATION_ERROR' && !this.isTransientNetworkError(error.message)) {
          await this.notifyCredentialIssue(error.message, { dynamicId: String(request.dynamicId) });
        }
        throw error;
      }
      this.logger.error('发布评论异常', undefined, error instanceof Error ? error : new Error(String(error)));
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
      await this.refreshConfigIfChanged();
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

  private async refreshConfigIfChanged(): Promise<void> {
    const secretPath = path.join(process.cwd(), 'config', 'secret.json');
    try {
      const stat = fs.statSync(secretPath);
      if (stat.mtimeMs > this.secretConfigMtimeMs) {
        this.secretConfigMtimeMs = stat.mtimeMs;
        await ConfigProvider.reload();
        this.loadConfig();
        this.logger.info('检测到B站Secret配置变更，已重新加载Cookie配置');
      }
    } catch (error) {
      this.logger.warn('检查B站Secret配置变更失败', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private buildCredentialPayload(): string {
    return Buffer.from(JSON.stringify({
      buvid3: this.extractCookieValue(this.cookie, 'buvid3'),
      buvid4: this.extractCookieValue(this.cookie, 'buvid4'),
      ac_time_value: this.acTimeValue
    }), 'utf-8').toString('base64');
  }

  private async persistRefreshedCredential(refreshed: any): Promise<void> {
    const secretPath = path.join(process.cwd(), 'config', 'secret.json');
    try {
      if (!refreshed || !refreshed.sessdata || !refreshed.bili_jct || !refreshed.dedeuserid) {
        this.logger.warn('Bilibili cookie refresh result is missing required fields; skip secret writeback');
        return;
      }

      const secretConfig = JSON.parse(fs.readFileSync(secretPath, 'utf-8').replace(/^\uFEFF/u, ''));
      secretConfig.bilibili = secretConfig.bilibili || {};

      let nextCookie = String(secretConfig.bilibili.cookie || this.cookie);
      nextCookie = this.upsertCookieValue(nextCookie, 'SESSDATA', refreshed.sessdata);
      nextCookie = this.upsertCookieValue(nextCookie, 'bili_jct', refreshed.bili_jct);
      nextCookie = this.upsertCookieValue(nextCookie, 'DedeUserID', refreshed.dedeuserid);
      if (refreshed.buvid3) nextCookie = this.upsertCookieValue(nextCookie, 'buvid3', refreshed.buvid3);
      if (refreshed.buvid4) nextCookie = this.upsertCookieValue(nextCookie, 'buvid4', refreshed.buvid4);

      secretConfig.bilibili.cookie = nextCookie;
      secretConfig.bilibili.csrf = refreshed.bili_jct;
      if (refreshed.ac_time_value) {
        secretConfig.bilibili.ac_time_value = refreshed.ac_time_value;
      }

      fs.writeFileSync(secretPath, `${JSON.stringify(secretConfig, null, 2)}\n`, 'utf-8');
      this.secretConfigMtimeMs = fs.statSync(secretPath).mtimeMs;
      await ConfigProvider.reload();
      this.loadConfig();
      this.logger.info('Bilibili cookie refreshed and written back to config/secret.json');
    } catch (error) {
      this.logger.error('Failed to write refreshed Bilibili cookie', undefined, error instanceof Error ? error : new Error(String(error)));
      await this.notifyCredentialIssue(`Cookie refreshed but secret writeback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private upsertCookieValue(cookie: string, name: string, value: string): string {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|;\\s*)${escapedName}=[^;]*`);
    if (pattern.test(cookie)) {
      return cookie.replace(pattern, `$1${name}=${value}`);
    }
    return cookie ? `${cookie.replace(/;\s*$/, '')}; ${name}=${value}` : `${name}=${value}`;
  }

  private async notifyCredentialIssue(message: string, details?: Record<string, any>): Promise<void> {
    const now = Date.now();
    if (now - this.lastCredentialAlertAt < 30 * 60 * 1000) return;
    this.lastCredentialAlertAt = now;

    const notifier = this.getNotifier();
    if (!notifier) return;

    const lines = [
      'Bilibili comment cookie needs attention',
      '',
      `Error: ${message}`,
      `Time: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    ];

    if (details) {
      lines.push('', 'Context:');
      for (const [key, value] of Object.entries(details)) {
        lines.push(`${key}: ${String(value)}`);
      }
    }

    lines.push('', 'Update config/secret.json bilibili.cookie and bilibili.ac_time_value from browser localStorage if refresh cannot recover it.');
    await notifier.sendMarkdown(lines.join('\n'));
  }

  private getNotifier(): WeChatWorkNotifier | undefined {
    if (this.notifier) return this.notifier;
    try {
      const webhookUrl = ConfigProvider.getConfig().wechatWork?.webhookUrl;
      if (webhookUrl) this.notifier = new WeChatWorkNotifier(webhookUrl);
    } catch {
      return undefined;
    }
    return this.notifier;
  }
  private parsePythonJsonResult(stdout: string): any | null {
    const lines = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (!line.startsWith('{') || !line.endsWith('}')) {
        continue;
      }

      try {
        return JSON.parse(line);
      } catch {
        continue;
      }
    }

    return null;
  }

  private buildPythonFailureError(
    stdout: string,
    exitCode: number | null,
    fallbackPrefix: string,
    stderr?: string,
  ): Error {
    const jsonResult = this.parsePythonJsonResult(stdout);
    if (jsonResult) {
      const detailedError = this.normalizePythonResultError(jsonResult);
      const code = this.isCredentialErrorMessage(detailedError)
        ? 'AUTHENTICATION_ERROR'
        : 'API_ERROR';
      const status = code === 'AUTHENTICATION_ERROR' ? 401 : 500;
      return new AppError(`${fallbackPrefix}: ${detailedError}`, code, status);
    }

    // stdout 解析不出 JSON：带上 stderr 帮助排查
    const stderrInfo = stderr ? ` stderr=${stderr.trim().slice(0, 200)}` : '';
    return new Error(`Python脚本退出码: ${exitCode}${stderrInfo}`);
  }

  private normalizePythonResultError(result: any): string {
    const rawError = result?.error || result?.message || '未知错误';
    const message = String(rawError);
    return this.isCredentialErrorMessage(message)
      ? `${message}${this.getCookieUpdateHint()}`
      : message;
  }

  private isCredentialErrorMessage(message?: string, code?: number): boolean {
    const normalized = String(message || '').toLowerCase();
    if (this.isTransientNetworkError(normalized)) {
      return false;
    }

    return (
      code === -101 ||
      code === 401 ||
      normalized.includes('sessdata') ||
      normalized.includes('bili_jct') ||
      normalized.includes('csrf') ||
      normalized.includes('cookie') ||
      normalized.includes('凭证无效') ||
      normalized.includes('账号未登录') ||
      normalized.includes('未登录') ||
      normalized.includes('登录失效')
    );
  }

  private isTransientNetworkError(message?: string): boolean {
    const normalized = String(message || '').toLowerCase();
    return (
      normalized.includes('cannot connect') ||
      normalized.includes('connect to host') ||
      normalized.includes('timeout') ||
      normalized.includes('timed out') ||
      normalized.includes('etimedout') ||
      normalized.includes('econnreset') ||
      normalized.includes('enotfound') ||
      normalized.includes('network') ||
      normalized.includes('信号灯超时时间已到') ||
      normalized.includes('淇″彿鐏秴鏃舵椂闂村凡鍒?')
    );
  }

  private getCookieUpdateHint(): string {
    return '。请更新 config/secret.json 中 bilibili.cookie（bili_jct 会自动从 Cookie 提取），保存后服务会自动重新加载配置；也可以调用 GET /api/bilibili/check-cookie 验证。';
  }
}
