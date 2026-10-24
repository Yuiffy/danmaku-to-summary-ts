import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retryFailedAsrTask } from './asr_queue_recovery';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-recovery-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
function fixture() {
    const mediaPath = path.join(dir, 'recording.flv'), xmlPath = path.join(dir, 'recording.xml');
    fs.writeFileSync(mediaPath, 'video'); fs.writeFileSync(xmlPath, 'xml');
    const task: Record<string, any> = { id: 'same-id', mediaPath, xmlPath, roomId: '1', status: 'failed',
        addedTime: 100, workerRetryCount: 3, recoveryCount: 2, error: 'silence failure', ownerPid: 123, startTime: 20,
        customOptions: { model: 'original' } };
    const manager = { queue: [task], reloadForMutation: jest.fn(), saveQueue: jest.fn() };
    return { manager, task };
}
test('preserves identity and options, archives exhausted retries and clears active ownership', () => {
    const { manager, task } = fixture();
    expect(retryFailedAsrTask(manager, task.id, 'verified silence fix')).toBe(task);
    expect(task).toMatchObject({ id: 'same-id', addedTime: 100, status: 'pending', workerRetryCount: 0,
        recoveryCount: 0, customOptions: { model: 'original' }, recoveryHistory: [expect.objectContaining({ error: 'silence failure', workerRetryCount: 3 })] });
    expect(task.ownerPid).toBeUndefined(); expect(task.startTime).toBeUndefined(); expect(task.error).toBeUndefined();
    expect(manager.saveQueue).toHaveBeenCalledTimes(1);
});
test.each(['pending', 'processing', 'completed', 'completed_with_cleanup_crash'])('cannot retry %s tasks', status => {
    const { manager, task } = fixture(); task.status = status;
    expect(() => retryFailedAsrTask(manager, task.id, 'fix')).toThrow('Only a failed');
    expect(manager.saveQueue).not.toHaveBeenCalled();
});
test('cannot duplicate a successful or running task for the same recording', () => {
    const { manager, task } = fixture(); manager.queue.push({ ...task, id: 'other', status: 'completed' });
    expect(() => retryFailedAsrTask(manager, task.id, 'fix')).toThrow('already has');
});
test('refuses missing original input and requires an explanation', () => {
    const { manager, task } = fixture();
    expect(() => retryFailedAsrTask(manager, task.id, '')).toThrow('note');
    fs.unlinkSync(task.mediaPath);
    expect(() => retryFailedAsrTask(manager, task.id, 'fix')).toThrow();
    expect(manager.saveQueue).not.toHaveBeenCalled();
});
