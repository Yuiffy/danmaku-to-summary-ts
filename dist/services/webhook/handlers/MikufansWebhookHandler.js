"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MikufansWebhookHandler = void 0;
const path = require("path");
const fs = require("fs");
const child_process_1 = require("child_process");
const LogManager_1 = require("../../../core/logging/LogManager");
const ConfigProvider_1 = require("../../../core/config/ConfigProvider");
const FileStabilityChecker_1 = require("../FileStabilityChecker");
const DuplicateProcessorGuard_1 = require("../DuplicateProcessorGuard");
/**
 * Mikufans Webhook处理器
 */
class MikufansWebhookHandler {
    name = 'Mikufans Webhook Handler';
    path = '/mikufans';
    enabled = true;
    logger = (0, LogManager_1.getLogger)('MikufansWebhookHandler');
    stabilityChecker = new FileStabilityChecker_1.FileStabilityChecker();
    duplicateGuard = new DuplicateProcessorGuard_1.DuplicateProcessorGuard();
    sessionFiles = new Map(); // sessionId -> fileList
    /**
     * 注册Express路由
     */
    registerRoutes(app) {
        app.post(this.path, this.handleRequest.bind(this));
        this.logger.info(`注册Mikufans Webhook处理器，路径: ${this.path}`);
    }
    /**
     * 处理Webhook请求
     */
    async handleRequest(req, res) {
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
            const config = ConfigProvider_1.ConfigProvider.getConfig();
            if (!config.webhook.endpoints.mikufans.enabled) {
                this.logger.warn('Mikufans录播姬支持未启用');
                res.send('Mikufans recorder not enabled');
                return;
            }
            // 处理事件
            await this.handleEvent(payload, eventType);
            res.send('Mikufans processing started');
        }
        catch (error) {
            this.logger.error(`处理Mikufans Webhook时出错: ${error.message}`, { error });
            res.status(500).send('Internal server error');
        }
    }
    /**
     * 验证请求有效性
     */
    validateRequest(req) {
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
    logEvent(payload, eventType, eventTime) {
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
    async handleEvent(payload, eventType) {
        const sessionId = payload.EventData?.SessionId;
        const recording = payload.EventData?.Recording;
        // 处理会话开始事件
        if (eventType === 'SessionStarted' && recording === true) {
            await this.handleSessionStarted(sessionId, payload);
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
    async handleSessionStarted(sessionId, payload) {
        // 初始化会话文件列表
        this.sessionFiles.set(sessionId, []);
        const roomName = payload.EventData?.Name || '未知主播';
        this.logger.info(`🎬 直播开始: ${roomName} (Session: ${sessionId})`);
    }
    /**
     * 处理文件关闭事件
     */
    async handleFileClosed(payload) {
        const relativePath = payload.EventData?.RelativePath;
        if (!relativePath) {
            this.logger.warn('未找到RelativePath字段');
            return;
        }
        // 构建完整文件路径
        const config = ConfigProvider_1.ConfigProvider.getConfig();
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
        // 异步处理文件事件
        await this.processMikufansFile(normalizedPath, payload);
    }
    /**
     * 处理Mikufans文件
     */
    async processMikufansFile(filePath, payload) {
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
            }
            else {
                // 如果没有完全匹配的同名文件，可以尝试查找包含视频文件名的xml文件作为备选
                const files = fs.readdirSync(dir);
                const xmlFiles = files.filter(f => f.endsWith('.xml') && f.includes(baseName));
                if (xmlFiles.length > 0) {
                    targetXml = path.join(dir, xmlFiles[0]);
                    this.logger.info(`📄 找到备选弹幕文件（包含视频名）: ${path.basename(targetXml)}`);
                }
                else {
                    this.logger.info(`ℹ️ 未找到弹幕文件: 目录中没有 ${expectedXmlName}`);
                }
            }
        }
        catch (error) {
            this.logger.info(`ℹ️ 查找弹幕文件时出错: ${error.message}`);
        }
        // 启动处理流程
        const roomId = payload.EventData?.RoomId || 'unknown';
        await this.startProcessing(filePath, targetXml, roomId);
    }
    /**
     * 启动处理流程
     */
    async startProcessing(videoPath, xmlPath, roomId) {
        try {
            // 获取配置
            const config = ConfigProvider_1.ConfigProvider.getConfig();
            const scriptPath = 'src/scripts/enhanced_auto_summary.js'; // 硬编码路径，后续可从配置读取
            // 构建参数
            const args = [scriptPath, videoPath];
            if (xmlPath)
                args.push(xmlPath);
            this.logger.info(`启动Mikufans处理流程: ${path.basename(videoPath)}`);
            // 启动子进程
            const ps = (0, child_process_1.spawn)('node', args, {
                cwd: process.cwd(),
                windowsHide: true,
                env: {
                    ...process.env,
                    NODE_ENV: 'production',
                    ROOM_ID: String(roomId)
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
            ps.stdout?.on('data', (data) => {
                this.logger.info(`[Mikufans处理进程] ${data.toString().trim()}`);
            });
            ps.stderr?.on('data', (data) => {
                this.logger.error(`[Mikufans处理进程错误] ${data.toString().trim()}`);
            });
            // 处理进程事件
            ps.on('error', (error) => {
                this.logger.error(`Mikufans处理进程错误: ${error.message}`);
                clearTimeout(timeoutId);
                this.duplicateGuard.markAsProcessed(videoPath);
            });
            ps.on('close', (code) => {
                clearTimeout(timeoutId);
                this.logger.info(`Mikufans处理流程结束 (退出码: ${code}): ${path.basename(videoPath)}`);
                this.duplicateGuard.markAsProcessed(videoPath);
            });
        }
        catch (error) {
            this.logger.error(`启动Mikufans处理流程时出错: ${error.message}`, { error });
            this.duplicateGuard.markAsProcessed(videoPath);
        }
    }
    /**
     * 获取会话文件列表
     */
    getSessionFiles(sessionId) {
        return this.sessionFiles.get(sessionId) || [];
    }
    /**
     * 获取所有会话
     */
    getAllSessions() {
        return new Map(this.sessionFiles);
    }
    /**
     * 清理过期的会话
     */
    cleanupExpiredSessions(maxAgeHours = 24) {
        const now = Date.now();
        let cleanedCount = 0;
        for (const [sessionId, files] of this.sessionFiles.entries()) {
            // 简单实现：如果会话没有文件或假设会话已结束，可以清理
            // 实际实现可能需要更复杂的逻辑
            if (files.length === 0) {
                this.sessionFiles.delete(sessionId);
                cleanedCount++;
            }
        }
        if (cleanedCount > 0) {
            this.logger.info(`清理了 ${cleanedCount} 个过期会话`);
        }
    }
}
exports.MikufansWebhookHandler = MikufansWebhookHandler;
//# sourceMappingURL=MikufansWebhookHandler.js.map