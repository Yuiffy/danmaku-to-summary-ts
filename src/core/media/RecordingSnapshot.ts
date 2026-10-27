import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { parseStringPromise } from 'xml2js';
const localRequire = createRequire(path.resolve('package.json'));
const { recordingPrefixHash } = localRequire('./src/core/media/RecordingCoverage.ts');

/** Read-only fixed-size capture. The writer may append, but must not rewrite captured bytes. */
export function snapshotFlv(source: string, destination: string): {
    bytes: number; sha256: string; lastTimestamp: number; metadataRanges: Array<{ start: number; length: number }>;
} {
    const fd = fs.openSync(source, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        // Avoid retaining a whole multi-hour recording in memory: copy a fixed byte count first.
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const output = fs.openSync(destination, 'wx'), buffer = Buffer.alloc(1024 * 1024);
        try {
            for (let offset = 0; offset < size;) {
                const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
                if (!count) throw new Error('Recording changed during snapshot');
                let written = 0;
                while (written < count) written += fs.writeSync(output, buffer, written, count - written);
                offset += count;
            }
        } finally { fs.closeSync(output); }
    } finally { fs.closeSync(fd); }
    // Tag headers are tiny; seek over payloads instead of allocating the captured video.
    const captured = fs.openSync(destination, 'r+'), header = Buffer.alloc(13), tag = Buffer.alloc(11), trailer = Buffer.alloc(4);
    let end = 0;
    let lastTimestamp = 0;
    const metadataRanges: Array<{ start: number; length: number }> = [];
    try {
        const size = fs.fstatSync(captured).size;
        if (fs.readSync(captured, header, 0, 13, 0) !== 13 || header.toString('ascii', 0, 3) !== 'FLV' || header[3] !== 1) throw new Error('Invalid FLV header');
        end = header.readUInt32BE(5);
        if (end < 9 || end + 4 > size || fs.readSync(captured, trailer, 0, 4, end) !== 4 || trailer.readUInt32BE() !== 0) throw new Error('Invalid FLV header size');
        end += 4;
        let tags = 0;
        while (end + 11 <= size) {
            if (fs.readSync(captured, tag, 0, 11, end) !== 11) throw new Error('Incomplete FLV header');
            const length = tag.readUIntBE(1, 3), next = end + 11 + length + 4;
            if (![8, 9, 18].includes(tag[0] & 31) || tag.readUIntBE(8, 3) !== 0) throw new Error('Invalid FLV tag');
            if (next > size) break;
            if (fs.readSync(captured, trailer, 0, 4, next - 4) !== 4 || trailer.readUInt32BE() !== length + 11) throw new Error('Invalid FLV tag trailer');
            if (tag[0] === 18 && length) metadataRanges.push({ start: end + 11, length });
            else lastTimestamp = Math.max(lastTimestamp, (tag.readUIntBE(4, 3) + tag[7] * 0x1000000) / 1000);
            end = next; tags++;
        }
        if (!tags) throw new Error('No complete FLV tags');
        fs.ftruncateSync(captured, end);
    } finally { fs.closeSync(captured); }
    const sha256 = recordingPrefixHash(destination, end, metadataRanges);
    if (recordingPrefixHash(source, end, metadataRanges) !== sha256) throw new Error('Recording prefix changed during snapshot');
    return { bytes: end, sha256, lastTimestamp, metadataRanges };
}

/** Omit the recorder's embedded HTML preview and incomplete last XML element. */
export async function snapshotDanmaku(source: string, destination: string, duration: number): Promise<void> {
    const text = fs.readFileSync(source, 'utf8');
    const info = text.match(/<BililiveRecorderRecordInfo\b[^>]*\/>/u)?.[0];
    if (!info || !(duration > 0 && Number.isFinite(duration))) throw new Error('Missing snapshot recording metadata');
    const entries: string[] = [];
    for (const match of text.matchAll(/<(d|sc|gift|guard)\b[^>]*(?:\/>|>[\s\S]*?<\/\1>)/gu)) {
        const parsed = await parseStringPromise(match[0]), value = parsed[match[1]], attrs = value?.$ || {};
        const seconds = match[1] === 'd' ? Number(String(attrs.p).split(',')[0]) : Number(attrs.ts);
        // Non-danmaku ts is Unix time; preserve it as source evidence for the existing merger.
        if (match[1] !== 'd' || (Number.isFinite(seconds) && seconds >= 0 && seconds <= duration)) entries.push(match[0]);
    }
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<i>\n${info}\n${entries.join('\n')}\n</i>\n`;
    await parseStringPromise(xml);
    fs.writeFileSync(destination, xml, { encoding: 'utf8', flag: 'wx' });
}
