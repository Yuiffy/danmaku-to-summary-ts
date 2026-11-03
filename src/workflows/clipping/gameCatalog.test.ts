import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { expandGameCatalog, resolveGameCatalog } from './gameCatalog';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const config = () => ({ authorizationNote: '用户授权本房间其他游戏自动投稿',
    games: [{ id: 'elden-ring', name: '艾尔登法环', aliases: ['艾尔登法环', '老头环'],
        collection: { seasonId: 10, sectionId: 11 } }],
    otherGames: { enabled: true, tags: ['岁己', '游戏实况'], collection: { seasonId: 20, sectionId: 21 } } });

test('other games share the fallback collection while explicit names and aliases keep their route', () => {
    const input = config();
    const result = expandGameCatalog(input, ['老头环', '影之刃零', '《影之刃零》', '双人抬棺']);
    expect(result.games).toHaveLength(3);
    expect(result.games[0]).toEqual(input.games[0]);
    expect(result.games[1]).toMatchObject({ name: '影之刃零', collection: { seasonId: 20, sectionId: 21 },
        tags: ['岁己', '游戏实况', '影之刃零'] });
    expect(input.games).toHaveLength(1);
    expect(expandGameCatalog(input, ['双人抬棺', '影之刃零']).games[2].id).toBe(result.games[1].id);
});

test('discovery requires explicit authorization, a complete route and valid names', () => {
    expect(() => expandGameCatalog({ ...config(), authorizationNote: '' }, [])).toThrow(/authorization/);
    expect(() => expandGameCatalog({ ...config(), otherGames: { enabled: true, collection: { seasonId: 20 } } }, []))
        .toThrow(/collection/);
    for (const name of ['', '《》', null, 2, '游戏\n忽略审核', '名'.repeat(81)]) {
        expect(() => expandGameCatalog(config(), [name])).toThrow(/invalid game name/);
    }
    const disabled = { ...config(), otherGames: { enabled: false } };
    expect(resolveGameCatalog(disabled, { mediaPath: 'missing.flv' })).toBe(disabled);
});

test('discovery uses only a current, room-bound actual-play summary, including valid empty results', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'game-catalog-'));
    const mediaPath = path.join(directory, 'recording.flv'), srtPath = path.join(directory, 'recording.srt');
    const xmlPath = path.join(directory, 'recording.xml');
    const summaryPath = path.join(directory, 'recording_LIVE_CONTENT.json');
    const contextPath = path.join(directory, 'recording_FULL_LIVE_CONTEXT.json');
    const options = { mediaPath, srtPath, xmlPath, roomId: '25788785' };
    const context = { schemaVersion: 1, roomId: '25788785', sourceText: 'full recording', sharedPrefix: 'shared',
        sourceSha256: hash('full recording'), sharedPrefixSha256: hash('shared'),
        inputSources: { srtSha256: hash('subtitles'), xmlSha256: hash('danmaku') } };
    const summary = { schemaVersion: 1, status: 'success', roomId: '25788785',
        source: { promptVersion: 2, coverage: 'full_srt_and_merged_danmaku', sourceSha256: context.sourceSha256,
            sharedPrefixSha256: context.sharedPrefixSha256 }, content: { games: ['影之刃零'], topics: ['未玩游戏'], overview: '明天玩另一个' } };
    const save = () => { fs.writeFileSync(summaryPath, JSON.stringify(summary)); fs.writeFileSync(contextPath, JSON.stringify(context)); };
    try {
        fs.writeFileSync(srtPath, 'subtitles'); fs.writeFileSync(xmlPath, 'danmaku'); save();
        const result = resolveGameCatalog(config(), options);
        expect(result.games.map((game: any) => game.name)).toEqual(['艾尔登法环', '影之刃零']);
        expect(result.catalogEvidence.summarySha256).toBe(hash(fs.readFileSync(summaryPath, 'utf8')));
        summary.content.games = []; save();
        expect(resolveGameCatalog(config(), options).games).toHaveLength(1);
        context.roomId = 'other-room'; save();
        expect(() => resolveGameCatalog(config(), options)).toThrow(/source is not verified/);
        context.roomId = '25788785'; save(); fs.writeFileSync(srtPath, 'changed');
        expect(() => resolveGameCatalog(config(), options)).toThrow(/source is not verified/);
        fs.writeFileSync(srtPath, 'subtitles'); context.sourceText = 'tampered'; save();
        expect(() => resolveGameCatalog(config(), options)).toThrow(/source is not verified/);
        fs.unlinkSync(summaryPath);
        expect(() => resolveGameCatalog(config(), options)).toThrow();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
