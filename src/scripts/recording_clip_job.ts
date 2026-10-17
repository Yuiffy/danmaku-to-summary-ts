import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

interface Payload { roomId?: string; originalMediaPath?: string; processedMediaPath?: string }
interface Job {
    id: string; roomId: string; recordingDirectory: string; filenamePrefix: string; recordingTitle: string;
    scriptPath: string; scriptSha256: string; authorization: string;
}

/** Local operator registrations only; recording/webhook payloads cannot choose executable code. */
export function resolveRecordingClipJob(root: string, payload: Payload): Job | null {
    const file = path.join(root, 'data/runtime/recording_clip_jobs.json');
    if (!fs.existsSync(file)) return null;
    const jobs: Job[] = JSON.parse(fs.readFileSync(file, 'utf8')).jobs;
    if (!Array.isArray(jobs)) throw new Error('Invalid recording clip job registrations');
    const media = payload.originalMediaPath || payload.processedMediaPath || '';
    const canonical = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    const matches = jobs.filter(job => String(payload.roomId) === job.roomId
        && canonical(path.dirname(media)) === canonical(job.recordingDirectory)
        && path.basename(media).startsWith(job.filenamePrefix)
        && [`-${job.recordingTitle}.flv`, `-${job.recordingTitle}_merged.flv`].some(suffix => path.basename(media).endsWith(suffix)));
    if (matches.length > 1) throw new Error('Ambiguous recording clip job');
    const job = matches[0];
    if (!job) return null;
    const relative = path.relative(root, job.scriptPath);
    if (!job.authorization?.trim() || relative.startsWith('..') || path.isAbsolute(relative)
        || !/\.(?:ts|js)$/u.test(job.scriptPath)
        || crypto.createHash('sha256').update(fs.readFileSync(job.scriptPath)).digest('hex') !== job.scriptSha256) {
        throw new Error('Recording clip job adapter or authorization changed; inspect registration');
    }
    return job;
}

export async function executeRecordingClipJob(root: string, job: Job, payloadPath: string): Promise<void> {
    // Await inside the existing serialized worker. No detached worker, timer or second queue.
    await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [job.scriptPath, '--payload', payloadPath], {
            cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NODE_ENV: 'production' }
        });
        child.stdout.on('data', chunk => console.log(String(chunk).trimEnd()));
        child.stderr.on('data', chunk => console.error(String(chunk).trimEnd()));
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`Recording clip job ${job.id} exited ${code}`)));
    });
}
