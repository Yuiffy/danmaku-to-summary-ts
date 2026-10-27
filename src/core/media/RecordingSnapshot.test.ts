import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseStringPromise } from 'xml2js';
import { snapshotFlv, snapshotDanmaku } from './RecordingSnapshot';
import { recordingPrefixHash } from './RecordingCoverage';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-snapshot-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

function tag(payload: string, type = 9): Buffer {
    const body = Buffer.from(payload), header = Buffer.alloc(11), trailer = Buffer.alloc(4);
    header[0] = type; header.writeUIntBE(body.length, 1, 3); trailer.writeUInt32BE(11 + body.length);
    return Buffer.concat([header, body, trailer]);
}
const header = Buffer.from([70, 76, 86, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]);

test('snapshot excludes a partially written FLV tag without changing the growing source', () => {
    const source = path.join(directory, 'source.flv'), output = path.join(directory, 'copy.flv');
    const complete = Buffer.concat([header, tag('first frame')]), next = tag('second frame');
    const original = Buffer.concat([complete, next.subarray(0, 15)]);
    fs.writeFileSync(source, original);
    const receipt = snapshotFlv(source, output);
    expect(fs.readFileSync(output)).toEqual(complete);
    expect(fs.readFileSync(source)).toEqual(original);
    fs.appendFileSync(source, next.subarray(15));
    expect(recordingPrefixHash(source, receipt.bytes)).toBe(receipt.sha256);
    expect(() => snapshotFlv(source, output)).toThrow();
    fs.writeFileSync(source, 'truncated');
    expect(() => recordingPrefixHash(source, receipt.bytes)).toThrow('truncated');
});

test('corrupt complete tags fail instead of being silently removed', () => {
    const source = path.join(directory, 'bad.flv'), data = Buffer.concat([header, tag('bad')]);
    data[data.length - 1] = 0; fs.writeFileSync(source, data);
    expect(() => snapshotFlv(source, path.join(directory, 'copy.flv'))).toThrow('trailer');
});

test('metadata index rewrites are allowed while every audio/video byte and tag header stays bound', () => {
    const source = path.join(directory, 'source.flv'), output = path.join(directory, 'copy.flv');
    fs.writeFileSync(source, Buffer.concat([header, tag('index-one', 18), tag('video frame')]));
    const receipt = snapshotFlv(source, output), changed = fs.readFileSync(source);
    changed.write('index-two', 24); fs.writeFileSync(source, changed);
    expect(recordingPrefixHash(source, receipt.bytes, receipt.metadataRanges)).toBe(receipt.sha256);
    changed[changed.length - 5] ^= 1; fs.writeFileSync(source, changed);
    expect(recordingPrefixHash(source, receipt.bytes, receipt.metadataRanges)).not.toBe(receipt.sha256);
    expect(() => recordingPrefixHash(source, receipt.bytes, [{ start: 48, length: 11 }])).toThrow('metadata');
});

test('XML snapshot closes complete evidence, omits preview markup and filters later danmaku', async () => {
    const source = path.join(directory, 'source.xml'), output = path.join(directory, 'copy.xml');
    fs.writeFileSync(source, '<i><BililiveRecorderRecordInfo roomid="1" start_time="2026-10-25T14:00:00+08:00" />'
        + '<BililiveRecorderXmlStyle><html><script>if(a<b){}</script></html></BililiveRecorderXmlStyle>'
        + '<d p="1,1">原话&amp;弹幕</d><d p="100,1">超出</d><sc ts="1792908002">留言</sc><d p="3,1">半条');
    await snapshotDanmaku(source, output, 20);
    const xml = fs.readFileSync(output, 'utf8'), parsed = await parseStringPromise(xml);
    expect(parsed.i.d).toHaveLength(1); expect(parsed.i.sc).toHaveLength(1);
    expect(xml).not.toMatch(/script|半条|超出/u);
});
