import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const localRequire = createRequire(path.resolve(process.env.DANMAKU_PROJECT_ROOT || '.', 'package.json'));
type Data = Record<string, any>;

/** Explicit recovery preserves the task identity, original options and failure history. */
export function retryFailedAsrTask(manager: Data, taskId: string, note: string): Data {
    if (!note.trim()) throw new Error('A recovery note is required');
    manager.reloadForMutation({ cleanupInvalid: false, cleanupStale: false });
    const task = manager.queue.find((row: Data) => row.id === taskId);
    if (!task || task.status !== 'failed') throw new Error('Only a failed ASR task can be recovered');
    if (manager.queue.some((row: Data) => row !== task && row.mediaPath === task.mediaPath
        && ['pending', 'processing', 'completed', 'completed_with_cleanup_crash'].includes(row.status))) {
        throw new Error('This recording already has an active or completed ASR task');
    }
    if (!fs.statSync(task.mediaPath).isFile() || task.xmlPath && !fs.statSync(task.xmlPath).isFile()) {
        throw new Error('Original ASR inputs are unavailable');
    }
    task.recoveryHistory = [...(task.recoveryHistory || []), {
        status: task.status, error: task.error, workerRetryCount: task.workerRetryCount,
        recoveryCount: task.recoveryCount, completedTime: task.completedTime,
        recoveredAt: new Date().toISOString(), note
    }];
    Object.assign(task, { status: 'pending', workerRetryCount: 0, recoveryCount: 0 });
    for (const key of ['error', 'startTime', 'completedTime', 'ownerPid', 'ownerBootTime', 'lastHeartbeat', 'lastWorkerError', 'lastWorkerFailureAt']) delete task[key];
    manager.saveQueue();
    return task;
}

export function runAsrRecovery(args: string[]): void {
    if (!process.env.NODE_ENV && !process.env.CONFIG_PATH) Object.assign(process.env, { NODE_ENV: 'production' });
    const manager = localRequire('./src/scripts/whisper_queue_manager.js');
    manager.loadQueue({ silent: true, cleanupInvalid: false, cleanupStale: false });
    if (!args.length || args[0] === 'list') {
        for (const task of manager.queue.filter((row: Data) => row.status === 'failed')) {
            console.log(JSON.stringify({ id: task.id, roomId: task.roomId, mediaPath: task.mediaPath, error: task.error }));
        }
        return;
    }
    const option = (key: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
    const ids = option('--ids')?.split(',').filter(Boolean) || [];
    if (args[0] !== 'retry' || !ids.length || !option('--note')?.trim()) {
        throw new Error('Usage: asr_queue_recovery.ts list | retry --ids <task,...> --note <verified repair>');
    }
    for (const id of ids) console.log(JSON.stringify(retryFailedAsrTask(manager, id, option('--note')!)));
}

if (/asr_queue_recovery\.(?:ts|js)$/u.test(path.basename(process.argv[1] || ''))) {
    try { runAsrRecovery(process.argv.slice(2)); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
