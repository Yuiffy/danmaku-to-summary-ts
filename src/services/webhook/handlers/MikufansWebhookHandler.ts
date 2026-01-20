import { Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { IWebhookHandler } from '../IWebhookService';
import { getLogger } from '../../../core/logging/LogManager';
import { ConfigProvider } from '../../../core/config/ConfigProvider';
import { FileStabilityChecker } from '../FileStabilityChecker';
import { DuplicateProcessorGuard } from '../DuplicateProcessorGuard';
import { IDelayedReplyService } from '../../../services/bilibili/interfaces/IDelayedReplyService';
import { LiveSessionManager, LiveSegment } from '../LiveSessionManager';
import { FileMerger } from '../FileMerger';

/**
 * Mikufans Webhook处理器
 */
export class MikufansWebhookHandler implements IWebhookHandler {
  readonly name = 'Mikufans Webhook Handler';
  readonly path = '/mikufans';
  readonly enabled = true;

  private logger = getLogger('MikufansWebhookHandler');
  private stabilityChecker = new FileStabilityChecker();
  private duplicateGuard = new DuplicateProcessorGuard();
  private liveSessionManager = new LiveSessionManager();
  private fileMerger = new FileMerger();
  private delayedReplyService?: IDelayedReplyService;


  /**
   * 注册Express路由
   */
  registerRoutes(app: any): void {
    app.post(this.path, this.handleRequest.bind(this));
    this.logger.info(`注册Mikufans Webhook处理器，路径: ${this.path}`);
  }

  /**
   * 处理Webhook请求
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    try {
      const payload = req.body;
      const eventType = payload.EventType || 'Unknown';
      const eventTime = new Date().toLocaleString();

      // 验证请求
      if (!this.validateRequest(req)) {
        res.status(400).send('Invalid request');
        return;
      }

      // 记录事件
      this.logEvent(payload, eventType, eventTime);

      // 检查是否启用
      const config = ConfigProvider.getConfig();
      if (!config.webhook.endpoints.mikufans.enabled) {
        this.logger.warn('Mikufans录播姬支持未启用');
        res.send('Mikufans recorder not enabled');
        return;
      }

      // 处理事件
      await this.handleEvent(payload, eventType);
      
      res.send('Mikufans processing started');
    } catch (error: any) {
      this.logger.error(`处理Mikufans Webhook时出错: ${error.message}`, { error });
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
    if (!payload.EventType) {
      this.logger.warn('缺少EventType字段');
      return false;
    }

    return true;
  }

  /**
   * 记录事件日志
   */
  private logEvent(payload: any, eventType: string, eventTime: string): void {
    this.logger.info(`\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`);
    this.logger.info(`📅 时间: ${eventTime}`);
    this.logger.info(`📨 事件 (mikufans): ${eventType}`);
    
    // 提取主播信息
    const roomName = payload.EventData?.Name || '未知主播';
    const roomId = payload.EventData?.RoomId || '未知房间';
    this.logger.info(`👤 主播: ${roomName} (房间: ${roomId})`);
    
    this.logger.info(`📦 事件数据:`, { payload });
    this.logger.info(`▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`);
  }

  /**
   * 处理事件
   */
  private async handleEvent(payload: any, eventType: string): Promise<void> {
    const sessionId = payload.EventData?.SessionId;
    const recording = payload.EventData?.Recording;

    // 处理会话开始事件
    if (eventType === 'SessionStarted' && recording === true) {
      await this.handleSessionStarted(sessionId, payload);
      return;
    }

    // 处理直播结束事件
    if (eventType === 'StreamEnded') {
      await this.handleStreamEnded(sessionId, payload);
      return;
    }

    // 只处理文件关闭事件
    if (eventType !== 'FileClosed') {
      this.logger.info(`忽略非文件事件: ${eventType}`);
      return;
    }

    // 处理文件关闭事件
    await this.handleFileClosed(payload);
  }

  /**
   * 处理会话开始事件
   */
  private async handleSessionStarted(sessionId: string, payload: any): Promise<void> {
    const roomName = payload.EventData?.Name || '未知主播';
    const roomId = payload.EventData?.RoomId || 'unknown';
    const title = payload.EventData?.Title || '直播';
    
    // 使用LiveSessionManager创建会话
    this.liveSessionManager.createSession(sessionId, roomId, roomName, title);
    
    this.logger.info(`🎬 直播开始: ${roomName} (Session: ${sessionId}, Room: ${roomId})`);
  }

  /**
   * 处理直播结束事件
   */
  private async handleStreamEnded(sessionId: string, payload: any): Promise<void> {
    let session = this.liveSessionManager.getSession(sessionId);
    if (!session) {
      // 如果没有sessionId，根据roomId查找
      const roomId = payload.EventData?.RoomId;
      if (roomId) {
        session = this.liveSessionManager.getSessionByRoomId(roomId);
      }
    }

    if (!session) {
      this.logger.warn(`会话不存在: ${sessionId || 'unknown'}`);
      return;
    }

    this.logger.info(`🏁 直播结束 (收到事件): ${session.roomName} (Session: ${session.sessionId}, 当前片段数: ${session.segments.length})`);

    // 延迟处理，等待可能的FileClosed事件
    const delayMs = 5000; // 5秒
    setTimeout(async () => {
      await this.processStreamEnded(session.sessionId);
    }, delayMs);
  }

  /**
   * 延迟处理直播结束（等待FileClosed事件完成）
   */
  private async processStreamEnded(sessionId: string): Promise<void> {
    const session = this.liveSessionManager.getSession(sessionId);
    if (!session) {
      this.logger.warn(`延迟处理时会话不存在: ${sessionId}`);
      return;
    }

    this.logger.info(`🏁 直播结束 (延迟处理): ${session.roomName} (Session: ${session.sessionId}, 最终片段数: ${session.segments.length})`);

    // 检查是否需要合并
    const shouldMerge = this.liveSessionManager.shouldMerge(session.sessionId);

    if (shouldMerge) {
      // 多片段场景：触发合并
      await this.mergeAndProcessSession(session.sessionId);
    } else if (session.segments.length === 1) {
      // 单片段场景：直接处理
      await this.processSingleSegment(session.sessionId);
    } else {
      this.logger.warn(`会话没有片段: ${session.sessionId}`);
    }
  }

  /**
   * 处理文件关闭事件
   */
  private async handleFileClosed(payload: any): Promise<void> {
    const relativePath = payload.EventData?.RelativePath;
    if (!relativePath) {
      this.logger.warn('未找到RelativePath字段');
      return;
    }

    // 构建完整文件路径
    const config = ConfigProvider.getConfig();
    const basePath = config.webhook.endpoints.mikufans.basePath || 'D:/files/videos/DDTV录播';
    const fullPath = path.join(basePath, relativePath);
    const normalizedPath = path.normalize(fullPath);
    
    this.logger.info(`📁 文件路径: ${normalizedPath}`);
    
    // 检查文件扩展名
    const ext = path.extname(normalizedPath).toLowerCase();
    const supportedExtensions = ['.mp4', '.flv', '.mkv', '.ts', '.mov', '.m4a', '.aac', '.mp3', '.wav'];
    
    if (!supportedExtensions.includes(ext)) {
      this.logger.warn(`不支持的文件类型: ${ext}`);
      return;
    }

    // 检查文件大小，小于1MB则跳过处理
    try {
      if (fs.existsSync(normalizedPath)) {
        const fileSize = fs.statSync(normalizedPath).size;
        const fileSizeInMB = fileSize / (1024 * 1024);
        const minSizeMB = 1; // 最小处理大小：1MB
        
        if (fileSizeInMB < minSizeMB) {
          this.logger.info(`⏭️  文件过小 (${fileSizeInMB.toFixed(2)}MB < ${minSizeMB}MB)，跳过处理: ${path.basename(normalizedPath)}`);
          return;
        }
      }
    } catch (error: any) {
      this.logger.warn(`检查文件大小时出错: ${error.message}`);
    }

    // 收集片段到会话
    const sessionId = payload.EventData?.SessionId;
    if (sessionId) {
      await this.collectSegment(sessionId, normalizedPath, payload);
    } else {
      // 如果没有sessionId，直接处理文件（兼容旧逻辑）
      await this.processMikufansFile(normalizedPath, payload);
    }
  }

  /**
   * 收集片段到会话
   */
  private async collectSegment(sessionId: string, videoPath: string, payload: any): Promise<void> {
    const session = this.liveSessionManager.getSession(sessionId);
    if (!session) {
      this.logger.warn(`会话不存在: ${sessionId}，直接处理文件`);
      await this.processMikufansFile(videoPath, payload);
      return;
    }

    // 查找对应的xml文件
    const dir = path.dirname(videoPath);
    const baseName = path.basename(videoPath, path.extname(videoPath));
    const xmlPath = path.join(dir, `${baseName}.xml`);

    // 检查xml文件是否存在
    if (!fs.existsSync(xmlPath)) {
      this.logger.warn(`未找到XML文件: ${path.basename(xmlPath)}，跳过收集`);
      return;
    }

    // 获取文件时间信息
    const fileOpenTime = new Date(payload.EventData?.FileOpenTime || Date.now());
    const fileCloseTime = new Date(payload.EventData?.FileCloseTime || Date.now());
    const eventTimestamp = new Date();

    // 添加片段到会话
    this.liveSessionManager.addSegment(
      sessionId,
      videoPath,
      xmlPath,
      fileOpenTime,
      fileCloseTime,
      eventTimestamp
    );

    this.logger.info(`📦 收集片段: ${path.basename(videoPath)} (会话: ${sessionId}, 片段数: ${session.segments.length + 1})`);
  }

  /**
   * 处理Mikufans文件
   */
  private async processMikufansFile(filePath: string, payload: any): Promise<void> {
    const fileName = path.basename(filePath);

    // 检查去重
    if (this.duplicateGuard.isDuplicate(filePath)) {
      this.logger.warn(`跳过：文件已在处理队列中 -> ${fileName}`);
      return;
    }

    // 加入去重缓存
    this.duplicateGuard.markAsProcessing(filePath);

    this.logger.info(`FileClosed事件：检查文件稳定... (${fileName})`);
    
    // 等待文件稳定
    const isStable = await this.stabilityChecker.waitForFileStability(filePath);
    if (!isStable) {
      this.logger.error(`文件稳定性检查失败: ${fileName}`);
      this.duplicateGuard.markAsProcessed(filePath);
      return;
    }

    this.logger.info(`✅ 文件已稳定，开始处理: ${fileName}`);

    // 查找对应的xml文件（如果有）
    let targetXml = null;
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, path.extname(filePath));

    // 尝试查找同目录下的xml文件
    try {
      const expectedXmlName = baseName + '.xml';
      const xmlPath = path.join(dir, expectedXmlName);
      if (fs.existsSync(xmlPath)) {
        targetXml = xmlPath;
        this.logger.info(`📄 找到对应的弹幕文件: ${path.basename(targetXml)}`);
      } else {
        // 如果没有完全匹配的同名文件，可以尝试查找包含视频文件名的xml文件作为备选
        const files = fs.readdirSync(dir);
        const xmlFiles = files.filter(f => f.endsWith('.xml') && f.includes(baseName));
        if (xmlFiles.length > 0) {
          targetXml = path.join(dir, xmlFiles[0]);
          this.logger.info(`📄 找到备选弹幕文件（包含视频名）: ${path.basename(targetXml)}`);
        } else {
          this.logger.info(`ℹ️ 未找到弹幕文件: 目录中没有 ${expectedXmlName}`);
        }
      }
    } catch (error: any) {
      this.logger.info(`ℹ️ 查找弹幕文件时出错: ${error.message}`);
    }

    // 启动处理流程
    let roomId = payload.EventData?.RoomId || null;
    
    // 如果 payload 中没有 roomId，尝试从文件名中提取
    if (!roomId) {
      const fileName = path.basename(filePath);
      // 尝试匹配 "录制-23197314-..." 或 "23197314-..." 格式
      const match = fileName.match(/(?:录制-)?(\d+)-/);
      if (match) {
        roomId = match[1];
        this.logger.info(`🔍 从文件名提取房间ID: ${roomId}`);
      }
    }
    
    // 如果仍然没有 roomId，使用 'unknown'
    const finalRoomId = roomId || 'unknown';
    await this.startProcessing(filePath, targetXml, finalRoomId);
  }

  /**
   * 启动处理流程
   */
  private async startProcessing(videoPath: string, xmlPath: string | null, roomId: string): Promise<void> {
    try {
      // 获取配置
      const config = ConfigProvider.getConfig();
      const scriptPath = 'src/scripts/enhanced_auto_summary.js'; // 硬编码路径，后续可从配置读取
      
      // 构建参数
      const args = [scriptPath, videoPath];
      if (xmlPath) args.push(xmlPath);

      this.logger.info(`启动Mikufans处理流程: ${path.basename(videoPath)}`);
      
      // 启动子进程
      const ps: ChildProcess = spawn('node', args, {
        cwd: process.cwd(),
        windowsHide: true,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          ROOM_ID: String(roomId),
          AUTOMATION: 'true'  // 标识为自动化环境，避免等待用户输入
        }
      });

      // 设置超时
      const processTimeout = config.webhook.timeouts.processTimeout || 30 * 60 * 1000; // 30分钟
      const timeoutId = setTimeout(() => {
        this.logger.warn(`进程超时，强制终止: ${path.basename(videoPath)}`);
        if (ps.pid) {
          process.kill(ps.pid, 'SIGTERM');
        }
        this.duplicateGuard.markAsProcessed(videoPath);
      }, processTimeout);

      // 处理输出
      ps.stdout?.on('data', (data: Buffer) => {
        const output = data.toString().trim();
        if (output) {
          this.logger.info(`[Mikufans处理进程] ${output}`);
        }
      });

      ps.stderr?.on('data', (data: Buffer) => {
        const output = data.toString().trim();
        if (output) {
          this.logger.error(`[Mikufans处理进程错误] ${output}`);
        }
      });

      // 处理进程事件
      ps.on('error', (error: Error) => {
        this.logger.error(`Mikufans处理进程错误: ${error.message}`);
        clearTimeout(timeoutId);
        this.duplicateGuard.markAsProcessed(videoPath);
      });

      ps.on('close', async (code: number | null) => {
        clearTimeout(timeoutId);
        this.logger.info(`Mikufans处理流程结束 (退出码: ${code}): ${path.basename(videoPath)}`);
        this.duplicateGuard.markAsProcessed(videoPath);
        
        // 检查是否是合并后的文件，如果是则标记会话为完成
        if (videoPath.includes('_merged')) {
          // 从文件路径中提取sessionId
          const session = this.findSessionByVideoPath(videoPath);
          if (session) {
            this.liveSessionManager.markAsCompleted(session.sessionId);
            this.logger.info(`✅ 会话处理完成: ${session.sessionId}`);
          }
        }
        
        // 处理完成后，检查是否需要触发延迟回复
        await this.checkAndTriggerDelayedReply(videoPath, roomId);
      });

    } catch (error: any) {
      this.logger.error(`启动Mikufans处理流程时出错: ${error.message}`, { error });
      this.duplicateGuard.markAsProcessed(videoPath);
    }
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string) {
    return this.liveSessionManager.getSession(sessionId);
  }

  /**
   * 获取所有会话
   */
  getAllSessions() {
    return this.liveSessionManager.getAllSessions();
  }

  /**
   * 设置延迟回复服务
   */
  setDelayedReplyService(service: IDelayedReplyService): void {
    this.delayedReplyService = service;
    this.logger.info('延迟回复服务已设置');
  }

  /**
   * 检查并触发延迟回复
   */
  private async checkAndTriggerDelayedReply(videoPath: string, roomId: string): Promise<void> {
    if (!this.delayedReplyService) {
      this.logger.debug('延迟回复服务未设置，跳过触发');
      return;
    }

    if (!roomId || roomId === 'unknown') {
      this.logger.debug('房间ID无效，跳过触发延迟回复');
      return;
    }

    try {
      const dir = path.dirname(videoPath);
      const baseName = path.basename(videoPath, path.extname(videoPath));
      
      // 查找晚安回复文件
      const goodnightTextPath = path.join(dir, `${baseName}_晚安回复.md`);
      // 查找漫画文件
      const comicImagePath = path.join(dir, `${baseName}_COMIC_FACTORY.png`);
      
      // 检查文件是否存在
      const hasGoodnightText = fs.existsSync(goodnightTextPath);
      const hasComicImage = fs.existsSync(comicImagePath);
      
      if (hasGoodnightText && hasComicImage) {
        this.logger.info(`✅ 找到晚安回复和漫画文件，触发延迟回复任务`);
        this.logger.info(`   房间ID: ${roomId}`);
        this.logger.info(`   晚安回复: ${path.basename(goodnightTextPath)}`);
        this.logger.info(`   漫画: ${path.basename(comicImagePath)}`);
        
        const taskId = await this.delayedReplyService.addTask(roomId, goodnightTextPath, comicImagePath);
        
        if (taskId) {
          this.logger.info(`✅ 延迟回复任务已触发: ${taskId}`);
        } else {
          this.logger.info(`ℹ️  延迟回复任务未添加（可能配置未启用）`);
        }
      } else {
        this.logger.debug(`未找到完整的延迟回复文件: 晚安回复=${hasGoodnightText}, 漫画=${hasComicImage}`);
      }
    } catch (error: any) {
      this.logger.error(`检查并触发延迟回复失败: ${error.message}`, { error });
    }
  }

  /**
   * 合并并处理会话（多片段场景）
   */
  private async mergeAndProcessSession(sessionId: string): Promise<void> {
    const session = this.liveSessionManager.getSession(sessionId);
    if (!session) {
      this.logger.warn(`会话不存在: ${sessionId}`);
      return;
    }

    this.logger.info(`🔄 开始合并会话: ${sessionId} (${session.segments.length} 个片段)`);

    // 标记为合并中
    this.liveSessionManager.markAsMerging(sessionId);

    try {
      // 获取合并配置
      const mergeConfig = this.liveSessionManager.getMergeConfig();

      // 确定输出文件路径
      const firstSegment = session.segments[0];
      const outputDir = path.dirname(firstSegment.videoPath);
      const outputBaseName = path.basename(firstSegment.videoPath, path.extname(firstSegment.videoPath));
      const mergedVideoPath = path.join(outputDir, `${outputBaseName}_merged.flv`);
      const mergedXmlPath = path.join(outputDir, `${outputBaseName}_merged.xml`);

      // 备份原始片段
      if (mergeConfig.backupOriginals) {
        await this.fileMerger.backupSegments(session.segments, outputDir);
      }

      // 合并视频文件
      await this.fileMerger.mergeVideos(session.segments, mergedVideoPath, mergeConfig.fillGaps);

      // 合并XML文件
      await this.fileMerger.mergeXmlFiles(session.segments, mergedXmlPath);

      // 复制封面图
      if (mergeConfig.copyCover) {
        await this.fileMerger.copyCover(session.segments, outputDir);
      }

      this.logger.info(`✅ 合并完成: ${path.basename(mergedVideoPath)}`);

      // 标记为处理中
      this.liveSessionManager.markAsProcessing(sessionId);

      // 处理合并后的文件
      await this.startProcessing(mergedVideoPath, mergedXmlPath, session.roomId);
    } catch (error: any) {
      this.logger.error(`合并会话失败: ${error.message}`, { error });
    }
  }

  /**
   * 处理单个片段（单片段场景）
   */
  private async processSingleSegment(sessionId: string): Promise<void> {
    const session = this.liveSessionManager.getSession(sessionId);
    if (!session || session.segments.length === 0) {
      this.logger.warn(`会话或片段不存在: ${sessionId}`);
      return;
    }

    const segment = session.segments[0];
    this.logger.info(`📄 处理单个片段: ${path.basename(segment.videoPath)}`);

    // 标记为处理中
    this.liveSessionManager.markAsProcessing(sessionId);

    // 直接处理单个片段
    await this.startProcessing(segment.videoPath, segment.xmlPath, session.roomId);
  }

  /**
   * 根据视频路径查找会话
   */
  private findSessionByVideoPath(videoPath: string) {
    const allSessions = this.liveSessionManager.getAllSessions();
    for (const [sessionId, session] of allSessions.entries()) {
      for (const segment of session.segments) {
        if (segment.videoPath === videoPath) {
          return session;
        }
      }
    }
    return null;
  }

  /**
   * 清理过期的会话
   */
  cleanupExpiredSessions(maxAgeHours: number = 24): void {
    this.liveSessionManager.cleanupExpiredSessions(maxAgeHours);
  }
}