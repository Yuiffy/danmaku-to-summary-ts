import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { campaignSummaryExperiment, checkCampaignContent, decideCampaignContent, ensureCampaignContent, campaignReviewContext } from './ownCampaign';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const summary = (games: string[]) => ({ schemaVersion: 1, status: 'success', roomId: 'event',
    source: { promptVersion: 2, coverage: 'full_srt_and_merged_danmaku',
        sourceSha256: hash('source'), sharedPrefixSha256: hash('prefix') },
    content: { games, overview: '明天玩芙娅之魂，今天唱歌', topics: ['芙娅之魂'] } });
const config = { campaignContentGate: { id: 'fuya', requiredGames: ['芙娅之魂', '芙娅之魂巡礼测试'] } };

test.each([[], ['其他游戏'], ['明天玩芙娅之魂'], ['未玩芙娅之魂']].map(games => ({ games })))('mentions and unrelated games never admit a campaign ($games)', ({ games }) => {
    expect(decideCampaignContent(config.campaignContentGate.requiredGames, summary(games), true).allowed).toBe(false);
});
test.each(['芙娅之魂', '《芙娅之魂》', '芙娅之魂巡礼测试'])('actual gameplay accepts a configured game name (%s)', name => {
    expect(decideCampaignContent(config.campaignContentGate.requiredGames, summary([name]), true).allowed).toBe(true);
});
test('unknown, failed and stale summaries do not start selection', () => {
    const games = config.campaignContentGate.requiredGames;
    expect(decideCampaignContent(games, summary(games), false).allowed).toBe(false);
    expect(decideCampaignContent(games, { ...summary(games), status: 'failed' }, true).allowed).toBe(false);
    expect(decideCampaignContent(games, { ...summary(games), content: {} }, true).allowed).toBe(false);
});
test('ordinary highlights need no campaign evidence', () => {
    expect(checkCampaignContent({}, {}).allowed).toBe(true);
});

test('missing campaign evidence differs from a completed non-game decision', () => {
    expect(checkCampaignContent(config, {})).toMatchObject({ allowed: false, evidenceReady: false });
    expect(decideCampaignContent(config.campaignContentGate.requiredGames, summary([]), true))
        .toMatchObject({ allowed: false, evidenceReady: true });
});

test('active campaign preparation needs no room summary opt-in and grants no public tasks', () => {
    expect(campaignSummaryExperiment({ ...config, enabled: true }, null))
        .toEqual({ enabled: true, compactEvidence: true, tasks: ['summary'] });
    expect(campaignSummaryExperiment({ ...config, enabled: true }, { enabled: true, model: 'existing', tasks: ['goodnight', 'comic'] }))
        .toMatchObject({ model: 'existing', tasks: ['summary'] });
    expect(campaignSummaryExperiment({ ...config, enabled: false }, null)).toBeNull();
    expect(campaignSummaryExperiment({ enabled: true }, null)).toBeNull();
});

test('unavailable or failed evidence cannot be marked completed by the background task', async () => {
    const prepare = jest.fn().mockResolvedValue(undefined);
    await expect(ensureCampaignContent(config, {}, { prepare })).rejects.toThrow('判断证据未就绪');
    expect(prepare).toHaveBeenCalledTimes(1);
    prepare.mockClear();
    await expect(ensureCampaignContent({}, {}, { prepare })).resolves.toMatchObject({ allowed: true });
    expect(prepare).not.toHaveBeenCalled();
});

test('sidecar admission checks the current source, room and hashes without model calls', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-campaign-'));
    const mediaPath = path.join(dir, 'recording.flv'), srtPath = path.join(dir, 'recording.speaker.srt');
    const xmlPath = path.join(dir, 'recording.xml');
    const summaryPath = path.join(dir, 'recording_LIVE_CONTENT.json');
    const contextPath = path.join(dir, 'recording_FULL_LIVE_CONTEXT.json');
    const options = { mediaPath, srtPath, xmlPath, roomId: 'event' };
    const content = summary(['芙娅之魂']);
    const context = { schemaVersion: 1, roomId: 'event', sourceText: 'source', sharedPrefix: 'prefix',
        sourceSha256: hash('source'), sharedPrefixSha256: hash('prefix'),
        inputSources: { srtSha256: hash('subtitles'), xmlSha256: hash('danmaku') } };
    const save = () => {
        fs.writeFileSync(summaryPath, JSON.stringify(content));
        fs.writeFileSync(contextPath, JSON.stringify(context));
    };
    try {
        expect(checkCampaignContent(config, options).allowed).toBe(false);
        fs.writeFileSync(srtPath, 'subtitles'); fs.writeFileSync(xmlPath, 'danmaku'); save();
        expect(checkCampaignContent(config, options).allowed).toBe(true);
        expect(campaignReviewContext(config, options)).toMatchObject({ actualGames: ['芙娅之魂'], coverage: 'verified_recording_context_only' });
        expect(checkCampaignContent(config, { ...options, roomId: 'other' }).allowed).toBe(false);
        fs.writeFileSync(srtPath, 'changed');
        expect(checkCampaignContent(config, options).allowed).toBe(false);
        expect(campaignReviewContext(config, options)).toBeNull();
        fs.writeFileSync(srtPath, 'subtitles'); fs.writeFileSync(xmlPath, 'changed');
        expect(checkCampaignContent(config, options).allowed).toBe(false);
        fs.writeFileSync(xmlPath, 'danmaku');
        context.sourceText = 'tampered'; save();
        expect(checkCampaignContent(config, options).allowed).toBe(false);
        context.sourceText = 'source'; context.sharedPrefix = 'tampered'; save();
        expect(checkCampaignContent(config, options).allowed).toBe(false);
        context.sharedPrefix = 'prefix'; content.source.sourceSha256 = hash('another recording'); save();
        expect(checkCampaignContent(config, options).allowed).toBe(false);
        content.source.sourceSha256 = hash('source'); content.content.games = []; save();
        expect(checkCampaignContent(config, options)).toMatchObject({ allowed: false, reason: '本场未实际游玩活动游戏' });
        fs.writeFileSync(summaryPath, '{');
        expect(checkCampaignContent(config, options).allowed).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the direct producer skips non-game campaigns before touching media, candidates or review artifacts', async () => {
    const own = require('../../scripts/own_stream_clipper');
    const results = await own.generateOwnStreamClips({
        config: { ownStreamClips: { enabled: true, campaigns: [{ id: 'fuya', enabled: true, roomIds: ['30655190'],
            startsAt: '2026-01-01T00:00:00+08:00', endsAt: '2100-01-01T00:00:00+08:00', requiredGames: ['芙娅之魂'] }] } },
        mediaPath: 'missing/录制-30655190-20261022-150338-452-学歌.flv', srtPath: 'missing/source.srt', context: { roomId: '30655190' }
    });
    expect(results).toEqual([]);
});
