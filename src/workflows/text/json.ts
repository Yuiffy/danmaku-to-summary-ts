import { createHash } from 'crypto';
export interface JsonRepair { count: number; sourceSha256: string; repairedSha256: string }

interface RepairedText { text: string; count: number; unterminatedString: boolean }

/**
 * Repairs only delimiters that sit outside quoted strings: full-width `，`/`：` and a
 * redundant comma directly before `}` or `]`. It never invents values, never closes
 * truncated output and never rewrites quoted content.
 */
function repairModelDelimiters(value: string): RepairedText {
    const characters = [...value];
    const output: string[] = [];
    let quoted = false, escaped = false, count = 0;
    for (let index = 0; index < characters.length; index += 1) {
        const character = characters[index];
        if (escaped) { escaped = false; output.push(character); continue; }
        if (quoted && character === '\\') { escaped = true; output.push(character); continue; }
        if (character === '"') { quoted = !quoted; output.push(character); continue; }
        if (quoted) { output.push(character); continue; }
        const delimiter = character === '，' ? ',' : character === '：' ? ':' : character;
        if (delimiter !== character) count += 1;
        if (delimiter === ',') {
            let next = index + 1;
            while (next < characters.length && /\s/u.test(characters[next])) next += 1;
            // A comma before a closer carries no value; dropping it keeps every member intact.
            if (characters[next] === '}' || characters[next] === ']') { count += 1; continue; }
        }
        output.push(delimiter);
    }
    return { text: output.join(''), count, unterminatedString: quoted };
}

export function parseModelJson(text: string, onRepair?: (repair: JsonRepair) => void): any {
    const value = String(text || '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
    try { return JSON.parse(value); } catch (originalError) {
        const repaired = repairModelDelimiters(value);
        if (!repaired.count || repaired.unterminatedString) throw originalError;
        const parsed = JSON.parse(repaired.text);
        const hash = (input: string) => createHash('sha256').update(input).digest('hex');
        const record = { count: repaired.count, sourceSha256: hash(value), repairedSha256: hash(repaired.text) };
        if (onRepair) onRepair(record); else console.warn(`[JSON_REPAIR] ${JSON.stringify(record)}`);
        return parsed;
    }
}
