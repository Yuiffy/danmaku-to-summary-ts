export {};
const fs = require('fs'), os = require('os'), path = require('path');
const { admitEarlyBatch, runEarlyCampaign } = require('./campaign_early.ts');
const coverage = require('../core/media/RecordingCoverage');
const configLoader = require('./config-loader');
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-early-runtime-')); });
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

function batch() {
    const videoPath = path.join(directory, '录制-1-20261023-190000-1-芙娅之魂.flv');
    const xmlPath = videoPath.replace('.flv', '.xml');
    fs.writeFileSync(videoPath, 'source'); fs.writeFileSync(xmlPath, '<i/>');
    fs.utimesSync(videoPath, new Date(0), new Date(0));
    return { campaignId: 'test', roomId: '1', day: '20261023', transitionAt: Date.now(),
        sources: [{ videoPath, xmlPath, startedAt: Date.parse('2026-10-23T19:00:00+08:00') }] };
}

test('manual, automatic and restarted admission share the same durable queue identity', () => {
    const input = batch(), ledger = path.join(directory, 'ledger'), payloads: any[] = [];
    const enqueue = (payload: any) => { payloads.push(payload); return { queued: true, reused: payloads.length > 1 }; };
    const first = admitEarlyBatch(input, enqueue, ledger), second = admitEarlyBatch(input, enqueue, ledger);
    expect(first.id).toBe(second.id); expect(payloads).toHaveLength(1);
    expect(second.status).toBe('already_reserved');
    expect(fs.readdirSync(ledger)).toEqual([`${first.id}.json`]);
    const overlapping = admitEarlyBatch({ ...input, campaignId: 'different' }, enqueue, ledger);
    expect(overlapping.status).toBe('already_reserved'); expect(payloads).toHaveLength(1);
});

test('queue-admission failure retains the same recoverable claim', () => {
    const input = batch(), ledger = path.join(directory, 'ledger');
    expect(() => admitEarlyBatch(input, () => { throw new Error('queue unavailable'); }, ledger)).toThrow('queue unavailable');
    const admitted = admitEarlyBatch(input, () => ({ queued: true }), ledger);
    expect(fs.readdirSync(ledger)).toEqual([`${admitted.id}.json`]);
});

test('early runtime uses only merged snapshot ASR and own clips; failed selection is not completed', async () => {
    const input = batch(), ledger = path.join(directory, 'ledger'); let payload: any;
    admitEarlyBatch(input, (value: any) => { payload = value; return {}; }, ledger);
    jest.spyOn(configLoader, 'getConfig').mockReturnValue({ ownStreamClips: { campaigns: [{ id: 'test', enabled: true, roomIds: ['1'], endsAt: '2100-01-01' }] } });
    const events: string[] = [];
    class Merger {
        async mergeVideos(_segments: any[], media: string) { events.push('merge'); fs.writeFileSync(media, 'snapshot'); }
        async getVideoDuration() { return 120; }
        async mergeXmlFiles(segments: any[], xml: string) {
            expect(segments[0].fileOpenTime.getTime()).toBe(0); events.push('xml'); fs.writeFileSync(xml, '<i/>');
        }
    }
    const processMedia = jest.fn(async (media: string) => { events.push('asr'); const srtPath = media.replace('.flv', '.srt'); fs.writeFileSync(srtPath, 'evidence'); return { srtPath }; });
    const generateOwn = jest.fn(async () => { events.push('own'); throw new Error('provider failed'); });
    const adapters = { FileMerger: Merger, processMedia, generateOwn };
    await expect(runEarlyCampaign(payload, adapters)).rejects.toThrow('provider failed');
    expect(JSON.parse(fs.readFileSync(payload.earlyCampaign.claimPath, 'utf8')).completedAt).toBeUndefined();
    generateOwn.mockImplementationOnce(async () => { events.push('own'); });
    await runEarlyCampaign(payload, adapters);
    expect(events).toEqual(['merge', 'xml', 'asr', 'own', 'asr', 'own']);
    expect(JSON.parse(fs.readFileSync(payload.earlyCampaign.claimPath, 'utf8')).completedAt).toBeTruthy();
    expect(coverage.readRecordingMap(payload.originalMediaPath).spans).toHaveLength(1);
});
