import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

interface Group { index: string | number; start: number; end: number; matchSegments: Array<{ start: number; end: number }> }
interface Source { mediaPath: string; selectionCacheDirectory?: string }
interface IO { capture(time: number, file: string): Promise<unknown> }

/** At most three source frames, near anchors; no whole-stream scan or extra model round. */
export async function prepareCompetitionEvidence(source: Source, group: Group, io: IO) {
    const anchors = group.matchSegments.map(hit => (hit.start + hit.end) / 2);
    const times = [...new Set([anchors[0], anchors[Math.floor(anchors.length / 2)], anchors.at(-1)]
        .filter((time): time is number => typeof time === 'number' && Number.isFinite(time) && time >= group.start && time <= group.end))];
    const directory = path.join(source.selectionCacheDirectory || path.join(path.dirname(source.mediaPath), 'temp', 'topic_selection'),
        'competition', createHash('sha256').update(String(group.index)).digest('hex').slice(0, 16));
    const frames: Array<{ id: string; time: number; sha256: string }> = [], images: string[] = [], issues: string[] = [];
    fs.mkdirSync(directory, { recursive: true });
    for (const time of times) {
        const file = path.join(directory, `${time.toFixed(3)}.jpg`);
        try {
            await io.capture(time, file);
            const bytes = fs.readFileSync(file);
            if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.length > 4 * 1024 * 1024) throw new Error('Invalid competition frame');
            frames.push({ id: `F${frames.length + 1}`, time, sha256: createHash('sha256').update(bytes).digest('hex') });
            images.push(`data:image/jpeg;base64,${bytes.toString('base64')}`);
        } catch (error) { issues.push(`frame ${time}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { frames, images, issues };
}
