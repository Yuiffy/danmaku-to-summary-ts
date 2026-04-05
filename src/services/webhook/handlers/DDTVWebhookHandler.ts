import { Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { IWebhookHandler } from '../IWebhookService';
import { getLogger } from '../../../core/logging/LogManager';
import { ConfigProvider } from '../../../core/config/ConfigProvider';
import { FileStabilityChecker } from '../FileStabilityChecker';
import { DuplicateProcessorGuard } from '../DuplicateProcessorGuard';
import { WeChatWorkNotifier } from '../../notification/WeChatWorkNotifier';
import { listRelevantProcesses, terminateProcessTree } from '../../../utils/processCleanup';

/**
 * DDTV Webhook处理器
 */
export class DDTVWebhookHandler implements IWebhookHandler {
  readonly name = 'DDTV Webhook Handler';
  readonly path = '/ddtv';
  readonly enabled = true;

  private logger = getLogger('DDTVWebhookHandler');
  private stabilityChecker = new FileStabilityChecker();
  private duplicateGuard = new DuplicateProcessorGuard();
  private notifier?: WeChatWorkNotifier;

  constructor(notifier?: WeChatWorkNotifier) {
    this.notifier = notifier;
  }


  /**
   * 注册Express路由
   */
  registerRoutes(app: any): void {
    app.post(this.path, this.handleRequest.bind(this));
    this.logger.info(`注册DDTV Webhook处理器，路径: ${this.path}`);
  }

  /**
   * 处理Webhook请求
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    const roomName = req.body?.data?.Name || req.body?.room_info?.uname || '未知主播';
    const roomId = req.body?.data?.RoomId || req.body?.room_info?.roomid || req.body?.room_info?.roomId || req.body?.roomId || req.body?.room || req.body?.data?.roomId || 'unknown';
    
    try {
      const payload = req.body;
      const cmd = payload.cmd || 'Unknown';
      const eventTime = new Date().toLocaleString();

      // 验证请求
      if (!this.validateRequest(req)) {
        res.status(400).send('Invalid request');
        return;
      }

      // 记录事件
      this.logEvent(payload, cmd, eventTime);

      // 处理配置变更事件
      if (cmd === 'ModifyConfiguration' || cmd === 'UpdateToConfigurationFile') {
        this.logger.info(`配置变更: ${payload.message || '未知配置'}`);
        res.send('Configuration change logged');
        return;
      }

      // 处理登陆失效事件
      if (cmd === 'InvalidLoginStatus') {
        await this.handleInvalidLogin(payload);
        res.send('Login invalid notification shown');
        return;
      }

      // 处理文件事件
      await this.handleFileEvent(payload, cmd, roomName, roomId);
      
      res.send('Processing Started (or logic branched)');
    } catch (error: any) {
      this.logger.error(`处理DDTV Webhook时出错: ${error.message}`, { error });
      
      // 发送企微错误通知
      if (this.notifier) {
        await this.notifier.notifyProcessError(
          roomName,
          'Webhook请求处理',
          error.message,
          roomId,
          { cmd: req.body?.cmd, error: error.stack }
        );
      }
      
      res.status(500).send('Internal server error');
    }
  }

  /**
   * 验证请求有效性
   */
  validateRequest(req: Request): boolean {
    // 检查请求体是否存在
    if (!req.body || typeof req.body !== 'object') {
      this.logger.warn('无效的请求体');
      return false;
    }

    // 检查必要字段
    const payload = req.body;
    if (!payload.cmd) {
      this.logger.warn('缺少cmd字段');
      return false;
    }

    return true;
  }

  /**
   * 记录事件日志
   */
  private logEvent(payload: any, cmd: string, eventTime: string): void {
    this.logger.info(`\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`);
    this.logger.info(`📅 时间: ${eventTime}`);
    this.logger.info(`📨 事件 (cmd): ${cmd}`);

    // 提取主播信息
    const roomName = payload.data?.Name || payload.room_info?.uname || '未知主播';
    const roomId = payload.data?.RoomId || payload.room_info?.roomid || payload.room_info?.roomId || payload.roomId || payload.room || payload.data?.roomId || 'unknown';
    this.logger.info(`👤 主播: ${roomName}`);
    this.logger.info(`🏷️ 房间ID: ${roomId}`);

    // 压缩弹幕数据以减小日志大小
    const compressedPayload = this.compressDanmuData(payload);
    this.logger.info(`📦 事件数据:`, { payload: compressedPayload });
    this.logger.info(`▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`);
  }

  /**
   * 处理登陆失效事件
   */
  private async handleInvalidLogin(payload: any): Promise<void> {
    const msg = payload.message || '触发登陆失效事件';
    this.logger.warn(`登陆失效提醒: ${msg}`);
    
    // 显示Windows通知
    await this.showWindowsNotification('DDTV 提醒', `登录态已失效！\n\n${msg}\n\n请尽快处理以免影响弹幕录制。`);
  }

  /**
   * 处理文件事件
   */
  private async handleFileEvent(payload: any, cmd: string, roomName: string, roomId: string): Promise<void> {
    // 提取视频和弹幕文件
    const { videoFiles, xmlFiles } = this.extractFiles(payload, cmd);
    
    if (videoFiles.length === 0) {
      this.logger.info('忽略：未发现视频文件 (可能是配置变更或单纯的状态心跳)');
      return;
    }

    // 特殊处理SaveBulletScreenFile事件
    if (cmd === 'SaveBulletScreenFile' && videoFiles.length === 0) {
      await this.handleSaveBulletScreenFile(payload, xmlFiles, roomName, roomId);
      return;
    }

    // 处理普通文件事件
    await this.processVideoFiles(videoFiles, xmlFiles, payload, roomName, roomId);
  }

  /**
   * 提取文件列表
   */
  private extractFiles(payload: any, cmd: string): { videoFiles: string[]; xmlFiles: string[] } {
    let videoFiles: string[] = [];
    let xmlFiles: string[] = [];

    // 1. 尝试从 data.DownInfo.DownloadFileList 提取 (DDTV5 常见结构)
    const downInfo = payload.data?.DownInfo;
    const downloadFileList = downInfo?.DownloadFileList;

    if (downloadFileList) {
      if (Array.isArray(downloadFileList.VideoFile)) {
        videoFiles = downloadFileList.VideoFile.filter((f: string) => f.endsWith('.mp4'));
      }
      if (Array.isArray(downloadFileList.DanmuFile)) {
        xmlFiles = downloadFileList.DanmuFile.filter((f: string) => f.endsWith('.xml'));
      }
    } 
    // 2. 尝试从 files 提取 (部分版本或 webhookGo 转发结构)
    else if (payload.files && Array.isArray(payload.files)) {
      payload.files.forEach((f: any) => {
        const fPath = f.path || f; // 兼容 {path: string} 或 string
        if (typeof fPath === 'string') {
          if (fPath.endsWith('.mp4')) videoFiles.push(fPath);
          if (fPath.endsWith('.xml')) xmlFiles.push(fPath);
        }
      });
    }

    return { videoFiles, xmlFiles };
  }

  /**
   * 处理SaveBulletScreenFile事件
   */
  private async handleSaveBulletScreenFile(payload: any, xmlFiles: string[], roomName: string, roomId: string): Promise<void> {
    const downInfo = payload.data?.DownInfo;
    const downloadFileList = downInfo?.DownloadFileList;
    
    if (!downloadFileList?.CurrentOperationVideoFile || xmlFiles.length === 0) {
      this.logger.warn('SaveBulletScreenFile事件缺少必要数据');
      return;
    }

    const originalVideoPath = path.normalize(downloadFileList.CurrentOperationVideoFile);
    const fixVideoPath = originalVideoPath.replace('_original.mp4', '_fix.mp4');

    this.logger.info(`SaveBulletScreenFile事件：等待fix视频生成... (${path.basename(fixVideoPath)})`);

    // 检查去重
    if (this.duplicateGuard.isDuplicate(fixVideoPath)) {
      this.logger.warn(`跳过：文件已在处理队列中 -> ${path.basename(fixVideoPath)}`);
      return;
    }

    // 等待文件创建
    const config = ConfigProvider.getConfig();
    const maxWaitTime = config.webhook.timeouts.fixVideoWait || 60000; // 60秒
    const checkInterval = 5000; // 每5秒检查一次
    let waitedTime = 0;
    let fileFound = false;
    
    this.logger.info(`等待fix视频文件生成，最多等待${maxWaitTime/1000}秒...`);
    
    while (waitedTime < maxWaitTime && !fileFound) {
      await this.sleep(checkInterval);
      waitedTime += checkInterval;
      
      if (fs.existsSync(fixVideoPath)) {
        fileFound = true;
        this.logger.info(`发现fix视频文件 (等待了${waitedTime/1000}秒): ${path.basename(fixVideoPath)}`);
        break;
      }
      
      this.logger.info(`等待中... ${waitedTime/1000}秒 (${path.basename(fixVideoPath)})`);
    }
    
    if (fileFound) {
      // 等待文件稳定
      const isStable = await this.stabilityChecker.waitForFileStability(fixVideoPath);
      if (!isStable) {
        this.logger.error(`文件稳定性检查失败，跳过处理: ${path.basename(fixVideoPath)}`);
        return;
      }

      // 标记为处理中
      this.duplicateGuard.markAsProcessing(fixVideoPath);

      // 启动处理流程
      const targetXml = path.normalize(xmlFiles[0]);
      await this.startProcessing(fixVideoPath, targetXml, payload, roomName, roomId);
    } else {
      this.logger.warn(`超时未发现fix视频文件，跳过处理: ${path.basename(fixVideoPath)}`);
    }
  }

  /**
   * 处理视频文件
   */
  private async processVideoFiles(videoFiles: string[], xmlFiles: string[], payload: any, roomName: string, roomId: string): Promise<void> {
    // 优先处理 fix.mp4，如果没有则处理 original.mp4
    let targetVideo = videoFiles.find(f => f.includes('fix.mp4')) || videoFiles[0];
    targetVideo = path.normalize(targetVideo);

    // 检查文件是否存在
    if (!fs.existsSync(targetVideo)) {
      this.logger.error(`目标视频文件不存在 -> ${path.basename(targetVideo)}`);
      
      // 发送企微错误通知
      if (this.notifier) {
        await this.notifier.notifyProcessError(
          roomName,
          '视频文件检查',
          `目标视频文件不存在: ${path.basename(targetVideo)}`,
          roomId,
          { targetVideo }
        );
      }
      return;
    }

    // 检查去重
    if (this.duplicateGuard.isDuplicate(targetVideo)) {
      this.logger.warn(`跳过：文件已在处理队列中 -> ${path.basename(targetVideo)}`);
      return;
    }

    // 标记为处理中
    this.duplicateGuard.markAsProcessing(targetVideo);

    // 等待文件稳定
    const isVideoStable = await this.stabilityChecker.waitForFileStability(targetVideo);
    if (!isVideoStable) {
      this.logger.error(`视频文件稳定性检查失败，跳过处理: ${path.basename(targetVideo)}`);
      this.duplicateGuard.markAsProcessed(targetVideo); // 标记为处理完成（失败）
      
      // 发送企微错误通知
      if (this.notifier) {
        await this.notifier.notifyProcessError(
          roomName,
          '文件稳定性检查',
          `视频文件稳定性检查失败: ${path.basename(targetVideo)}`,
          roomId,
          { targetVideo }
        );
      }
      return;
    }

    // 选择对应的xml文件
    let targetXml = null;
    if (xmlFiles.length > 0) {
      const videoBaseName = path.basename(targetVideo, path.extname(targetVideo));
      const baseWithoutSuffix = videoBaseName.replace(/(_fix|_original)$/, '');
      const expectedXmlName = baseWithoutSuffix + '.xml';
      
      // 查找完全匹配的xml文件
      const exactMatch = xmlFiles.find(xml => path.basename(xml) === expectedXmlName);
      if (exactMatch) {
        targetXml = path.normalize(exactMatch);
        this.logger.info(`找到完全匹配的弹幕文件: ${path.basename(targetXml)}`);
      } else {
        // 如果没有完全匹配，尝试查找包含视频文件名的xml文件
        const matchedXml = xmlFiles.find(xml => path.basename(xml, '.xml').includes(baseWithoutSuffix));
        targetXml = matchedXml ? path.normalize(matchedXml) : path.normalize(xmlFiles[0]);
        if (matchedXml) {
          this.logger.info(`找到包含视频名的弹幕文件: ${path.basename(targetXml)}`);
        } else {
          this.logger.info(`使用第一个可用的弹幕文件: ${path.basename(targetXml)}`);
        }
      }
    }

    // 启动处理流程
    await this.startProcessing(targetVideo, targetXml, payload, roomName, roomId);
  }

  /**
   * 启动处理流程
   */
  private async startProcessing(videoPath: string, xmlPath: string | null, payload: any, roomName: string, roomId: string): Promise<void> {
    try {
      const roomId = payload.data?.RoomId || payload.room_info?.roomid || payload.room_info?.roomId || payload.roomId || payload.room || payload.data?.roomId || 'unknown';
      
      // 获取配置
      const config = ConfigProvider.getConfig();
      const scriptPath = 'src/scripts/enhanced_auto_summary.js'; // 硬编码路径，后续可从配置读取
      
      // 构建参数
      const args = [scriptPath, videoPath];
      if (xmlPath) args.push(xmlPath);

      this.logger.info(`启动处理流程: ${path.basename(videoPath)}`);
      
      // 启动子进程
      const ps: ChildProcess = spawn('node', args, {
        cwd: process.cwd(),
        windowsHide: true,
        env: { 
          ...process.env, 
          NODE_ENV: 'production', // 使用production而不是automation
          ROOM_ID: String(roomId) 
        }
      });
      this.logger.info(`处理子进程已启动: pid=${ps.pid ?? 'unknown'}, file=${path.basename(videoPath)}`);

      // 设置超时
      const processTimeout = config.webhook.timeouts.processTimeout || 30 * 60 * 1000; // 30分钟
      const timeoutId = setTimeout(async () => {
        this.logger.warn(`进程超时，强制终止: ${path.basename(videoPath)}`);
        await terminateProcessTree(ps, {
          gracePeriodMs: 5000,
          label: `DDTV处理进程(${path.basename(videoPath)})`,
          logger: this.logger
        });
        const processes = await listRelevantProcesses();
        if (processes.length > 0) {
          this.logger.warn(`超时清理后的相关进程快照: ${processes.join(' | ')}`);
        }
        this.duplicateGuard.markAsProcessed(videoPath);
      }, processTimeout);

      // 处理输出
      ps.stdout?.on('data', (data: Buffer) => {
        this.logger.info(`[处理进程] ${data.toString().trim()}`);
      });

      ps.stderr?.on('data', (data: Buffer) => {
        this.logger.error(`[处理进程错误] ${data.toString().trim()}`);
      });

      // 处理进程事件
      ps.on('error', (error: Error) => {
        this.logger.error(`处理进程错误: ${error.message}`);
        clearTimeout(timeoutId);
        this.duplicateGuard.markAsProcessed(videoPath);
      });

      ps.on('close', (code: number | null) => {
        clearTimeout(timeoutId);
        this.logger.info(`处理流程结束 (退出码: ${code}): ${path.basename(videoPath)}`);
        this.duplicateGuard.markAsProcessed(videoPath);
      });

    } catch (error: any) {
      this.logger.error(`启动处理流程时出错: ${error.message}`, { error });
      this.duplicateGuard.markAsProcessed(videoPath);
      
      // 发送企微错误通知
      if (this.notifier) {
        await this.notifier.notifyProcessError(
          roomName,
          '启动处理流程',
          error.message,
          roomId,
          { videoPath, xmlPath, error: error.stack }
        );
      }
    }
  }

  /**
   * 压缩弹幕数据
   */
  private compressDanmuData(obj: any): any {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj;
    }

    const result = { ...obj };

    // 检查是否是弹幕消息对象
    if (result.Danmu || result.SuperChat || result.Gift || result.GuardBuy) {
      if (Array.isArray(result.Danmu)) {
        result.Danmu = this.compressArray(result.Danmu, '弹幕');
      }
      if (Array.isArray(result.SuperChat)) {
        result.SuperChat = this.compressArray(result.SuperChat, 'SC');
      }
      if (Array.isArray(result.Gift)) {
        result.Gift = this.compressArray(result.Gift, '礼物');
      }
      if (Array.isArray(result.GuardBuy)) {
        result.GuardBuy = this.compressArray(result.GuardBuy, '舰长');
      }
    }

    // 递归处理所有子对象
    for (const key in result) {
      if (result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
        result[key] = this.compressDanmuData(result[key]);
      }
    }

    return result;
  }

  /**
   * 压缩数组显示
   */
  private compressArray(arr: any[], fieldName: string): any[] {
    if (!Array.isArray(arr) || arr.length === 0) {
      return arr;
    }
    if (arr.length === 1) {
      return arr; // 只有1条，显示完整
    }
    // >=2条：显示第一条、统计信息、最后一条
    return [
      arr[0],
      {
        _summary: `${fieldName}统计`,
        _total: arr.length,
        _omitted: arr.length - 2
      },
      arr[arr.length - 1]
    ];
  }

  /**
   * 显示Windows通知
   */
  private async showWindowsNotification(title: string, message: string): Promise<void> {
    try {
      const psCommand = `[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.MessageBox]::Show('${message.replace(/'/g, "''")}', '${title.replace(/'/g, "''")}', 'OK', 'Warning')`;
      const { spawn } = await import('child_process');
      spawn('powershell.exe', ['-Command', psCommand], { windowsHide: true });
      this.logger.info(`显示Windows通知: ${title}`);
    } catch (error: any) {
      this.logger.error(`显示Windows通知时出错: ${error.message}`);
    }
  }

  /**
   * 睡眠函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
