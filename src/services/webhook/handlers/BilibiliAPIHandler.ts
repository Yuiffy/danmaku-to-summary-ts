import { Request, Response } from 'express';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { IWebhookHandler } from '../IWebhookService';
import { getLogger } from '../../../core/logging/LogManager';
import { ConfigProvider } from '../../../core/config/ConfigProvider';
import { BilibiliAPIService } from '../../../services/bilibili/BilibiliAPIService';
import { IDelayedReplyService } from '../../../services/bilibili/interfaces/IDelayedReplyService';

/**
 * B站API处理器 - 提供B站动态回复相关的HTTP接口
 */
export class BilibiliAPIHandler implements IWebhookHandler {
  readonly name = 'Bilibili API Handler';
  readonly path = '/api/bilibili';
  readonly enabled = true;

  private logger = getLogger('BilibiliAPIHandler');
  private bilibiliAPI: BilibiliAPIService;
  private upload: multer.Multer;
  private delayedReplyService?: IDelayedReplyService;

  constructor() {
    // 初始化B站API服务
    try {
      this.bilibiliAPI = new BilibiliAPIService();
      this.logger.info('B站API服务初始化成功');
    } catch (error) {
      this.logger.error('B站API服务初始化失败', { error });
      throw error;
    }

    // 配置文件上传
    this.upload = multer({
      dest: 'uploads/',
      limits: {
        fileSize: 10 * 1024 * 1024 // 10MB
      },
      fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) {
          return cb(null, true);
        }
        cb(new Error('只支持图片格式: jpeg, jpg, png, gif, webp'));
      }
    });

    // 创建uploads目录
    const uploadsDir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
  }

  /**
   * 注册Express路由
   */
  registerRoutes(app: any): void {
    // 健康检查
    app.get(`${this.path}/health`, this.handleHealthCheck.bind(this));

    // 检查Cookie有效性
    app.get(`${this.path}/check-cookie`, this.handleCheckCookie.bind(this));

    // 获取主播动态列表（通过UID）
    app.get(`${this.path}/dynamics/:uid`, this.handleGetDynamics.bind(this));

    // 获取主播动态列表（通过直播间ID）
    app.get(`${this.path}/room/:roomId/dynamics`, this.handleGetRoomDynamics.bind(this));

    // 发布评论
    app.post(`${this.path}/comment`, this.handlePublishComment.bind(this));

    // 上传图片
    app.post(`${this.path}/upload`, this.upload.single('image'), this.handleUploadImage.bind(this));

    // 发布带图片的评论（一步完成）
    app.post(`${this.path}/comment-with-image`, this.upload.single('image'), this.handlePublishCommentWithImage.bind(this));

    // 获取配置信息
    app.get(`${this.path}/config`, this.handleGetConfig.bind(this));

    // 触发延迟回复任务
    app.post(`${this.path}/delayed-reply`, this.handleTriggerDelayedReply.bind(this));

    this.logger.info(`注册${this.name}处理器，路径: ${this.path}`);
  }

  /**
   * 处理健康检查请求
   */
  private async handleHealthCheck(req: Request, res: Response): Promise<void> {
    try {
      res.json({ success: true, message: 'B站API服务器运行中' });
    } catch (error: any) {
      this.logger.error('健康检查失败', { error });
      res.status(500).json({
        success: false,
        error: error.message || '服务器内部错误'
      });
    }
  }

  /**
   * 处理检查Cookie有效性请求
   */
  private async handleCheckCookie(req: Request, res: Response): Promise<void> {
    try {
      const isValid = await this.bilibiliAPI.isCookieValid();
      res.json({
        success: true,
        data: {
          valid: isValid,
          message: isValid ? 'Cookie有效' : 'Cookie无效或已过期'
        }
      });
    } catch (error: any) {
      this.logger.error('检查Cookie失败', { error });
      res.status(500).json({
        success: false,
        error: error.message || '检查Cookie失败'
      });
    }
  }

  /**
   * 处理获取主播动态列表请求
   */
  private async handleGetDynamics(req: Request, res: Response): Promise<void> {
    try {
      const { uid }: { uid?: string } = req.params;
      const { offset } = req.query;

      this.logger.info(`获取主播动态: ${uid}`, { offset });

      if (!uid) {
        res.status(400).json({
          success: false,
          error: '缺少必要参数: uid'
        });
        return;
      }

      let numOffset = 0;
      if (offset && typeof offset === 'string') {
        numOffset = parseInt(offset, 10);
      }
      if (isNaN(numOffset)) {
        res.status(400).json({
          success: false,
          error: '无效的偏移量'
        });
        return;
      }

      const dynamics = await this.bilibiliAPI.getDynamics(uid, offset ? offset.toString() : undefined);

      res.json({
        success: true,
        data: {
          uid,
          count: dynamics.length,
          dynamics: dynamics.map(d => ({
            id: d.id,
            type: d.type,
            content: d.content,
            images: d.images,
            publishTime: d.publishTime,
            url: d.url
          }))
        }
      });
    } catch (error: any) {
      this.logger.error('获取动态失败', { error });
      res.status(500).json({
        success: false,
        error: error.message || '获取动态失败'
      });
    }
  }

  /**
   * 处理通过直播间ID获取主播动态列表请求
   */
  private async handleGetRoomDynamics(req: Request, res: Response): Promise<void> {
    try {
      const { roomId }: { roomId?: string } = req.params;
      const { limit } = req.query;

      this.logger.info(`通过直播间ID获取主播动态: ${roomId}`, { limit });

      if (!roomId) {
        res.status(400).json({
          success: false,
          error: '缺少必要参数: roomId'
        });
        return;
      }

      // 根据直播间ID获取UID
      const uid = await this.bilibiliAPI.getUidByRoomId(roomId);

      // 获取动态列表
      const dynamics = await this.bilibiliAPI.getDynamics(uid);

      // 处理limit参数
      let resultDynamics = dynamics;
      if (limit && typeof limit === 'string') {
        const numLimit = parseInt(limit, 10);
        if (!isNaN(numLimit) && numLimit > 0) {
          resultDynamics = dynamics.slice(0, numLimit);
        }
      }

      res.json({
        success: true,
        data: {
          roomId,
          uid,
          count: resultDynamics.length,
          dynamics: resultDynamics.map(d => ({
            id: d.id,
            type: d.type,
            content: d.content,
            images: d.images,
            publishTime: d.publishTime,
            url: d.url
          }))
        }
      });
    } catch (error: any) {
      this.logger.error('通过直播间ID获取动态失败', { error });
      res.status(500).json({
        success: false,
        error: error.message || '获取动态失败'
      });
    }
  }

  /**
   * 处理发布评论请求
   */
  private async handlePublishComment(req: Request, res: Response): Promise<void> {
    try {
      const { dynamicId, content, images } = req.body;

      if (!dynamicId || !content) {
        res.status(400).json({
          success: false,
          error: '缺少必要参数: dynamicId, content'
        });
        return;
      }

      this.logger.info(`发布评论: ${dynamicId}`, { contentLength: content.length });

      const result = await this.bilibiliAPI.publishComment({
        dynamicId,
        content,
        images: images && images.length > 0 ? images : undefined
      });

      res.json({
        success: true,
        data: {
          replyId: result.replyId,
          replyTime: result.replyTime,
          message: '评论发布成功'
        }
      });
    } catch (error: any) {
      this.logger.error('发布评论失败', { error });
      res.status(500).json({
        success: false,
        error: error.message || '发布评论失败'
      });
    }
  }

  /**
   * 处理上传图片请求
   */
  private async handleUploadImage(req: Request, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: '未上传图片文件'
        });
        return;
      }

      const imagePath = req.file.path;
      this.logger.info(`上传图片: ${req.file.originalname}`, { path: imagePath });

      const imageUrl = await this.bilibiliAPI.uploadImage(imagePath);

      // 删除临时文件
      fs.unlinkSync(imagePath);

      res.json({
        success: true,
        data: {
          imageUrl,
          message: '图片上传成功'
        }
      });
    } catch (error: any) {
      this.logger.error('上传图片失败', { error });

      // 清理临时文件
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      res.status(500).json({
        success: false,
        error: error.message || '上传图片失败'
      });
    }
  }

  /**
   * 处理发布带图片的评论请求
   */
  private async handlePublishCommentWithImage(req: Request, res: Response): Promise<void> {
    try {
      const { dynamicId, content } = req.body;

      if (!dynamicId || !content) {
        res.status(400).json({
          success: false,
          error: '缺少必要参数: dynamicId, content'
        });
        return;
      }

      let imagePath: string | undefined;

      // 如果有图片，保存图片路径
      if (req.file) {
        imagePath = req.file.path;
        this.logger.info(`收到图片文件: ${req.file.originalname}`, { path: imagePath });
      }

      // 发布评论（Python脚本会处理图片上传）
      const result = await this.bilibiliAPI.publishComment({
        dynamicId,
        content,
        images: imagePath ? [imagePath] : undefined
      });

      // 删除临时文件
      if (imagePath && fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }

      res.json({
        success: true,
        data: {
          replyId: result.replyId,
          replyTime: result.replyTime,
          imageUrl: result.imageUrl,
          message: '评论发布成功'
        }
      });
    } catch (error: any) {
      this.logger.error('发布评论失败', { error });

      // 清理临时文件
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      res.status(500).json({
        success: false,
        error: error.message || '发布评论失败'
      });
    }
  }

  /**
   * 处理获取配置信息请求
   */
  private async handleGetConfig(req: Request, res: Response): Promise<void> {
    try {
      const config = ConfigProvider.getConfig();
      const bilibiliConfig = config.bilibili as any;

      res.json({
        success: true,
        data: {
          enabled: bilibiliConfig?.enabled || false,
          anchors: bilibiliConfig?.anchors || {},
          polling: bilibiliConfig?.polling || {}
        }
      });
    } catch (error: any) {
      this.logger.error('获取配置失败', { error });
      res.status(500).json({
        success: false,
        error: error.message || '获取配置失败'
      });
    }
  }

  /**
   * 处理触发延迟回复请求
   */
  private async handleTriggerDelayedReply(req: Request, res: Response): Promise<void> {
    try {
      const { roomId, goodnightTextPath, comicImagePath } = req.body;

      if (!roomId || !goodnightTextPath) {
        res.status(400).json({
          success: false,
          error: '缺少必要参数: roomId, goodnightTextPath'
        });
        return;
      }

      if (!this.delayedReplyService) {
        this.logger.warn('延迟回复服务未设置');
        res.status(503).json({
          success: false,
          error: '延迟回复服务未设置'
        });
        return;
      }

      this.logger.info(`触发延迟回复: roomId=${roomId}, goodnightTextPath=${goodnightTextPath}`);

      const taskId = await this.delayedReplyService.addTask(roomId, goodnightTextPath, comicImagePath);

      if (taskId) {
        res.json({
          success: true,
          data: {
            taskId,
            message: '延迟回复任务已添加'
          }
        });
      } else {
        res.json({
          success: true,
          data: {
            taskId: null,
            message: '延迟回复任务未添加（可能配置未启用）'
          }
        });
      }
    } catch (error: any) {
      this.logger.error('触发延迟回复失败', { error });
      res.status(500).json({
        success: false,
        error: error.message || '触发延迟回复失败'
      });
    }
  }

  /**
   * 设置延迟回复服务
   */
  setDelayedReplyService(service: IDelayedReplyService): void {
    this.delayedReplyService = service;
    this.logger.info('延迟回复服务已设置');
  }

  /**
   * 处理Webhook请求（此handler不使用此方法，所有请求通过registerRoutes注册）
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    res.status(404).json({ error: 'Not found' });
  }

  /**
   * 验证请求有效性（此handler不使用此方法）
   */
  validateRequest(req: Request): boolean {
    return false;
  }
}
