import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordingIdentity, writeRecordingMap, filterCampaignCoverage, readRecordingMap, atomicRecordingJson, reserveFinalCampaign } from './RecordingCoverage';
import { recordingPrefixHash } from './RecordingCoverage';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-coverage-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

test('final stream dedup uses measured source offsets and retains later gameplay', async () => {
    const source = path.join(directory, 'part.flv'), later = path.join(directory, 'later.flv');
    const merged = path.join(directory, '录制-1-20261023-190000-1-game_merged.flv');
    fs.writeFileSync(source, 'a'); fs.writeFileSync(later, 'b'); fs.writeFileSync(merged, 'ab');
    const ledger = path.join(directory, 'ledger');
    atomicRecordingJson(path.join(ledger, 'claim.json'), { roomId: '1', day: '20261023', mediaPath: path.join(directory, 'early.flv'),
        sources: [{ identity: recordingIdentity(source) }] });
    await writeRecordingMap([source, later], merged, async file => file === merged ? 205 : 100, () => 5);
    expect(filterCampaignCoverage([{ start: 0, end: 30 }, { start: 90, end: 110 }, { start: 105, end: 120 }], merged, ledger))
        .toEqual([{ start: 105, end: 120 }]);
    fs.mkdirSync(path.join(directory, 'bak')); const moved = path.join(directory, 'bak', 'part.flv');
    const identity = recordingIdentity(source); fs.renameSync(source, moved);
    expect(recordingIdentity(moved)).toBe(identity);
    fs.appendFileSync(merged, 'changed'); expect(() => readRecordingMap(merged)).toThrow('changed');
});

test('own early snapshot is allowed, unknown merged source timeline fails closed', () => {
    const media = path.join(directory, '录制-1-20261023-190000-1-game_merged.flv'), ledger = path.join(directory, 'ledger');
    fs.writeFileSync(media, 'media'); const clips = [{ start: 1, end: 2 }];
    atomicRecordingJson(path.join(ledger, 'claim.json'), { roomId: '1', day: '20261023', mediaPath: media, sources: [] });
    expect(filterCampaignCoverage(clips, media, ledger)).toEqual(clips);
    atomicRecordingJson(path.join(ledger, 'claim.json'), { roomId: '1', day: '20261023', mediaPath: 'other.flv', sources: [] });
    expect(() => filterCampaignCoverage(clips, media, ledger)).toThrow('时间轴');
});

test('does not write misleading map when the concat duration differs', async () => {
    const media = path.join(directory, 'part.flv'), output = path.join(directory, 'output.flv');
    fs.writeFileSync(media, 'a'); fs.writeFileSync(output, 'b');
    await expect(writeRecordingMap([media], output, async file => file === output ? 150 : 100, () => 0)).rejects.toThrow('differs');
    expect(fs.existsSync(`${output}.sources.json`)).toBe(false);
});

test('normal finalization reserves only uncovered sources so early and later game jobs can both finish', async () => {
    const early = path.join(directory, '录制-1-20261023-190000-1-game.flv');
    const later = path.join(directory, 'later.flv'), full = path.join(directory, '录制-1-20261023-190000-1-game_merged.flv');
    const ledger = path.join(directory, 'ledger');
    for (const file of [early, later, full]) fs.writeFileSync(file, file);
    atomicRecordingJson(path.join(ledger, 'early.json'), { roomId: '1', day: '20261023', mediaPath: early,
        sources: [{ identity: recordingIdentity(early) }] });
    await writeRecordingMap([early, later], full, async file => file === full ? 200 : 100, () => 0);
    reserveFinalCampaign(full, 'test', ledger); reserveFinalCampaign(full, 'test', ledger);
    const final = fs.readdirSync(ledger).filter(file => file !== 'early.json');
    expect(final).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(ledger, final[0]), 'utf8')).sources.map((source: { identity: string }) => source.identity))
        .toEqual([recordingIdentity(later)]);
    expect(filterCampaignCoverage([{ start: 1, end: 2 }], early, ledger)).toEqual([{ start: 1, end: 2 }]);
    expect(filterCampaignCoverage([{ start: 1, end: 2 }, { start: 101, end: 102 }], full, ledger)).toEqual([{ start: 101, end: 102 }]);
});

test('growing-file snapshot reserves only verified prefix time through final merging and bak moves', async () => {
    const source = path.join(directory, 'source.flv'), earlier = path.join(directory, 'earlier.flv');
    const full = path.join(directory, '录制-1-20261023-190000-1-game_merged.flv'), ledger = path.join(directory, 'ledger');
    fs.writeFileSync(source, 'prefix'); fs.writeFileSync(earlier, 'earlier'); fs.writeFileSync(full, 'merged');
    const prefix = { originalPath: source, bytes: 6, sha256: recordingPrefixHash(source, 6), duration: 30 };
    atomicRecordingJson(path.join(ledger, 'snapshot.json'), { roomId: '1', day: '20261023', mediaPath: 'snapshot.flv', sources: [], prefixReservations: [prefix] });
    fs.appendFileSync(source, 'later gameplay');
    await writeRecordingMap([earlier, source], full, async file => file === full ? 205 : 100, () => 5);
    const clips = [{ start: 1, end: 5 }, { start: 105, end: 120 }, { start: 134, end: 140 }, { start: 135, end: 150 }];
    expect(filterCampaignCoverage(clips, full, ledger)).toEqual([clips[0], clips[3]]);
    fs.mkdirSync(path.join(directory, 'bak')); fs.renameSync(source, path.join(directory, 'bak', 'source.flv'));
    expect(filterCampaignCoverage(clips, full, ledger)).toEqual([clips[0], clips[3]]);
    fs.writeFileSync(path.join(directory, 'bak', 'source.flv'), 'CHANGED later gameplay');
    expect(() => filterCampaignCoverage(clips, full, ledger)).toThrow('prefix');
});
