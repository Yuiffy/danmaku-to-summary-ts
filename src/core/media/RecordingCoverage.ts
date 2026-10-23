import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export interface SourceSpan { identity: string; start: number; duration: number; day?: string }
export interface RecordingMap { version: number; outputIdentity: string; spans: SourceSpan[] }

/** Path independent: normal finalization moves the same recording into bak/. */
export function recordingIdentity(file: string): string {
    const stat = fs.statSync(file), fd = fs.openSync(file, 'r');
    try {
        const hash = createHash('sha256').update(`${path.basename(file)}:${stat.size}:`);
        for (const offset of [0, Math.max(0, stat.size - 65536)]) {
            const data = Buffer.alloc(Math.min(65536, stat.size));
            const count = fs.readSync(fd, data, 0, data.length, offset);
            hash.update(data.subarray(0, count));
        }
        return hash.digest('hex');
    } finally { fs.closeSync(fd); }
}

export function atomicRecordingJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temporary, file);
}

export function withRecordingAdmissionLock<T>(ledger: string, run: () => T): T {
    fs.mkdirSync(ledger, { recursive: true });
    const lock = path.join(ledger, 'admission.lock');
    if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs > 60000) {
        const owner = Number(fs.readFileSync(lock, 'utf8'));
        try { if (owner > 0) process.kill(owner, 0); else fs.unlinkSync(lock); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') fs.unlinkSync(lock); }
    }
    let fd: number;
    try { fd = fs.openSync(lock, 'wx'); } catch { throw new Error('Campaign admission already running; retry next poll'); }
    try { fs.writeFileSync(fd, String(process.pid)); return run(); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

export async function writeRecordingMap(sources: string[], output: string,
    duration: (file: string) => Promise<number>, gapAfter: (index: number) => number): Promise<void> {
    let start = 0;
    const spans: SourceSpan[] = [];
    for (let index = 0; index < sources.length; index++) {
        const seconds = await duration(sources[index]);
        if (!(seconds > 0 && Number.isFinite(seconds))) throw new Error('Recording map requires measured durations');
        spans.push({ identity: recordingIdentity(sources[index]), start, duration: seconds,
            day: path.basename(sources[index]).match(/^录制-\d+-(\d{8})-/u)?.[1] });
        start += seconds + (index < sources.length - 1 ? gapAfter(index) : 0);
    }
    if (Math.abs(await duration(output) - start) > 2) throw new Error('Merged recording timeline differs from source map');
    atomicRecordingJson(`${output}.sources.json`, { version: 1, outputIdentity: recordingIdentity(output), spans });
}

export function readRecordingMap(media: string): RecordingMap | null {
    const file = `${media}.sources.json`;
    if (!fs.existsSync(file)) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || value.outputIdentity !== recordingIdentity(media) || !Array.isArray(value.spans)
        || value.spans.some((span: SourceSpan) => !span.identity || !Number.isFinite(span.start)
            || span.start < 0 || !(span.duration > 0 && Number.isFinite(span.duration)))) {
        throw new Error('Recording source map is invalid or media changed');
    }
    return value;
}

export function excludeCovered<T extends { start: number; end: number }>(clips: T[], spans: SourceSpan[], identities: Set<string>): T[] {
    const covered = spans.filter(span => identities.has(span.identity));
    return clips.filter(clip => !covered.some(span => Math.min(clip.end, span.start + span.duration) - Math.max(clip.start, span.start) > 0));
}

/** Normal finalization also reserves its uncovered sources before selecting/publishing. */
export function reserveFinalCampaign(media: string, campaignId: string, ledger = path.resolve('data/runtime/campaign-early')): void {
    const match = path.basename(media).match(/^录制-(\d+)-(\d{8})-/u);
    if (!match) throw new Error('Campaign finalization requires a dated recording');
    fs.mkdirSync(ledger, { recursive: true });
    withRecordingAdmissionLock(ledger, () => {
    const map = readRecordingMap(media);
    if (!map && /_merged\./u.test(media)) throw new Error('活动去重缺少合并来源时间轴，保留任务供恢复');
    const id = createHash('sha256').update(`final:${campaignId}:${recordingIdentity(media)}`).digest('hex').slice(0, 20);
    const file = path.join(ledger, `${id}.json`);
    if (fs.existsSync(file)) return;
    const reserved = new Set<string>(fs.readdirSync(ledger).filter(name => name.endsWith('.json'))
        .flatMap(name => JSON.parse(fs.readFileSync(path.join(ledger, name), 'utf8')).sources.map((source: { identity: string }) => source.identity)));
    const sources = (map?.spans || [{ identity: recordingIdentity(media), start: 0, duration: Number.MAX_SAFE_INTEGER }])
        .filter(source => !reserved.has(source.identity));
    atomicRecordingJson(file, { version: 1, id, campaignId, kind: 'final', roomId: match[1], day: match[2], mediaPath: media, sources });
    });
}

/** Claims reserve source ranges at admission, so finalization cannot race an early job. */
export function filterCampaignCoverage<T extends { start: number; end: number }>(clips: T[], media: string,
    ledger = path.resolve('data/runtime/campaign-early')): T[] {
    if (!fs.existsSync(ledger)) return clips;
    const match = path.basename(media).match(/^录制-(\d+)-(\d{8})-/u);
    if (!match) return clips;
    const claims = fs.readdirSync(ledger).filter(file => file.endsWith('.json'))
        .map(file => JSON.parse(fs.readFileSync(path.join(ledger, file), 'utf8')))
        .filter(row => row.roomId === match[1] && (row.day === match[2] || row.sources.some((source: { day?: string }) => source.day === match[2]))
            && path.resolve(row.mediaPath) !== path.resolve(media));
    if (!claims.length) return clips;
    const identities = new Set<string>(claims.flatMap(row => row.sources.map((source: { identity: string }) => source.identity)));
    const map = readRecordingMap(media);
    // Old merged recordings have no reliable source offsets; never guess wall-clock offsets.
    if (!map && /_merged\./u.test(media)) throw new Error('提前切片去重缺少合并来源时间轴，保留任务供恢复');
    return excludeCovered(clips, map?.spans || [{ identity: recordingIdentity(media), start: 0, duration: Number.MAX_SAFE_INTEGER }], identities);
}
