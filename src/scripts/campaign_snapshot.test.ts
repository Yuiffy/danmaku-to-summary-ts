export {};
const fs = require('fs'), os = require('os'), path = require('path');
const { triggerCampaignSnapshot } = require('./campaign_snapshot.ts');
const { filterCampaignCoverage } = require('../core/media/RecordingCoverage');
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-snapshot-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

function fixture() {
    const day = path.join(directory, '1_anchor', '2026_10_25'); fs.mkdirSync(day, { recursive: true });
    const video = path.join(day, '录制-1-20261025-140000-001-芙娅之魂.flv');
    const header = Buffer.from([70, 76, 86, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]);
    const tag = Buffer.alloc(16); tag[0] = 9; tag[3] = 1; tag.writeUInt32BE(12, 12);
    fs.writeFileSync(video, Buffer.concat([header, tag]));
    fs.writeFileSync(video.replace('.flv', '.xml'), '<i><BililiveRecorderRecordInfo roomid="1"/><d p="1,1">游戏</d>');
    const config = { storage: { basePath: directory }, ownStreamClips: { campaigns: [{ id: 'test', enabled: true, roomIds: ['1'],
        startsAt: '2026-10-22', endsAt: '2100-01-01', earlyTrigger: { enabled: true, titleKeywords: ['芙娅之魂'] } }] } };
    return { config, video, ledger: path.join(directory, 'ledger') };
}

test('explicit snapshot queues once while source grows and does not require title change or recorder control', async () => {
    const { config, video, ledger } = fixture(), queued: any[] = [];
    const adapters = { ledger, duration: async () => 60, enqueue: (p: any) => { queued.push(p); return { queued: true, jobId: 'one' }; } };
    const first = await triggerCampaignSnapshot(config, '1', '2026_10_25', '用户确认游戏结束', adapters);
    fs.appendFileSync(video, 'source keeps growing');
    const second = await triggerCampaignSnapshot(config, '1', '2026_10_25', '重复请求', adapters);
    expect(first.status).toBe('queued'); expect(second.status).toBe('already_reserved'); expect(second.id).toBe(first.id);
    expect(queued).toHaveLength(1); expect(queued[0].originalMediaPath).toContain(`${path.sep}2026_10_25${path.sep}campaign_early${path.sep}`);
    expect(filterCampaignCoverage([{ start: 1, end: 2 }, { start: 61, end: 62 }], video, ledger)).toEqual([{ start: 61, end: 62 }]);
    expect(fs.readFileSync(video).toString()).toContain('source keeps growing');
});

test('rejects missing confirmation, unauthorized room and changed snapshots; failed enqueue resumes same identity', async () => {
    const { config, ledger } = fixture(), adapters = { ledger, duration: async () => 60, enqueue: () => { throw new Error('queue unavailable'); } };
    await expect(triggerCampaignSnapshot(config, '1', '2026_10_25', '', adapters)).rejects.toThrow('note');
    await expect(triggerCampaignSnapshot(config, '2', '2026_10_25', 'yes', adapters)).rejects.toThrow('active campaign');
    await expect(triggerCampaignSnapshot(config, '1', '2026_10_25', 'yes', adapters)).rejects.toThrow('queue unavailable');
    const files = fs.readdirSync(ledger); expect(files).toHaveLength(1);
    const result = await triggerCampaignSnapshot(config, '1', '2026_10_25', 'retry', { ...adapters, enqueue: () => ({ queued: true }) });
    expect(result.id + '.json').toBe(files[0]);
});
