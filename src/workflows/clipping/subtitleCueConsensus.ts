import { normalizedSpeech } from './ownSubtitleRepair';

type Data = Record<string, any>;
const filler = (char: string) => /^[嗯啊呃哎]$/u.test(char);

/** Align a complete cue to one unique transcript span. Only fillers may be inserted/deleted. */
function alignCue(source: string, transcript: string): string[] | null {
    const leading = source.match(/^[嗯啊呃哎]+/u)?.[0] || '', trailing = source.match(/[嗯啊呃哎]+$/u)?.[0] || '';
    if (leading || trailing) {
        const core = source.slice(leading.length, source.length - trailing.length);
        const aligned = alignCue(core, transcript);
        return aligned ? [...leading, ...aligned, ...trailing] : null;
    }
    const n = source.length, m = transcript.length;
    if (n < 5 || n > 80 || m > 2000) return null;
    const cells = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => ({ cost: Infinity, maps: [] as string[] })));
    for (let j = 0; j <= m; j++) cells[0][j] = { cost: 0, maps: [''] };
    for (let i = 1; i <= n; i++) for (let j = 0; j <= m; j++) {
        const options: { cost: number; maps: string[] }[] = [];
        if (j) options.push({ cost: cells[i - 1][j - 1].cost + Number(source[i - 1] !== transcript[j - 1]),
            maps: cells[i - 1][j - 1].maps.map(map => map + transcript[j - 1]) });
        if (filler(source[i - 1])) options.push({ cost: cells[i - 1][j].cost + 1,
            maps: cells[i - 1][j].maps.map(map => map + source[i - 1]) });
        if (j && filler(transcript[j - 1])) options.push({ cost: cells[i][j - 1].cost + 1, maps: cells[i][j - 1].maps });
        const cost = Math.min(...options.map(option => option.cost));
        cells[i][j] = { cost, maps: [...new Set(options.filter(option => option.cost === cost).flatMap(option => option.maps))].slice(0, 2) };
    }
    const best = Math.min(...cells[n].map(cell => cell.cost)), ends = cells[n].filter(cell => cell.cost === best);
    if (best > 4 || ends.length !== 1 || ends[0].maps.length !== 1) return null;
    const mapped = ends[0].maps[0].split('');
    const content = [...source].filter(char => !filler(char)).length;
    const matches = [...source].filter((char, index) => !filler(char) && char === mapped[index]).length;
    return matches >= Math.max(3, Math.ceil(content * .6)) ? mapped : null;
}

/** Repeated words are disambiguated by the complete cue; disputed letters and fillers stay unchanged. */
export function consensusCueEdit(probe: Data, row: Data, protectedNames: string[] = []): Data | null {
    const source = typeof probe.quote === 'string' && probe.quote.length >= 5 && probe.original?.includes(probe.quote)
        && probe.original.indexOf(probe.quote) === probe.original.lastIndexOf(probe.quote) ? probe.quote : probe.original;
    if (typeof source !== 'string' || !/^[\u3400-\u9fff]+$/u.test(source)
        || row.id !== probe.id || row.start !== probe.start || row.end !== probe.end || row.decodes?.length !== 2
        || new Set(row.decodes.map((decode: Data) => decode.model)).size !== 2
        || row.decodes.some((decode: Data) => decode.prompted !== false || decode.hotwords?.length || decode.useItn !== false
            || typeof decode.text !== 'string')) return null;
    const maps = row.decodes.map((decode: Data) => alignCue(source, normalizedSpeech(decode.text)));
    if (maps.some((map: string[] | null) => !map)) return null;
    const quotedIndices = new Set<number>();
    for (let at = 0; typeof probe.quote === 'string' && (at = source.indexOf(probe.quote, at)) >= 0; at++) {
        for (let offset = 0; offset < probe.quote.length; offset++) quotedIndices.add(at + offset);
    }
    const replacement = [...source].map((char, index) => (!probe.quote || quotedIndices.has(index)) && !filler(char) && maps[0][index] === maps[1][index]
        ? maps[0][index] : char).join('');
    const differences = [...source].flatMap((char, index) => char === replacement[index] ? [] : [char, replacement[index]]);
    if (!differences.length || differences.length > 8
        || differences.some(char => !/^[\u3400-\u9fff]$/u.test(char) || /[0-9零〇一二三四五六七八九十百千万两不没无否别勿他她它你我爸妈姐哥弟妹]/u.test(char))
        || protectedNames.some(name => source.includes(normalizedSpeech(name)) || replacement.includes(normalizedSpeech(name)))) return null;
    return { index: probe.index, from: source, to: replacement, confirmed: true, audioId: probe.id };
}
