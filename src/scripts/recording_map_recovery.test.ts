import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRecordingMap, RecordingMapRecoveryIO } from './recording_map_recovery';
import { readRecordingMap, filterCampaignCoverage, atomicRecordingJson, recordingIdentity } from '../core/media/RecordingCoverage';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-recovery-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
    const first = '录制-1-20261024-190000-1-game.flv', later = 'later.flv';
    fs.mkdirSync(path.join(root, 'bak'));
    const source = path.join(root, 'bak', first), second = path.join(root, 'bak', later);
    const media = path.join(root, first.replace('.flv', '_merged.flv'));
    for (const file of [source, second, media]) { fs.writeFileSync(file, file); fs.utimesSync(file, 1, 1); }
    const text = `开始合并XML文件: 2 个片段\n处理片段: ${first.replace('.flv', '.xml')}, 偏移量: 100000ms\n处理片段: later.xml, 偏移量: 205000ms\nXML合并完成: ${path.basename(media).replace('.flv', '.xml')}`;
    const sourcePackets = (file: string, tail: boolean) => [0, 1, 2, 3, 4, 5].map(i => ({ pts: i / 30 + (tail ? 99 : 0), hash: `${file}-${tail}-${i}` }));
    const io: RecordingMapRecoveryIO = {
        logs: jest.fn(() => [{ file: 'merge.log', text }]),
        duration: jest.fn(async file => file === media ? 205 : 100),
        packets: jest.fn(async (file, interval) => {
            if (file !== media) return sourcePackets(file, interval !== '%+#6');
            const start = Number(interval.split('%')[0]), secondPart = start >= 100;
            return sourcePackets(secondPart ? second : source, start > (secondPart ? 110 : 10))
                .map(p => ({ ...p, pts: p.pts + (secondPart ? 105 : 0) }));
        })
    };
    return { source, media, io };
}

test('repairs moved originals once, and retains prior early publication coverage', async () => {
    const { source, media, io } = fixture();
    await ensureRecordingMap(media, io);
    expect(readRecordingMap(media)?.spans.map(p => p.start)).toEqual([0, 105]);
    const ledger = path.join(root, 'ledger');
    atomicRecordingJson(path.join(ledger, 'early.json'), { roomId: '1', day: '20261024', mediaPath: 'early.flv', sources: [{ identity: recordingIdentity(source) }] });
    expect(filterCampaignCoverage([{ start: 1, end: 2 }, { start: 106, end: 107 }], media, ledger)).toEqual([{ start: 106, end: 107 }]);
    await ensureRecordingMap(media, io);
    expect(io.logs).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(source, 'utf8')).toBe(source);
});

test.each(['missing-log', 'wrong-packets', 'changed-source', 'invalid-map'])('never writes guessed source coverage: %s', async failure => {
    const { source, media, io } = fixture();
    if (failure === 'missing-log') io.logs = () => [];
    if (failure === 'wrong-packets') io.packets = async () => [];
    if (failure === 'changed-source') {
        const original = io.duration;
        io.duration = async file => { const result = await original(file); if (file === media) fs.appendFileSync(source, 'changed'); return result; };
    }
    if (failure === 'invalid-map') fs.writeFileSync(`${media}.sources.json`, JSON.stringify({ version: 0 }));
    await expect(ensureRecordingMap(media, io)).rejects.toThrow();
    if (failure !== 'invalid-map') expect(fs.existsSync(`${media}.sources.json`)).toBe(false);
});
