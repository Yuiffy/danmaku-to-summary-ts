"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServiceManager = exports.ServiceStatus = void 0;
const LogManager_1 = require("../core/logging/LogManager");
const ConfigProvider_1 = require("../core/config/ConfigProvider");
const WebhookService_1 = require("./webhook/WebhookService");
const AudioProcessor_1 = require("./audio/AudioProcessor");
const AITextGenerator_1 = require("./ai/AITextGenerator");
/**
 * 服务状态
 */
var ServiceStatus;
(function (ServiceStatus) {
    ServiceStatus["STOPPED"] = "stopped";
    ServiceStatus["STARTING"] = "starting";
    ServiceStatus["RUNNING"] = "running";
    ServiceStatus["STOPPING"] = "stopping";
    ServiceStatus["ERROR"] = "error";
})(ServiceStatus || (exports.ServiceStatus = ServiceStatus = {}));
/**
 * 服务管理器
 * 负责协调所有服务的启动、停止和状态管理
 */
class ServiceManager {
    logger = null;
    services = new Map();
    webhookService;
    audioProcessor;
    aiTextGenerator;
    /**
     * 获取logger（安全方法）
     */
    getLogger() {
        if (!this.logger) {
            // 如果logger未初始化，使用控制台日志
            return {
                info: (message, ...args) => console.log(`[INFO] ${message}`, ...args),
                error: (message, ...args) => console.error(`[ERROR] ${message}`, ...args),
                warn: (message, ...args) => console.warn(`[WARN] ${message}`, ...args),
                debug: (message, ...args) => console.debug(`[DEBUG] ${message}`, ...args),
                trace: (message, ...args) => console.trace(`[TRACE] ${message}`, ...args)
            };
        }
        return this.logger;
    }
    /**
     * 初始化所有服务
     */
    async initialize() {
        try {
            // 初始化日志管理器
            LogManager_1.LogManager.initialize();
            this.logger = (0, LogManager_1.getLogger)('ServiceManager');
            this.getLogger().info('正在初始化服务管理器...');
            // 初始化配置
            await ConfigProvider_1.ConfigProvider.initialize();
            // 初始化各个服务
            await this.initializeServices();
            this.getLogger().info('服务管理器初始化完成');
        }
        catch (error) {
            this.getLogger().error(`初始化服务管理器失败: ${error.message}`, { error });
            throw error;
        }
    }
    /**
     * 启动所有服务
     */
    async startAll() {
        try {
            this.getLogger().info('正在启动所有服务...');
            // 启动Webhook服务
            if (this.webhookService) {
                await this.startService('webhook', () => this.webhookService.start());
            }
            // 其他服务按需启动
            // 音频处理服务、AI生成服务等通常是按需使用，不需要常驻启动
            this.getLogger().info('所有服务启动完成');
        }
        catch (error) {
            this.getLogger().error(`启动服务失败: ${error.message}`, { error });
            throw error;
        }
    }
    /**
     * 停止所有服务
     */
    async stopAll() {
        try {
            this.getLogger().info('正在停止所有服务...');
            // 停止Webhook服务
            if (this.webhookService) {
                await this.stopService('webhook', () => this.webhookService.stop());
            }
            // 清理其他服务资源
            await this.cleanupServices();
            this.getLogger().info('所有服务已停止');
        }
        catch (error) {
            this.getLogger().error(`停止服务失败: ${error.message}`, { error });
            throw error;
        }
    }
    /**
     * 获取Webhook服务
     */
    getWebhookService() {
        return this.webhookService;
    }
    /**
     * 获取音频处理服务
     */
    getAudioProcessor() {
        return this.audioProcessor;
    }
    /**
     * 获取AI文本生成服务
     */
    getAITextGenerator() {
        return this.aiTextGenerator;
    }
    /**
     * 获取所有服务状态
     */
    getAllServiceStatus() {
        return new Map(this.services);
    }
    /**
     * 获取服务状态
     */
    getServiceStatus(name) {
        return this.services.get(name);
    }
    /**
     * 检查服务是否运行
     */
    isServiceRunning(name) {
        const service = this.services.get(name);
        return service?.status === ServiceStatus.RUNNING;
    }
    /**
     * 获取系统健康状态
     */
    getHealthStatus() {
        const services = {};
        for (const [name, info] of this.services.entries()) {
            services[name] = info.status;
        }
        const healthy = Array.from(this.services.values()).every(service => service.status === ServiceStatus.RUNNING);
        return {
            healthy,
            services,
            timestamp: new Date()
        };
    }
    /**
     * 处理视频文件
     * 这是主要的业务流程编排
     */
    async processVideoFile(videoPath, xmlPath, roomId) {
        const startTime = Date.now();
        const result = {
            success: false,
            steps: {},
            videoPath,
            roomId
        };
        try {
            this.getLogger().info(`开始处理视频文件: ${videoPath}`, { roomId, xmlPath });
            // 步骤1: 检查文件是否存在
            const fs = await Promise.resolve().then(() => require('fs'));
            if (!fs.existsSync(videoPath)) {
                throw new Error(`视频文件不存在: ${videoPath}`);
            }
            result.steps.fileCheck = { success: true };
            // 步骤2: 音频处理（如果是音频专用房间）
            const config = ConfigProvider_1.ConfigProvider.getConfig();
            const isAudioOnly = roomId ? ConfigProvider_1.ConfigProvider.isAudioOnlyRoom(roomId) : false;
            if (isAudioOnly && this.audioProcessor) {
                try {
                    this.getLogger().info(`房间 ${roomId} 是音频专用房间，进行音频处理`);
                    const numericRoomId = roomId ? parseInt(roomId) : undefined;
                    const audioResult = await this.audioProcessor.processVideoForAudio(videoPath, numericRoomId);
                    result.steps.audioProcessing = {
                        success: !!audioResult,
                        output: audioResult || undefined
                    };
                }
                catch (error) {
                    this.getLogger().error(`音频处理失败: ${error.message}`, { error });
                    result.steps.audioProcessing = {
                        success: false,
                        error: error.message
                    };
                    // 音频处理失败不影响后续流程
                }
            }
            // 步骤3: 字幕融合处理（暂未实现）
            if (xmlPath) {
                this.getLogger().info('字幕融合处理（待实现）');
                result.steps.fusionProcessing = {
                    success: false,
                    error: '字幕融合服务暂未实现'
                };
            }
            // 步骤4: AI文本生成
            if (this.aiTextGenerator) {
                try {
                    this.getLogger().info('开始AI文本生成');
                    // 检查AI服务是否可用
                    const isAvailable = await this.aiTextGenerator.isAvailable();
                    if (!isAvailable) {
                        throw new Error('AI服务不可用');
                    }
                    // 生成晚安回复（需要AI_HIGHLIGHT文件，这里简化处理）
                    // 在实际实现中，需要先有字幕融合结果
                    const highlightPath = xmlPath ? xmlPath.replace('.xml', '_AI_HIGHLIGHT.txt') : undefined;
                    if (highlightPath && fs.existsSync(highlightPath)) {
                        const goodnightResult = await this.aiTextGenerator.generateGoodnightReply(highlightPath, roomId);
                        result.steps.aiGoodnight = {
                            success: !!goodnightResult,
                            output: goodnightResult || undefined
                        };
                    }
                    else {
                        this.getLogger().info('未找到AI_HIGHLIGHT文件，跳过AI文本生成');
                        result.steps.aiGoodnight = {
                            success: false,
                            error: '未找到AI_HIGHLIGHT文件'
                        };
                    }
                }
                catch (error) {
                    this.getLogger().error(`AI文本生成失败: ${error.message}`, { error });
                    result.steps.aiGeneration = {
                        success: false,
                        error: error.message
                    };
                }
            }
            // 步骤5: AI漫画生成（如果启用）
            const enableComic = roomId ?
                ConfigProvider_1.ConfigProvider.getRoomAIConfig(roomId).enableComicGeneration :
                config.ai.comic.enabled;
            if (enableComic) {
                this.getLogger().info('AI漫画生成已启用（待实现）');
                result.steps.comicGeneration = {
                    success: false,
                    error: 'AI漫画生成服务暂未实现'
                };
            }
            // 计算总体成功率
            const successfulSteps = Object.values(result.steps).filter(step => step.success).length;
            const totalSteps = Object.keys(result.steps).length;
            result.success = totalSteps > 0 && successfulSteps > 0;
            result.processingTime = Date.now() - startTime;
            this.getLogger().info(`视频文件处理完成: ${videoPath}`, {
                success: result.success,
                steps: Object.keys(result.steps),
                processingTime: result.processingTime
            });
        }
        catch (error) {
            this.getLogger().error(`处理视频文件时发生严重错误: ${error.message}`, { error });
            result.steps.overall = {
                success: false,
                error: error.message
            };
            result.success = false;
            result.processingTime = Date.now() - startTime;
        }
        return result;
    }
    /**
     * 批量处理文件
     */
    async batchProcessFiles(files) {
        const results = [];
        for (const file of files) {
            try {
                const result = await this.processVideoFile(file.videoPath, file.xmlPath, file.roomId);
                results.push({
                    file: file.videoPath,
                    success: result.success,
                    error: result.steps.overall?.error,
                    processingTime: result.processingTime
                });
            }
            catch (error) {
                results.push({
                    file: file.videoPath,
                    success: false,
                    error: error.message
                });
            }
        }
        return results;
    }
    /**
     * 获取服务统计信息
     */
    getServiceStatistics() {
        let running = 0;
        let stopped = 0;
        let error = 0;
        for (const service of this.services.values()) {
            switch (service.status) {
                case ServiceStatus.RUNNING:
                    running++;
                    break;
                case ServiceStatus.STOPPED:
                    stopped++;
                    break;
                case ServiceStatus.ERROR:
                    error++;
                    break;
            }
        }
        return {
            totalServices: this.services.size,
            runningServices: running,
            stoppedServices: stopped,
            errorServices: error
        };
    }
    /**
     * 重启服务
     */
    async restartService(name) {
        try {
            this.getLogger().info(`正在重启服务: ${name}`);
            // 停止服务
            if (this.isServiceRunning(name)) {
                await this.stopService(name, async () => {
                    // 根据服务名称执行不同的停止逻辑
                    if (name === 'webhook' && this.webhookService) {
                        await this.webhookService.stop();
                    }
                });
            }
            // 启动服务
            await this.startService(name, async () => {
                if (name === 'webhook' && this.webhookService) {
                    await this.webhookService.start();
                }
            });
            this.getLogger().info(`服务重启成功: ${name}`);
            return true;
        }
        catch (error) {
            this.getLogger().error(`重启服务失败: ${name}`, { error });
            return false;
        }
    }
    /**
     * 初始化各个服务
     */
    async initializeServices() {
        // Webhook服务
        await this.initializeService('webhook', async () => {
            this.webhookService = new WebhookService_1.WebhookService();
            // Webhook服务需要显式启动
        });
        // 音频处理服务
        await this.initializeService('audio', async () => {
            this.audioProcessor = new AudioProcessor_1.AudioProcessor();
        });
        // AI文本生成服务
        await this.initializeService('ai-text', async () => {
            this.aiTextGenerator = new AITextGenerator_1.AITextGenerator();
        });
        // 其他服务可以在这里添加
    }
    /**
     * 初始化单个服务
     */
    async initializeService(name, initFn) {
        try {
            this.updateServiceStatus(name, ServiceStatus.STARTING);
            await initFn();
            this.updateServiceStatus(name, ServiceStatus.STOPPED); // 初始化完成但未启动
            this.getLogger().info(`服务初始化成功: ${name}`);
        }
        catch (error) {
            this.updateServiceStatus(name, ServiceStatus.ERROR, error.message);
            this.getLogger().error(`服务初始化失败: ${name}`, { error });
            throw error;
        }
    }
    /**
     * 启动单个服务
     */
    async startService(name, startFn) {
        try {
            this.updateServiceStatus(name, ServiceStatus.STARTING);
            await startFn();
            this.updateServiceStatus(name, ServiceStatus.RUNNING);
            this.getLogger().info(`服务启动成功: ${name}`);
        }
        catch (error) {
            this.updateServiceStatus(name, ServiceStatus.ERROR, error.message);
            this.getLogger().error(`服务启动失败: ${name}`, { error });
            throw error;
        }
    }
    /**
     * 停止单个服务
     */
    async stopService(name, stopFn) {
        try {
            this.updateServiceStatus(name, ServiceStatus.STOPPING);
            await stopFn();
            this.updateServiceStatus(name, ServiceStatus.STOPPED);
            this.getLogger().info(`服务停止成功: ${name}`);
        }
        catch (error) {
            this.updateServiceStatus(name, ServiceStatus.ERROR, error.message);
            this.getLogger().error(`服务停止失败: ${name}`, { error });
            throw error;
        }
    }
    /**
     * 清理服务资源
     */
    async cleanupServices() {
        // 清理音频处理服务
        if (this.audioProcessor && 'cleanup' in this.audioProcessor) {
            await this.audioProcessor.cleanup?.();
        }
        // 清理AI文本生成服务
        if (this.aiTextGenerator && 'cleanup' in this.aiTextGenerator) {
            await this.aiTextGenerator.cleanup?.();
        }
    }
    /**
     * 更新服务状态
     */
    updateServiceStatus(name, status, error) {
        const now = new Date();
        const existing = this.services.get(name);
        const serviceInfo = {
            name,
            status,
            error,
            startedAt: status === ServiceStatus.RUNNING ? now : existing?.startedAt,
            uptime: status === ServiceStatus.RUNNING ? 0 : existing?.uptime
        };
        // 计算运行时间
        if (serviceInfo.startedAt && status === ServiceStatus.RUNNING) {
            serviceInfo.uptime = Date.now() - serviceInfo.startedAt.getTime();
        }
        this.services.set(name, serviceInfo);
    }
}
exports.ServiceManager = ServiceManager;
//# sourceMappingURL=ServiceManager.js.map