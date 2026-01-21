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
 * 延迟动作类型
 */
enum DelayedActionType {
  STREAM_ENDED = 'stream_ended',           // StreamEnded后等待更多片段
  SESSION_ENDED = 'session_ended',         // SessionEnded后等待SessionStart
  FILE_WITHOUT_SESSION = 'file_no_session', // FileClosed但会话不存在
  SEGMENT_COLLECTION = 'segment_collection' // 收集片段后等待更多片段或结算
}

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

  // 延迟处理定时器管理器(roomId -> Map<actionType, timer>)
  private delayedActions: Map<string, Map<DelayedActionType, NodeJS.Timeout>> = new Map();
  // SessionEnded延迟期间收到的待处理文件(roomId -> {videoPath, payload}[])
  private pendingFiles: Map<string, Array<{videoPath: string, payload: any}>> = new Map();
  // 最大等待时间(毫秒)
  private readonly MAX_DELAY_MS = 30000; // 30秒


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
   * 启动延迟处理(统一的30秒计时器管理)
   */
  private startDelayedAction(
    roomId: string,
    actionType: DelayedActionType,
    action: () => Promise<void>,
    description: string
  ): void {
    // 清除已有的同类型定时器
    this.cancelDelayedAction(roomId, actionType);

    this.logger.info(`⏳ 启动延迟处理: ${description} (等待 ${this.MAX_DELAY_MS / 1000} 秒)`);

    const timer = setTimeout(async () => {
      this.logger.info(`⏰ 延迟处理超时触发: ${description}`);
      await action();
      this.removeDelayedAction(roomId, actionType);
    }, this.MAX_DELAY_MS);

    // 保存定时器
    if (!this.delayedActions.has(roomId)) {
      this.delayedActions.set(roomId, new Map());
    }
    this.delayedActions.get(roomId)!.set(actionType, timer);
  }

  /**
   * 取消延迟处理
   */
  private cancelDelayedAction(roomId: string, actionType: DelayedActionType): boolean {
    const roomActions = this.delayedActions.get(roomId);
    if (!roomActions) return false;

    const timer = roomActions.get(actionType);
    if (timer) {
      clearTimeout(timer);
      roomActions.delete(actionType);
      this.logger.info(`🔄 取消延迟处理: ${actionType} (roomId: ${roomId})`);
      
      // 如果该房间没有其他定时器了,删除整个Map
      if (roomActions.size === 0) {
        this.delayedActions.delete(roomId);
      }
      return true;
    }
    return false;
  }

  /**
   * 移除延迟处理记录(定时器已执行完毕)
   */
  private removeDelayedAction(roomId: string, actionType: DelayedActionType): void {
    const roomActions = this.delayedActions.get(roomId);
    if (roomActions) {
      roomActions.delete(actionType);
      if (roomActions.size === 0) {
        this.delayedActions.delete(roomId);
      }
    }
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

    // 处理会话结束事件
    if (eventType === 'SessionEnded') {
      await this.handleSessionEnded(sessionId, payload);
      return;
    }

    // 处理直播结束事件
    if (eventType === 'StreamEnded') {
      await this.handleStreamEnded(sessionId, payload);
      return;
    }

    // 处理文件打开事件
    if (eventType === 'FileOpening') {
      await this.handleFileOpening(payload);
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

    // 使用LiveSessionManager创建或获取会话（使用RoomId）
    this.liveSessionManager.createOrGetSession(roomId, roomName, title);

    // 取消SessionEnded延迟处理(说明直播重新开始了)
    this.cancelDelayedAction(roomId, DelayedActionType.SESSION_ENDED);

    // 恢复待处理的文件到新会话（说明是断线重连或事件乱序，这些文件属于当前会话）
    const pendingFiles = this.pendingFiles.get(roomId);
    if (pendingFiles && pendingFiles.length > 0) {
      this.logger.info(`🔄 恢复待处理文件到会话: ${roomId} (${pendingFiles.length}个文件)`);
      for (const item of pendingFiles) {
        await this.collectSegment(roomId, item.videoPath, item.payload);
      }
      this.pendingFiles.delete(roomId);
    }

    this.logger.info(`🎬 直播开始: ${roomName} (Session: ${sessionId}, Room: ${roomId})`);
  }

  /**
   * 处理文件打开事件
   */
  private async handleFileOpening(payload: any): Promise<void> {
    const roomId = payload.EventData?.RoomId;
    if (!roomId) {
      this.logger.warn(`FileOpening事件缺少RoomId`);
      return;
    }

    // 取消所有相关的延迟处理(说明有新文件开始录制了)
    this.cancelDelayedAction(roomId, DelayedActionType.SESSION_ENDED);
    this.cancelDelayedAction(roomId, DelayedActionType.FILE_WITHOUT_SESSION);
    this.cancelDelayedAction(roomId, DelayedActionType.SEGMENT_COLLECTION);

    this.logger.info(`📂 FileOpening: ${roomId} (已取消相关延迟处理)`);
  }

  /**
   * 处理会话结束事件
   */
  private async handleSessionEnded(sessionId: string, payload: any): Promise<void> {
    const roomId = payload.EventData?.RoomId;
    if (!roomId) {
      this.logger.warn(`SessionEnded事件缺少RoomId`);
      return;
    }

    const session = this.liveSessionManager.getSession(roomId);
    if (session) {
      // 会话存在,启动延迟处理,等待FileOpen或SessionStart
      this.logger.info(`📝 会话结束 (会话存在): ${session.roomName} (Room: ${roomId})`);
      
      this.startDelayedAction(
        roomId,
        DelayedActionType.SESSION_ENDED,
        async () => {
          await this.processSessionEndedWithSession(roomId);
        },
        `SessionEnded(会话存在): ${roomId}`
      );
      return;
    }

    // 会话不存在，可能是网络不稳定导致的SessionStart丢失
    // 启动延迟处理，等待30秒看是否有SessionStart
    this.startDelayedAction(
      roomId,
      DelayedActionType.SESSION_ENDED,
      async () => {
        await this.processSessionEndedWithoutSession(roomId, payload);
      },
      `SessionEnded(会话不存在): ${roomId}`
    );
  }

  /**
   * 处理会话存在时的SessionEnded（延迟30秒后执行）
   */
  private async processSessionEndedWithSession(roomId: string): Promise<void> {
    // 再次检查会话是否存在
    const session = this.liveSessionManager.getSession(roomId);
    if (!session) {
      this.logger.info(`📝 延迟处理时会话已不存在: ${roomId}`);
      return;
    }

    this.logger.info(`📝 SessionEnded延迟结束(会话存在): ${roomId} (开始结算)`);
    
    // 触发结算流程
    await this.processStreamEnded(roomId);
  }

  /**
   * 处理没有会话的SessionEnded（延迟30秒后执行）
   */
  private async processSessionEndedWithoutSession(roomId: string, payload: any): Promise<void> {
    // 再次检查会话是否存在（可能在延迟期间收到了SessionStart）
    const session = this.liveSessionManager.getSession(roomId);
    if (session) {
      this.logger.info(`📝 延迟处理时发现会话已存在，跳过处理: ${roomId}`);
      // 清除待处理文件（这些文件属于新会话）
      this.pendingFiles.delete(roomId);
      return;
    }

    this.logger.info(`📝 SessionEnded延迟结束: ${roomId} (会话仍不存在，开始处理待处理文件)`);

    // 处理延迟期间收到的文件
    const pendingFiles = this.pendingFiles.get(roomId);
    if (pendingFiles && pendingFiles.length > 0) {
      this.logger.info(`📦 处理 ${pendingFiles.length} 个待处理文件`);
      for (const {videoPath, payload} of pendingFiles) {
        await this.processMikufansFile(videoPath, payload);
      }
      this.pendingFiles.delete(roomId);
    } else {
      this.logger.info(`ℹ️  没有待处理的文件`);
    }
  }

  /**
   * 处理没有会话时收到的文件（延迟30秒后执行）
   */
  private async processFilesWithoutSession(roomId: string): Promise<void> {
    // 再次检查会话是否存在（可能在延迟期间收到了SessionStart或FileOpening）
    const session = this.liveSessionManager.getSession(roomId);
    if (session) {
      this.logger.info(`📝 延迟处理时发现会话已存在，跳过处理: ${roomId}`);
      // 清除待处理文件（这些文件属于新会话）
      this.pendingFiles.delete(roomId);
      return;
    }

    this.logger.info(`📝 延迟结束: ${roomId} (会话仍不存在，开始处理待处理文件)`);

    // 处理延迟期间收到的文件
    const pendingFiles = this.pendingFiles.get(roomId);
    if (pendingFiles && pendingFiles.length > 0) {
      this.logger.info(`📦 处理 ${pendingFiles.length} 个待处理文件`);
      for (const {videoPath, payload} of pendingFiles) {
        await this.processMikufansFile(videoPath, payload);
      }
      this.pendingFiles.delete(roomId);
    } else {
      this.logger.info(`ℹ️  没有待处理的文件`);
    }
  }

  /**
   * 处理直播结束事件
   */
  private async handleStreamEnded(sessionId: string, payload: any): Promise<void> {
    const roomId = payload.EventData?.RoomId;
    if (!roomId) {
      this.logger.warn(`StreamEnded事件缺少RoomId`);
      return;
    }

    const session = this.liveSessionManager.getSession(roomId);
    if (!session) {
      this.logger.warn(`会话不存在: ${roomId}`);
      return;
    }

    this.logger.info(`🏁 直播结束 (收到事件): ${session.roomName} (Room: ${roomId}, 当前片段数: ${session.segments.length})`);

    // 启动动态延迟等待
    this.startDelayedAction(
      roomId,
      DelayedActionType.STREAM_ENDED,
      async () => {
        await this.processStreamEnded(roomId);
      },
      `StreamEnded: ${roomId}`
    );
  }

  /**
   * 延迟处理直播结束（等待FileClosed事件完成）
   */
  private async processStreamEnded(roomId: string): Promise<void> {
    // 立即取消所有相关的延迟处理，防止重复触发结算
    this.cancelDelayedAction(roomId, DelayedActionType.STREAM_ENDED);
    this.cancelDelayedAction(roomId, DelayedActionType.SESSION_ENDED);
    this.cancelDelayedAction(roomId, DelayedActionType.SEGMENT_COLLECTION);

    const session = this.liveSessionManager.getSession(roomId);
    if (!session) {
      this.logger.warn(`延迟处理时会话不存在: ${roomId}`);
      return;
    }

    this.logger.info(`🏁 直播结束 (延迟处理): ${session.roomName} (Room: ${roomId}, 最终片段数: ${session.segments.length})`);

    // 检查是否需要合并
    const shouldMerge = this.liveSessionManager.shouldMerge(roomId);

    if (shouldMerge) {
      // 多片段场景：触发合并
      await this.mergeAndProcessSession(roomId);
    } else if (session.segments.length === 1) {
      // 单片段场景：直接处理
      await this.processSingleSegment(roomId);
    } else {
      this.logger.warn(`会话没有片段: ${roomId}`);
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
    const roomId = payload.EventData?.RoomId;
    if (roomId) {
      await this.collectSegment(roomId, normalizedPath, payload);
    } else {
      // 如果没有roomId，直接处理文件（兼容旧逻辑）
      await this.processMikufansFile(normalizedPath, payload);
    }
  }

  /**
   * 收集片段到会话
   */
  private async collectSegment(roomId: string, videoPath: string, payload: any): Promise<void> {
    const session = this.liveSessionManager.getSession(roomId);
    if (!session) {
      // 会话不存在，将文件加入待处理队列
      if (!this.pendingFiles.has(roomId)) {
        this.pendingFiles.set(roomId, []);
      }
      this.pendingFiles.get(roomId)!.push({videoPath, payload});
      
      // 启动延迟处理
      this.startDelayedAction(
        roomId,
        DelayedActionType.FILE_WITHOUT_SESSION,
        async () => {
          await this.processFilesWithoutSession(roomId);
        },
        `FileClosed(会话不存在): ${roomId}`
      );
      
      this.logger.info(`📝 会话不存在，文件加入待处理队列: ${roomId} (${path.basename(videoPath)})`);
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
      roomId,
      videoPath,
      xmlPath,
      fileOpenTime,
      fileCloseTime,
      eventTimestamp
    );

    this.logger.info(`📦 收集片段: ${path.basename(videoPath)} (会话: ${roomId}, 片段数: ${session.segments.length})`);

    // 启动/重置片段收集延迟处理(等待更多片段或超时结算)
    this.startDelayedAction(
      roomId,
      DelayedActionType.SEGMENT_COLLECTION,
      async () => {
        await this.processSegmentCollectionTimeout(roomId);
      },
      `SegmentCollection: ${roomId}`
    );
  }

  /**
   * 处理片段收集超时
   */
  private async processSegmentCollectionTimeout(roomId: string): Promise<void> {
    const session = this.liveSessionManager.getSession(roomId);
    if (!session) {
      this.logger.info(`📝 片段收集超时，但会话已不存在: ${roomId}`);
      return;
    }

    this.logger.info(`📝 片段收集超时: ${roomId} (开始结算)`);
    
    // 触发结算流程
    await this.processStreamEnded(roomId);
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

    // 获取roomId
    let roomId = payload.EventData?.RoomId || null;

    // 如果 payload 中没有 roomId，尝试从文件名中提取
    if (!roomId) {
      const fileNameForMatch = path.basename(filePath);
      // 尝试匹配 "录制-23197314-..." 或 "23197314-..." 格式
      const match = fileNameForMatch.match(/(?:录制-)?(\d+)-/);
      if (match) {
        roomId = match[1];
        this.logger.info(`🔍 从文件名提取房间ID: ${roomId}`);
      }
    }

    const finalRoomId = roomId || 'unknown';

    // 启动处理流程
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
          // 从文件路径中提取roomId
          const session = this.findSessionByVideoPath(videoPath);
          if (session) {
            this.liveSessionManager.markAsCompleted(session.roomId);
            this.logger.info(`✅ 会话处理完成: ${session.roomId}`);
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
    this.logger.info(`🔍 [延迟回复检查] 开始检查: roomId=${roomId}, videoPath=${path.basename(videoPath)}`);

    if (!this.delayedReplyService) {
      this.logger.warn('⚠️  延迟回复服务未设置，跳过触发');
      return;
    }

    if (!roomId || roomId === 'unknown') {
      this.logger.warn(`⚠️  房间ID无效 (${roomId})，跳过触发延迟回复`);
      return;
    }

    try {
      const dir = path.dirname(videoPath);
      const baseName = path.basename(videoPath, path.extname(videoPath));

      // 查找晚安回复文件
      const goodnightTextPath = path.join(dir, `${baseName}_晚安回复.md`);
      // 查找漫画文件
      const comicImagePath = path.join(dir, `${baseName}_COMIC_FACTORY.png`);

      this.logger.info(`🔍 [延迟回复检查] 检查文件:`);
      this.logger.info(`   晚安回复路径: ${goodnightTextPath}`);
      this.logger.info(`   漫画路径: ${comicImagePath}`);

      // 检查文件是否存在
      const hasGoodnightText = fs.existsSync(goodnightTextPath);
      const hasComicImage = fs.existsSync(comicImagePath);

      this.logger.info(`   晚安回复存在: ${hasGoodnightText}`);
      this.logger.info(`   漫画存在: ${hasComicImage}`);

      // 只要有晚安回复就触发延迟回复（漫画可选）
      if (hasGoodnightText) {
        this.logger.info(`✅ 找到晚安回复文件，触发延迟回复任务`);
        this.logger.info(`   房间ID: ${roomId}`);
        this.logger.info(`   晚安回复: ${path.basename(goodnightTextPath)}`);
        if (hasComicImage) {
          this.logger.info(`   漫画: ${path.basename(comicImagePath)}`);
        } else {
          this.logger.info(`   漫画: 未生成（将只发送晚安回复）`);
        }

        const taskId = await this.delayedReplyService.addTask(roomId, goodnightTextPath, hasComicImage ? comicImagePath : '');

        if (taskId) {
          this.logger.info(`✅ 延迟回复任务已触发: ${taskId}`);
        } else {
          this.logger.info(`ℹ️  延迟回复任务未添加（可能配置未启用）`);
        }
      } else {
        this.logger.info(`ℹ️  未找到晚安回复文件，跳过延迟回复`);
      }
    } catch (error: any) {
      this.logger.error(`❌ 检查并触发延迟回复失败: ${error.message}`, { error });
    }
  }

  /**
   * 合并并处理会话（多片段场景）
   */
  private async mergeAndProcessSession(roomId: string): Promise<void> {
    const session = this.liveSessionManager.getSession(roomId);
    if (!session) {
      this.logger.warn(`会话不存在: ${roomId}`);
      return;
    }

    this.logger.info(`🔄 开始合并会话: ${roomId} (${session.segments.length} 个片段)`);

    // 标记为合并中
    this.liveSessionManager.markAsMerging(roomId);

    try {
      // 获取合并配置
      const mergeConfig = this.liveSessionManager.getMergeConfig();

      // 确定输出文件路径
      const firstSegment = session.segments[0];
      const outputDir = path.dirname(firstSegment.videoPath);
      const outputBaseName = path.basename(firstSegment.videoPath, path.extname(firstSegment.videoPath));
      const mergedVideoPath = path.join(outputDir, `${outputBaseName}_merged.flv`);
      const mergedXmlPath = path.join(outputDir, `${outputBaseName}_merged.xml`);

      // 合并视频文件
      await this.fileMerger.mergeVideos(session.segments, mergedVideoPath, mergeConfig.fillGaps);

      // 合并XML文件
      await this.fileMerger.mergeXmlFiles(session.segments, mergedXmlPath);

      // 复制封面图
      if (mergeConfig.copyCover) {
        await this.fileMerger.copyCover(session.segments, outputDir);
      }

      this.logger.info(`✅ 合并完成: ${path.basename(mergedVideoPath)}`);

      // 备份原始片段（合并成功后才备份）
      if (mergeConfig.backupOriginals) {
        await this.fileMerger.backupSegments(session.segments, outputDir);
      }

      // 标记为处理中
      this.liveSessionManager.markAsProcessing(roomId);

      // 处理合并后的文件
      await this.startProcessing(mergedVideoPath, mergedXmlPath, session.roomId);
    } catch (error: any) {
      this.logger.error(`合并会话失败: ${error.message}`, { error });

      // 降级处理：使用最大的片段
      this.logger.warn(`🔄 合并失败，使用降级处理（最大片段）: ${roomId}`);
      await this.fallbackToLargestSegment(roomId);
    }
  }

  /**
   * 降级处理：使用最大的片段
   */
  private async fallbackToLargestSegment(roomId: string): Promise<void> {
    const session = this.liveSessionManager.getSession(roomId);
    if (!session || session.segments.length === 0) {
      this.logger.warn(`会话或片段不存在: ${roomId}`);
      return;
    }

    // 获取最大的片段
    const largestSegment = this.fileMerger.getLargestSegment(session.segments);
    if (!largestSegment) {
      this.logger.error(`无法获取最大片段: ${roomId}`);
      return;
    }

    this.logger.info(`📄 降级处理: 使用最大片段 ${path.basename(largestSegment.videoPath)}`);

    // 重置会话状态为收集中
    this.liveSessionManager.resetToCollecting(roomId);

    // 标记为处理中
    this.liveSessionManager.markAsProcessing(roomId);

    // 处理最大片段
    await this.startProcessing(largestSegment.videoPath, largestSegment.xmlPath, session.roomId);
  }

  /**
   * 处理单个片段（单片段场景）
   */
  private async processSingleSegment(roomId: string): Promise<void> {
    const session = this.liveSessionManager.getSession(roomId);
    if (!session || session.segments.length === 0) {
      this.logger.warn(`会话或片段不存在: ${roomId}`);
      return;
    }

    const segment = session.segments[0];
    this.logger.info(`📄 处理单个片段: ${path.basename(segment.videoPath)}`);

    // 标记为处理中
    this.liveSessionManager.markAsProcessing(roomId);

    // 直接处理单个片段
    await this.startProcessing(segment.videoPath, segment.xmlPath, session.roomId);
  }

  /**
   * 根据视频路径查找会话
   */
  private findSessionByVideoPath(videoPath: string) {
    const allSessions = this.liveSessionManager.getAllSessions();
    for (const [roomId, session] of allSessions.entries()) {
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
