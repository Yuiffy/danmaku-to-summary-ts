import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { checkCampaignContent, CampaignSource } from './ownCampaign';

type Data = Record<string, any>;
const normalize = (value: string) => value.normalize('NFKC').replace(/[\s《》]/gu, '').toLowerCase();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** A summary supplies candidate names only; full gameplay and media review still decide publication. */
export function expandGameCatalog(config: Data, names: unknown[]): Data {
    if (!config.otherGames?.enabled) return config;
    const fallback = config.otherGames;
    if (!String(config.authorizationNote || '').trim()
        || !['seasonId', 'sectionId'].every(key => Number.isSafeInteger(fallback.collection?.[key]) && fallback.collection[key] > 0)) {
        throw new Error('Other games need explicit authorization and a complete collection route');
    }
    const games = config.games.map((game: Data) => ({ ...game }));
    for (const value of names) {
        if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\r\n]/u.test(value)) {
            throw new Error('Recording summary contains an invalid game name');
        }
        const name = value.trim().replace(/^《(.*)》$/u, '$1');
        if (!normalize(name)) throw new Error('Recording summary contains an invalid game name');
        if (games.some((game: Data) => [game.name, ...game.aliases].some(alias => normalize(alias) === normalize(name)))) continue;
        games.push({ id: `game-${digest(normalize(name)).slice(0, 16)}`, name, aliases: [name],
            tid: fallback.tid || 17, tags: [...new Set([...(fallback.tags || []), name])],
            collection: { ...fallback.collection } });
    }
    return { ...config, games };
}

export function resolveGameCatalog(config: Data, options: CampaignSource & { summaryPath?: string | null }): Data {
    if (!config.otherGames?.enabled) return config;
    const base = path.join(path.dirname(options.mediaPath || ''), path.parse(options.mediaPath || '').name);
    const summaryPath = options.summaryPath || options.liveContentSummaryPath || `${base}_LIVE_CONTENT.json`;
    const text = fs.readFileSync(summaryPath, 'utf8');
    const summary = JSON.parse(text);
    if (!Array.isArray(summary.content?.games)) throw new Error('Other game discovery needs the recording actual-play summary');
    const expanded = expandGameCatalog(config, summary.content.games);
    const decision = checkCampaignContent({ campaignContentGate: { requiredGames: expanded.games.map((game: Data) => game.name) } },
        { ...options, liveContentSummaryPath: summaryPath });
    if (!decision.evidenceReady) throw new Error(`Other game discovery source is not verified: ${decision.reason}`);
    return { ...expanded, catalogEvidence: { summaryPath, summarySha256: digest(text),
        sourceSha256: summary.source.sourceSha256, games: summary.content.games } };
}
