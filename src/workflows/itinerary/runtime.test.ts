import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { augmentDiscovery, collectEvidence, estimateSession, learnPlans, recallPlans, refreshDynamics, usageReport } from './runtime';

describe('bounded itinerary memory runtime', () => {
  let root: string;
  let config: any;
  let options: any;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'itinerary-'));
    config = { ai: { itineraryMemory: { enabled: true, scope: 'selected', streamerIds: ['sui', 'mofu'] }, streamerRegistry: {
      sui: { displayName: '岁己', roomIds: ['1'] }, mofu: { displayName: '犬绒', roomIds: ['2'] }
    } } };
    const srtPath = path.join(root, 'recording.srt'), xmlPath = path.join(root, 'recording.xml');
    fs.writeFileSync(srtPath, '1\n00:00:10,000 --> 00:00:15,000\n犬绒说：明天和岁己在上海见面\n\n2\n00:00:16,000 --> 00:00:20,000\n住酒店的计划还没有定\n');
    fs.writeFileSync(xmlPath, '<i><d p="11,1,25">明天犬绒和岁己见面？</d></i>');
    options = { root, config, srtPath, xmlPath, session: { roomId: '2', startedAt: '2026-10-18T20:00:00+08:00', sessionId: srtPath } };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const generate = () => jest.fn(async () => ({ text: JSON.stringify({ plans: [{ event: '上海会面', kind: 'meeting', participants: ['sui', 'mofu'],
    startDay: '2026-10-19', endDay: '2026-10-19', status: 'planned', location: '上海', citations: [{ id: 'T1', quote: '犬绒说：明天和岁己在上海见面' }] }] }),
    meta: { attempts: [{ status: 'success', promptTokens: 1500, completionTokens: 200, cachedTokens: 50 }] } }));

  it('learns once, accounts actual provider usage and supplies next-day cross-room acoustic candidates', async () => {
    const provider = generate();
    const first = await learnPlans(options, provider);
    expect(first.status).toBe('success');
    expect((await learnPlans(options, provider)).reused).toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);
    const target = { ...options, session: { roomId: '1', startedAt: '2026-10-19T20:00:00+08:00', sessionId: 'next.flv' } };
    const recalled = recallPlans(target);
    expect(recalled.candidateIds).toEqual(['mofu']);
    expect(recalled.prompt).toContain('不证明本场到场');
    const discovery = augmentDiscovery({ participants: [{ streamerId: 'sui' }], candidateStreamerIds: ['sui'], rosterStreamerIds: ['sui'],
      confirmedParticipantIds: [], plannedParticipantIds: [], mode: 'unknown', modeStatus: 'unknown' }, recalled, config);
    expect(discovery).toMatchObject({ rosterStreamerIds: ['sui', 'mofu'], plannedParticipantIds: [], confirmedParticipantIds: [], constrainToRoster: false });
    expect(discovery.participants[1]).toMatchObject({ presence: 'historical_plan_only', status: 'candidate', planned: false });
    expect(usageReport(options).receipts[0].generation.attempts[0].promptTokens).toBe(1500);
  });

  it('keeps failures visible and does not retry paid calls; disabled rooms never call the provider or create state', async () => {
    const failing = jest.fn(async () => { throw new Error('offline'); });
    expect((await learnPlans(options, failing)).status).toBe('failed');
    expect((await learnPlans(options, failing)).reused).toBe(true);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(recallPlans({ ...options, session: { ...options.session, startedAt: '2026-10-19T20:00:00+08:00' } }).plans).toEqual([]);
    config.ai.itineraryMemory.streamerIds = ['sui'];
    expect(await learnPlans(options, failing)).toEqual({ status: 'disabled' });
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('binds timestamps and source digests and estimates without making any provider call', async () => {
    const evidence = await collectEvidence(options);
    expect(evidence.rows[0]).toMatchObject({ id: 'T1', observedAt: '2026-10-18T12:00:10.000Z', offsetSeconds: 10 });
    expect(evidence.rows.find(r => r.kind === 'danmaku')?.text).toContain('犬绒');
    expect(Object.keys(evidence.inputs)).toHaveLength(2);
    expect((await estimateSession(options)).estimatedInputTokens).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
  });

  it('serializes concurrent learning and rejects files changed while the provider was processing', async () => {
    let release!: (value: any) => void;
    const provider = jest.fn(() => new Promise<any>(resolve => { release = resolve; }));
    const running = learnPlans(options, provider);
    // collectEvidence yields while parsing XML; wait for the actual provider invocation.
    while (!release) await new Promise(resolve => setImmediate(resolve));
    expect(await learnPlans(options, provider)).toEqual({ status: 'pending' });
    fs.appendFileSync(options.srtPath, '\nchanged');
    release(await generate()());
    expect(await running).toMatchObject({ status: 'failed', error: 'itinerary_source_changed', plans: [] });
  });

  it('refreshes cross-room dynamics even without subtitles and reuses unchanged publications across recording times', async () => {
    const provider = jest.fn(async () => ({ text: JSON.stringify({ plans: [{ event: '上海会面', kind: 'meeting', participants: ['sui', 'mofu'],
      startDay: '2026-10-19', endDay: '2026-10-19', status: 'planned', location: '上海',
      citations: [{ id: 'Ppost', quote: '犬绒明天和岁己在上海见面' }] }] }) }));
    const fetch = jest.fn(async (room: string) => ({ dynamics: room === '2'
      ? [{ id: 'post', content: '犬绒明天和岁己在上海见面', publishTime: '2026-10-18T10:00:00+08:00' }] : [] }));
    const target = { ...options, session: { roomId: '1', startedAt: '2026-10-19T18:00:00+08:00', sessionId: 'sui.flv' } };
    await refreshDynamics(target, { fetch, generate: provider });
    expect(recallPlans(target).candidateIds).toEqual(['mofu']);
    await refreshDynamics({ ...target, session: { ...target.session, startedAt: '2026-10-19T19:00:00+08:00' } }, { fetch, generate: provider });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]).toHaveLength(2);
    expect(usageReport(options).receipts).toHaveLength(1);
  });
});
