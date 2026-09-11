import { createHash } from 'crypto';
export interface JsonRepair { count: number; sourceSha256: string; repairedSha256: string }
/** Repairs only full-width JSON delimiters outside quoted strings. Never invents values or closes truncated output. */
export function parseModelJson(text: string, onRepair?: (repair: JsonRepair) => void): any {
    const value = String(text || '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
    try { return JSON.parse(value); } catch (originalError) {
        let quoted = false, escaped = false, count = 0;
        const repaired = [...value].map(character => {
            if (escaped) { escaped = false; return character; }
            if (quoted && character === '\\') { escaped = true; return character; }
            if (character === '"') { quoted = !quoted; return character; }
            if (!quoted && (character === '，' || character === '：')) { count++; return character === '，' ? ',' : ':'; }
            return character;
        }).join('');
        if (!count || quoted) throw originalError;
        const parsed = JSON.parse(repaired);
        const hash = (input: string) => createHash('sha256').update(input).digest('hex');
        const record = { count, sourceSha256: hash(value), repairedSha256: hash(repaired) };
        if (onRepair) onRepair(record); else console.warn(`[JSON_REPAIR] ${JSON.stringify(record)}`);
        return parsed;
    }
}
