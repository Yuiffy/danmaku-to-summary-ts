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
