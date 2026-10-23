import { parseCampaignRecording, selectEarlyBatches, CampaignTrigger, RecordingCandidate } from './CampaignEarlyPolicy';

const now = Date.parse('2026-10-23T23:50:00+08:00');
const campaign: CampaignTrigger = { id: 'test', enabled: true, roomIds: ['1'], startsAt: '2026-10-22T00:00:00+08:00',
    endsAt: '2026-11-06T00:00:00+08:00', earlyTrigger: { enabled: true, titleKeywords: ['芙娅之魂', '我魂'], activatedAt: '2026-10-23T20:00:00+08:00' } };
const row = (title: string, hour: number, patch: Partial<RecordingCandidate> = {}): RecordingCandidate => ({
    videoPath: `${title}-${hour}.flv`, xmlPath: `${hour}.xml`, roomId: '1', day: '20261023', title,
    startedAt: Date.parse(`2026-10-23T${hour}:00:00+08:00`), modifiedAt: now - 120000,
    size: 100, xmlExists: true, ...patch });

test('collects reconnect segments as one batch only once a different-title recording starts', () => {
    const sources = [row('玩芙娅之魂', 19), row('我魂！', 21)];
    expect(selectEarlyBatches([campaign], sources, now)).toEqual([]);
    const batches = selectEarlyBatches([campaign], [...sources, row('看会', 22)], now);
    expect(batches).toHaveLength(1); expect(batches[0].sources).toEqual(sources);
});

test('rejects active or incomplete files even with a later title', () => {
    for (const patch of [{ modifiedAt: now }, { xmlExists: false }, { size: 0 }]) {
        expect(selectEarlyBatches([campaign], [row('芙娅之魂', 19, patch), row('看会', 22)], now)).toEqual([]);
    }
});

test('startup does not backfill old title switches; explicit manual trigger can', () => {
    const rows = [row('芙娅之魂', 17), row('杂谈', 18)];
    expect(selectEarlyBatches([campaign], rows, now)).toEqual([]);
    expect(selectEarlyBatches([campaign], rows, now, '1')).toHaveLength(1);
    expect(selectEarlyBatches([campaign], rows, now, '2')).toEqual([]);
    expect(selectEarlyBatches([campaign], rows, Date.parse('2026-11-07'), '1')).toEqual([]);
});

test('later gameplay after a different title forms a separate batch', () => {
    const rows = [row('芙娅之魂', 19), row('聊天', 20), row('我魂', 21), row('看会', 22)];
    expect(selectEarlyBatches([campaign], rows, now, '1').map(batch => batch.sources.length)).toEqual([1, 1]);
});

test('parses Shanghai dates and ignores generated merged recordings', () => {
    const name = '录制-25034104-20261023-193826-538-玩会芙娅之魂0.0.flv';
    expect(parseCampaignRecording(name, name)).toMatchObject({ roomId: '25034104', day: '20261023', title: '玩会芙娅之魂0.0',
        startedAt: Date.parse('2026-10-23T19:38:26+08:00') });
    expect(parseCampaignRecording(name, name.replace('.flv', '_merged.flv'))).toBeNull();
});
