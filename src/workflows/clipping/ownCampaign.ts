import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

type Data = Record<string, any>;
type Decision = { allowed: boolean; reason: string; evidenceReady: boolean };
export interface CampaignSource {
    mediaPath?: string;
    srtPath?: string;
    xmlPath?: string;
    roomId?: string | number;
    context?: { roomId?: string | number };
    fullLiveContextPath?: string | null;
    liveContentSummaryPath?: string | null;
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const gameName = (value: string) => value.normalize('NFKC').replace(/[\s《》]/gu, '').toLowerCase();

// Only the summary's actual-play list is evidence; overview, topics and titles are not.
export function decideCampaignContent(requiredGames: string[], summary: Data, sourceMatches: boolean): Decision {
    if (!sourceMatches || summary.schemaVersion !== 1 || summary.status !== 'success'
        || summary.source?.promptVersion !== 2 || summary.source?.coverage !== 'full_srt_and_merged_danmaku'
        || !Array.isArray(summary.content?.games)) return { allowed: false, evidenceReady: false, reason: '缺少与当前字幕、弹幕匹配的实际游戏摘要' };
    const names = new Set(requiredGames.map(gameName));
    return summary.content.games.some((name: unknown) => typeof name === 'string' && names.has(gameName(name)))
        ? { allowed: true, evidenceReady: true, reason: '本场实际游玩活动游戏' }
        : { allowed: false, evidenceReady: true, reason: '本场未实际游玩活动游戏' };
}

export function checkCampaignContent(config: Data, options: CampaignSource): Decision {
    const gate = config.campaignContentGate;
    if (!gate) return { allowed: true, evidenceReady: true, reason: '日常选材' };
    if (!Array.isArray(gate.requiredGames) || !gate.requiredGames.length
        || gate.requiredGames.some((name: unknown) => typeof name !== 'string' || !name.trim())) {
        return { allowed: false, evidenceReady: true, reason: '活动游戏准入配置无效' };
    }
    try {
        const base = path.join(path.dirname(options.mediaPath || ''), path.parse(options.mediaPath || '').name);
        const summaryPath = options.liveContentSummaryPath || `${base}_LIVE_CONTENT.json`;
        const contextPath = options.fullLiveContextPath || summaryPath.replace(/_LIVE_CONTENT\.json$/iu, '_FULL_LIVE_CONTEXT.json');
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
        const inputs = context.inputSources;
        const room = String(options.roomId || options.context?.roomId || '');
        const matches = Boolean(room && String(summary.roomId) === room && String(context.roomId) === room
            && context.schemaVersion === 1 && typeof context.sourceText === 'string' && typeof context.sharedPrefix === 'string'
            && digest(context.sourceText) === context.sourceSha256 && digest(context.sharedPrefix) === context.sharedPrefixSha256
            && summary.source?.sourceSha256 === context.sourceSha256 && summary.source?.sharedPrefixSha256 === context.sharedPrefixSha256
            && options.srtPath && options.xmlPath && inputs
            && inputs.srtSha256 === digest(fs.readFileSync(options.srtPath))
            && inputs.xmlSha256 === digest(fs.readFileSync(options.xmlPath)));
        return decideCampaignContent(gate.requiredGames, summary, matches);
    } catch {
        return { allowed: false, evidenceReady: false, reason: '活动游戏摘要缺失、不可读或来源不完整' };
    }
}

/** Internal prerequisite only; it does not enable public summaries or publication. */
export function campaignSummaryExperiment(config: Data, existing: Data | null): Data | null {
    if (!config.enabled || !config.campaignContentGate) return null;
    return { ...(existing?.enabled === true ? existing : {}), enabled: true, compactEvidence: true, tasks: ['summary'] };
}

export async function ensureCampaignContent(config: Data, options: CampaignSource,
    io: { prepare: () => Promise<void> }): Promise<Decision> {
    const before = checkCampaignContent(config, options);
    if (before.evidenceReady) return before;
    await io.prepare();
    const after = checkCampaignContent(config, options);
    if (!after.evidenceReady) throw new Error(`活动游戏判断证据未就绪，保留任务供重试：${after.reason}`);
    return after;
}

export function admitCampaignContent(config: Data, options: CampaignSource): boolean {
    const decision = checkCampaignContent(config, options);
    if (!decision.allowed) console.log(`跳过活动有趣切片（${config.campaignContentGate?.id || 'campaign'}）：${decision.reason}；保留原关键词流程。`);
    return decision.allowed;
}

/** Verified recording context helps local review without claiming every window is gameplay. */
export function campaignReviewContext(config: Data, options: CampaignSource): Data | null {
    if (!config.campaignContentGate || !checkCampaignContent(config, options).allowed) return null;
    const base = path.join(path.dirname(options.mediaPath || ''), path.parse(options.mediaPath || '').name);
    const summary = JSON.parse(fs.readFileSync(options.liveContentSummaryPath || `${base}_LIVE_CONTENT.json`, 'utf8'));
    return { requiredGames: config.campaignContentGate.requiredGames, actualGames: summary.content.games,
        overview: summary.content.overview, coverage: 'verified_recording_context_only',
        sourceSha256: summary.source.sourceSha256 };
}
