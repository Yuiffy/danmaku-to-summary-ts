import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { resolveRecordingClipJob } from './recording_clip_job';

test('operator adapter matches only its source directory, room and session prefix, and binds executable content', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-job-'));
    try {
        const scriptPath = path.join(root, 'adapter.ts');
        fs.writeFileSync(scriptPath, '// operator adapter');
        const recordingDirectory = path.join(root, 'recordings', '2026_10_16');
        const job = { id: 'once', roomId: '12', recordingDirectory, filenamePrefix: 'recording-12-20261016-', recordingTitle: 'birthday',
            scriptPath, scriptSha256: crypto.createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex'), authorization: 'user request' };
        fs.mkdirSync(path.join(root, 'data/runtime'), { recursive: true });
        fs.writeFileSync(path.join(root, 'data/runtime/recording_clip_jobs.json'), JSON.stringify({ jobs: [job] }));
        const payload = { roomId: '12', originalMediaPath: path.join(recordingDirectory, 'recording-12-20261016-200000-birthday.flv') };
        expect(resolveRecordingClipJob(root, payload)?.id).toBe('once');
        expect(resolveRecordingClipJob(root, { ...payload, originalMediaPath: path.join(recordingDirectory, 'recording-12-20261016-201000-birthday_merged.flv') })?.id).toBe('once');
        expect(resolveRecordingClipJob(root, { ...payload, originalMediaPath: path.join(recordingDirectory, 'recording-12-20261016-220000-other.flv') })).toBeNull();
        expect(resolveRecordingClipJob(root, { ...payload, roomId: '13' })).toBeNull();
        expect(resolveRecordingClipJob(root, { ...payload, originalMediaPath: path.join(root, 'other', path.basename(payload.originalMediaPath)) })).toBeNull();
        expect(resolveRecordingClipJob(root, { ...payload, originalMediaPath: path.join(recordingDirectory, 'recording-12-20261017-200000.flv') })).toBeNull();
        fs.appendFileSync(scriptPath, '\n// changed');
        expect(() => resolveRecordingClipJob(root, payload)).toThrow('changed');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
