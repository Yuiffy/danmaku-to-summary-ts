/**
 * B站动态回复API服务器
 * 提供HTTP接口用于调试B站动态回复功能
 */
import express, { Request, Response } from 'express';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { BilibiliAPIService } from '../services/bilibili/BilibiliAPIService';
import { getLogger } from '../core/logging/LogManager';
import { ConfigProvider } from '../core/config/ConfigProvider';

const logger = getLogger('BilibiliAPIServer');
const app: express.Express = express();
const PORT = process.env.PORT || 3000;

// 配置文件上传
const upload = multer({
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

// 初始化B站API服务
let bilibiliAPI: BilibiliAPIService;

try {
  bilibiliAPI = new BilibiliAPIService();
  logger.info('B站API服务初始化成功');
} catch (error) {
  logger.error('B站API服务初始化失败', { error });
  process.exit(1);
}

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 错误处理中间件
app.use((err: any, req: Request, res: Response, next: any) => {
  logger.error('API错误', { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    success: false,
    error: err.message || '服务器内部错误'
  });
});

/**
 * 健康检查
 */
app.get('/health', (req: Request, res: Response) => {
  res.json({ success: true, message: 'B站API服务器运行中' });
});

/**
 * 检查Cookie有效性
 */
app.get('/api/bilibili/check-cookie', async (req: Request, res: Response) => {
  try {
    const isValid = await bilibiliAPI.isCookieValid();
    res.json({
      success: true,
      data: {
        valid: isValid,
        message: isValid ? 'Cookie有效' : 'Cookie无效或已过期'
      }
    });
  } catch (error) {
    logger.error('检查Cookie失败', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '检查Cookie失败'
    });
  }
});

/**
 * 获取主播动态列表
 */
app.get('/api/bilibili/dynamics/:uid', async (req: Request, res: Response) => {
  try {
    const { uid } = req.params;
    const { offset } = req.query;

    logger.info(`获取主播动态: ${uid}`, { offset });

    const dynamics = await bilibiliAPI.getDynamics(uid, Array.isArray(offset) ? offset[0] : offset);

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
  } catch (error) {
    logger.error('获取动态失败', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取动态失败'
    });
  }
});

/**
 * 发布评论
 */
app.post('/api/bilibili/comment', async (req: Request, res: Response) => {
  try {
    const { dynamicId, content, images } = req.body;

    if (!dynamicId || !content) {
      return res.status(400).json({
        success: false,
        error: '缺少必要参数: dynamicId, content'
      });
    }

    logger.info(`发布评论: ${dynamicId}`, { contentLength: content.length });

    const result = await bilibiliAPI.publishComment({
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
  } catch (error) {
    logger.error('发布评论失败', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '发布评论失败'
    });
  }
});

/**
 * 上传图片
 */
app.post('/api/bilibili/upload', upload.single('image'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: '未上传图片文件'
      });
    }

    const imagePath = req.file.path;
    logger.info(`上传图片: ${req.file.originalname}`, { path: imagePath });

    const imageUrl = await bilibiliAPI.uploadImage(imagePath);

    // 删除临时文件
    fs.unlinkSync(imagePath);

    res.json({
      success: true,
      data: {
        imageUrl,
        message: '图片上传成功'
      }
    });
  } catch (error) {
    logger.error('上传图片失败', { error });

    // 清理临时文件
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '上传图片失败'
    });
  }
});

/**
 * 发布带图片的评论（一步完成）
 */
app.post('/api/bilibili/comment-with-image', upload.single('image'), async (req: Request, res: Response) => {
  try {
    const { dynamicId, content } = req.body;

    if (!dynamicId || !content) {
      return res.status(400).json({
        success: false,
        error: '缺少必要参数: dynamicId, content'
      });
    }

    let imageUrl: string | undefined;

    // 如果有图片，先上传
    if (req.file) {
      logger.info(`上传图片: ${req.file.originalname}`, { path: req.file.path });
      imageUrl = await bilibiliAPI.uploadImage(req.file.path);
      logger.info('图片上传成功', { imageUrl });
    }

    // 发布评论
    const result = await bilibiliAPI.publishComment({
      dynamicId,
      content,
      images: imageUrl ? [imageUrl] : undefined
    });

    // 删除临时文件
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.json({
      success: true,
      data: {
        replyId: result.replyId,
        replyTime: result.replyTime,
        imageUrl,
        message: '评论发布成功'
      }
    });
  } catch (error) {
    logger.error('发布评论失败', { error });

    // 清理临时文件
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '发布评论失败'
    });
  }
});

/**
 * 获取配置信息
 */
app.get('/api/bilibili/config', (req: Request, res: Response) => {
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
  } catch (error) {
    logger.error('获取配置失败', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取配置失败'
    });
  }
});

// 创建uploads目录
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// 启动服务器
app.listen(PORT, () => {
  logger.info(`B站API服务器已启动: http://localhost:${PORT}`);
  logger.info('可用API端点:');
  logger.info('  GET  /health - 健康检查');
  logger.info('  GET  /api/bilibili/check-cookie - 检查Cookie有效性');
  logger.info('  GET  /api/bilibili/dynamics/:uid - 获取主播动态列表');
  logger.info('  POST /api/bilibili/comment - 发布评论');
  logger.info('  POST /api/bilibili/upload - 上传图片');
  logger.info('  POST /api/bilibili/comment-with-image - 发布带图片的评论');
  logger.info('  GET  /api/bilibili/config - 获取配置信息');
});

export default app;
