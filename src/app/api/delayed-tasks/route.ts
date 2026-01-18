import { NextRequest, NextResponse } from 'next/server';
import { ServiceManager } from '../../../services/ServiceManager';

// 获取全局服务管理器实例
let serviceManager: ServiceManager | null = null;

function getServiceManager(): ServiceManager {
  if (!serviceManager) {
    serviceManager = new ServiceManager();
  }
  return serviceManager;
}

/**
 * 查找最新的晚安回复文件
 */
async function findLatestGoodnightFile(roomId: string): Promise<string | null> {
  const fs = await import('fs');
  const path = await import('path');
  
  const uploadsDir = path.join(process.cwd(), 'uploads');
  
  if (!fs.existsSync(uploadsDir)) {
    return null;
  }
  
  const files = fs.readdirSync(uploadsDir);
  const goodnightFiles = files.filter(f => 
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
async function findLatestComicFile(roomId: string): Promise<string | null> {
  const fs = await import('fs');
  const path = await import('path');
  
  const uploadsDir = path.join(process.cwd(), 'uploads');
  
  if (!fs.existsSync(uploadsDir)) {
    return null;
  }
  
  const files = fs.readdirSync(uploadsDir);
  const comicFiles = files.filter(f => 
    f.includes(`-${roomId}-`) && f.endsWith('_COMIC_FACTORY.png')
  );
  
  if (comicFiles.length === 0) {
    return null;
  }
  
  // 按文件名排序（包含时间戳），取最新的
  comicFiles.sort().reverse();
  return path.join(uploadsDir, comicFiles[0]);
}

/**
 * GET /api/delayed-tasks - 获取所有延迟任务
 */
export async function GET() {
  try {
    const manager = getServiceManager();
    const delayedReplyService = manager.getDelayedReplyService();

    if (!delayedReplyService) {
      return NextResponse.json(
        { error: '延迟回复服务未初始化' },
        { status: 503 }
      );
    }

    const tasks = delayedReplyService.getTasks();
    return NextResponse.json({ tasks });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || '获取延迟任务失败' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/delayed-tasks - 手动触发延迟回复
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { roomId, delaySeconds, goodnightTextPath, comicImagePath } = body;

    if (!roomId) {
      return NextResponse.json(
        { error: '缺少 roomId 参数' },
        { status: 400 }
      );
    }

    const manager = getServiceManager();
    const delayedReplyService = manager.getDelayedReplyService();

    if (!delayedReplyService) {
      return NextResponse.json(
        { error: '延迟回复服务未初始化' },
        { status: 503 }
      );
    }

    // 如果指定了延迟秒数，临时修改配置
    let originalDelayMinutes: number | undefined;
    if (delaySeconds !== undefined) {
      const { BilibiliConfigHelper } = await import('../../../services/bilibili/BilibiliConfigHelper');
      const config = BilibiliConfigHelper.getDelayedReplySettings(roomId);
      if (config) {
        originalDelayMinutes = config.delayMinutes;
        // 临时修改延迟时间
        config.delayMinutes = delaySeconds / 60;
      }
    }

    // 使用提供的路径或查找默认路径
    const textPath = goodnightTextPath || await findLatestGoodnightFile(roomId);
    const imagePath = comicImagePath || await findLatestComicFile(roomId);

    if (!textPath) {
      return NextResponse.json(
        { error: '未找到晚安回复文件' },
        { status: 400 }
      );
    }

    const taskId = await delayedReplyService.addTask(roomId, textPath, imagePath);

    // 恢复原始延迟时间
    if (originalDelayMinutes !== undefined) {
      const { BilibiliConfigHelper } = await import('../../../services/bilibili/BilibiliConfigHelper');
      const config = BilibiliConfigHelper.getDelayedReplySettings(roomId);
      if (config) {
        config.delayMinutes = originalDelayMinutes;
      }
    }

    return NextResponse.json({
      success: true,
      taskId,
      message: `延迟回复任务已创建，将在 ${delaySeconds ? delaySeconds + '秒' : '配置的时间'} 后执行`
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || '创建延迟任务失败' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/delayed-tasks - 取消延迟任务
 */
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { taskId } = body;

    if (!taskId) {
      return NextResponse.json(
        { error: '缺少 taskId 参数' },
        { status: 400 }
      );
    }

    const manager = getServiceManager();
    const delayedReplyService = manager.getDelayedReplyService();

    if (!delayedReplyService) {
      return NextResponse.json(
        { error: '延迟回复服务未初始化' },
        { status: 503 }
      );
    }

    await delayedReplyService.removeTask(taskId);
    return NextResponse.json({ success: true, taskId });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || '取消延迟任务失败' },
      { status: 500 }
    );
  }
}
