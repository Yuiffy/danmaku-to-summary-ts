import { Express, Request, Response } from 'express';
import { IWebhookHandler } from '../IWebhookService';
import { getLogger } from '../../../core/logging/LogManager';
import { IDelayedReplyService } from '../../bilibili/interfaces/IDelayedReplyService';

/**
 * 延迟回复处理器
 * 处理手动触发延迟回复的请求
 */
export class DelayedReplyHandler implements IWebhookHandler {
  name = 'DelayedReplyHandler';
  path = '/api/delayed-reply';
  enabled = true;
  private logger = getLogger('DelayedReplyHandler');
  private delayedReplyService?: IDelayedReplyService;

  constructor(delayedReplyService?: IDelayedReplyService) {
    this.delayedReplyService = delayedReplyService;
  }

  /**
   * 设置延迟回复服务
   */
  setDelayedReplyService(service: IDelayedReplyService): void {
    this.delayedReplyService = service;
    this.logger.info('延迟回复服务已设置');
  }

  /**
   * 注册路由
   */
  registerRoutes(app: Express): void {
    // POST /api/delayed-reply - 手动触发延迟回复
    app.post(this.path, async (req: Request, res: Response): Promise<any> => {
      try {
        const { roomId, delaySeconds, goodnightTextPath, comicImagePath } = req.body;
        
        if (!roomId) {
          return res.status(400).json({
            success: false,
            error: 'roomId is required'
          });
        }
        
        if (!this.delayedReplyService) {
          return res.status(500).json({
            success: false,
            error: 'Delayed reply service not available'
          });
        }
        
        // 查找文件路径（如果未指定）
        const textPath = goodnightTextPath || await this.findLatestGoodnightFile(roomId);
        const imagePath = comicImagePath || await this.findLatestComicFile(roomId);
        
        if (!textPath) {
          return res.status(400).json({
            success: false,
            error: 'Goodnight text file not found'
          });
        }
        
        // 添加延迟回复任务（直接传递 delaySeconds）
        const taskId = await this.delayedReplyService.addTask(roomId, textPath, imagePath || '', delaySeconds);
        
        this.logger.info(`手动触发延迟回复任务:`, {
          taskId,
          roomId,
          delaySeconds: delaySeconds || '使用配置的延迟时间',
          textPath,
          imagePath
        });
        
        return res.json({
          success: true,
          taskId,
          roomId,
          delaySeconds: delaySeconds || '使用配置的延迟时间',
          textPath,
          imagePath
        });
      } catch (error: any) {
        this.logger.error(`手动触发延迟回复失败: ${error.message}`, { error });
        return res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    this.logger.info(`注册延迟回复处理器路由: ${this.path}`);
  }

  /**
   * 处理Webhook请求
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    // 此方法由 registerRoutes 中的路由处理
    // 保留空实现以满足接口要求
    return;
  }

  /**
   * 验证请求有效性
   */
  validateRequest(req: Request): boolean {
    // 验证请求体是否包含必需的 roomId
    const { roomId } = req.body;
    return !!roomId;
  }

  /**
   * 查找最新的晚安回复文件
   */
  private async findLatestGoodnightFile(roomId: string): Promise<string | null> {
    const fs = await import('fs');
    const path = await import('path');
    
    const uploadsDir = path.join(process.cwd(), 'uploads');
    
    if (!fs.existsSync(uploadsDir)) {
      return null;
    }
    
    const files = fs.readdirSync(uploadsDir);
    const goodnightFiles = files.filter((f: string) =>
      f.includes(`-${roomId}-`) && f.endsWith('_晚安回复.md')
    );
    
    if (goodnightFiles.length === 0) {
      return null;
    }
    
    // 按文件名排序（包含时间戳），取最新的
    goodnightFiles.sort().reverse();
    return path.join(uploadsDir, goodnightFiles[0]);
  }
  
  /**
   * 查找最新的漫画文件
   */
  private async findLatestComicFile(roomId: string): Promise<string | null> {
    const fs = await import('fs');
    const path = await import('path');
    
    const uploadsDir = path.join(process.cwd(), 'uploads');
    
    if (!fs.existsSync(uploadsDir)) {
      return null;
    }
    
    const files = fs.readdirSync(uploadsDir);
    const comicFiles = files.filter((f: string) =>
      f.includes(`-${roomId}-`) && f.endsWith('_COMIC_FACTORY.png')
    );
    
    if (comicFiles.length === 0) {
      return null;
    }
    
    // 按文件名排序（包含时间戳），取最新的
    comicFiles.sort().reverse();
    return path.join(uploadsDir, comicFiles[0]);
  }
}
