import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import type { MergeTrace, RecordingPacket } from '../core/media/RecordingMergeTrace';

const localRequire = createRequire(path.resolve(process.env.DANMAKU_PROJECT_ROOT || '.', 'package.json'));
const { findMergeTrace, measuredMergeSpans, matchPacketOffset } = localRequire('./src/core/media/RecordingMergeTrace.ts');
const { recordingIdentity, readRecordingMap, atomicRecordingJson } = localRequire('./src/core/media/RecordingCoverage.ts');

async function probe(file: string, args: string[]): Promise<any> {
    return new Promise((resolve, reject) => execFile('ffprobe', ['-v', 'error', ...args, '-of', 'json', file],
        { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000 },
        (error, stdout) => { if (error) reject(error); else { try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); } } }));
}

async function duration(file: string): Promise<number> {
    const result = await probe(file, ['-show_entries', 'format=duration']);
    const seconds = Number(result.format?.duration);
    if (!(seconds > 0 && Number.isFinite(seconds))) throw new Error(`Invalid recording duration: ${file}`);
    return seconds;
}

async function packets(file: string, interval: string): Promise<RecordingPacket[]> {
    const result = await probe(file, ['-select_streams', 'v:0', '-read_intervals', interval,
        '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=pts_time,data_hash']);
    const values = (result.packets || []).map((p: any) => ({ pts: Number(p.pts_time), hash: p.data_hash }));
    if (values.some((p: RecordingPacket) => !Number.isFinite(p.pts) || !/^SHA256:[a-f0-9]{64}$/u.test(p.hash))) {
        throw new Error('Invalid original video packet evidence');
    }
    return values;
}

export interface RecordingMapRecoveryIO {
    logs(): Iterable<{ file: string; text: string }>;
    duration(file: string): Promise<number>;
    packets(file: string, interval: string): Promise<RecordingPacket[]>;
}

function* mergeLogs(): Iterable<{ file: string; text: string }> {
    const directory = path.join(path.dirname(localRequire.resolve('./package.json')), 'logs');
    if (!fs.existsSync(directory)) return;
    const files = fs.readdirSync(directory).filter(name => /^pm2-out-\d+(?:__.*)?\.log$/u.test(name))
        .map(name => path.join(directory, name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    for (const file of files) yield { file, text: fs.readFileSync(file, 'utf8') };
}

/** Repair old compiled mergers using measured merge progress AND current original packet bytes. */
export async function ensureRecordingMap(media: string, io: RecordingMapRecoveryIO = { logs: mergeLogs, duration, packets }): Promise<void> {
    if (!/_merged\.flv$/u.test(media) || readRecordingMap(media)) return;
    const outputIdentity = recordingIdentity(media);
    let found: { file: string; trace: MergeTrace } | undefined;
    for (const log of io.logs()) {
        const trace = findMergeTrace(log.text, path.basename(media));
        if (trace) { found = { file: log.file, trace }; break; }
    }
    if (!found) throw new Error('合并来源时间轴无法恢复：缺少完整合并记录，保留任务供恢复');
    const sources = found.trace.parts.map(part => {
        if (path.basename(part.name) !== part.name) throw new Error('Invalid merge source filename');
        const locations = [path.join(path.dirname(media), part.name), path.join(path.dirname(media), 'bak', part.name)];
        const file = locations.find(file => fs.existsSync(file));
        if (!file) throw new Error(`Merge source unavailable: ${part.name}`);
        if (Date.now() - fs.statSync(file).mtimeMs < 90_000) throw new Error('Merge source is still active');
        return { file, identity: recordingIdentity(file) };
    });
    const lengths = [];
    for (const source of sources) lengths.push(await io.duration(source.file));
    const spans = measuredMergeSpans(found.trace, lengths, await io.duration(media));
    const checks = [];
    for (let index = 0; index < sources.length; index++) {
        const source = sources[index], span = spans[index];
        const head = (await io.packets(source.file, '%+#6')).slice(0, 6);
        const tail = (await io.packets(source.file, `${Math.max(0, span.duration - 3)}%`)).slice(-6);
        const opening = await io.packets(media, `${Math.max(0, span.start - 1)}%${span.start + 3}`);
        const ending = await io.packets(media, `${Math.max(0, span.start + span.duration - 4)}%${span.start + span.duration + 1}`);
        const startOffset = matchPacketOffset(head, opening, span.start);
        const endOffset = matchPacketOffset(tail, ending, span.start);
        if (Math.abs(startOffset - endOffset) > .05) throw new Error('Merged source timing changes between opening and ending');
        checks.push({ source: source.identity, startOffset, endOffset, head, tail });
    }
    if (recordingIdentity(media) !== outputIdentity || sources.some(source => recordingIdentity(source.file) !== source.identity)) {
        throw new Error('Recording changed during source map recovery');
    }
    atomicRecordingJson(`${media}.sources.json`, { version: 1, outputIdentity,
        spans: sources.map((source, index) => ({ identity: source.identity, ...spans[index],
            day: path.basename(source.file).match(/^录制-\d+-(\d{8})-/u)?.[1] })),
        recovery: { method: 'measured_merge_trace_and_original_packets', logPath: found.file,
            traceSha256: createHash('sha256').update(found.trace.evidence).digest('hex'), trace: found.trace.evidence, checks } });
    readRecordingMap(media);
    console.log(`合并来源时间轴已恢复并核验原始视频包: ${path.basename(media)} (${sources.length} 段)`);
}
