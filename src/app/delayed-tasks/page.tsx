'use client';

import { useEffect, useState } from 'react';

interface DelayedReplyTask {
  taskId: string;
  roomId: string;
  uid?: string;
  goodnightTextPath: string;
  comicImagePath?: string;
  createTime: string;
  scheduledTime: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  retryCount?: number;
  error?: string;
}

interface TasksResponse {
  tasks: DelayedReplyTask[];
}

export default function DelayedTasksPage() {
  const [tasks, setTasks] = useState<DelayedReplyTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());

  // 获取任务列表
  const fetchTasks = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/delayed-tasks');
      const data: TasksResponse = await response.json();
      setTasks(data.tasks || []);
    } catch (err: any) {
      setError(err.message || '获取任务列表失败');
    } finally {
      setLoading(false);
    }
  };

  // 取消任务
  const cancelTask = async (taskId: string) => {
    try {
      setCancelling(prev => new Set(prev).add(taskId));
      const response = await fetch('/api/delayed-tasks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });

      if (response.ok) {
        // 刷新任务列表
        await fetchTasks();
      } else {
        const data = await response.json();
        setError(data.error || '取消任务失败');
      }
    } catch (err: any) {
      setError(err.message || '取消任务失败');
    } finally {
      setCancelling(prev => {
        const newSet = new Set(prev);
        newSet.delete(taskId);
        return newSet;
      });
    }
  };

  // 格式化时间
  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  // 计算剩余时间
  const getRemainingTime = (scheduledTime: string) => {
    const now = new Date();
    const scheduled = new Date(scheduledTime);
    const diff = scheduled.getTime() - now.getTime();

    if (diff <= 0) return '已到期';

    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);

    return `${minutes}分${seconds}秒`;
  };

  // 获取状态颜色
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200';
      case 'processing':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
      case 'completed':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
      case 'failed':
        return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200';
    }
  };

  // 获取状态文本
  const getStatusText = (status: string) => {
    switch (status) {
      case 'pending':
        return '待执行';
      case 'processing':
        return '执行中';
      case 'completed':
        return '已完成';
      case 'failed':
        return '失败';
      default:
        return status;
    }
  };

  // 定时刷新
  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 5000); // 每5秒刷新一次
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-6 text-gray-900 dark:text-white">
          延迟回复任务列表
        </h1>

        {error && (
          <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 dark:bg-red-900 dark:border-red-600 dark:text-red-200 rounded">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-center py-8 text-gray-600 dark:text-gray-400">
            加载中...
          </div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-8 text-gray-600 dark:text-gray-400">
            暂无延迟任务
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-800 shadow-md rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-700">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    任务ID
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    房间ID
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    创建时间
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    计划时间
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    剩余时间
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    状态
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {tasks.map((task) => (
                  <tr key={task.taskId} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-white">
                      {task.taskId.slice(0, 8)}...
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-white">
                      {task.roomId}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-white">
                      {formatTime(task.createTime)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-white">
                      {formatTime(task.scheduledTime)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-white">
                      {getRemainingTime(task.scheduledTime)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getStatusColor(task.status)}`}>
                        {getStatusText(task.status)}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                      {task.status === 'pending' && (
                        <button
                          onClick={() => cancelTask(task.taskId)}
                          disabled={cancelling.has(task.taskId)}
                          className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {cancelling.has(task.taskId) ? '取消中...' : '取消'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 text-sm text-gray-600 dark:text-gray-400">
          <p>提示：页面每5秒自动刷新一次</p>
        </div>
      </div>
    </div>
  );
}
