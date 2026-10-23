import * as fs from 'fs';
import { createHash } from 'crypto';
import { composeTimeline, parseSrt, projectCues, writeSrt } from './editorialStyle';
import type { Artifact } from './enhancement';

export const EDITORIAL_REVIEW_RULE = 'editorialTimeline中的highlight/body来自当前普通片；op是单独来源的鹿饼品牌片头，人物原话及录播时间见op.source，不能归给当前直播间或作为当前事件证据。按最终字幕和接缝抽帧检查前置是否误导、OP衔接、正文完整、重排后字幕同步；不要把有出处的OP字幕当作当前原片缺失台词。';

/** Validate the complete projected timeline and every immutable composing asset. */
export function editorialEvidenceDigest(artifact: Artifact): string | undefined {
    const t = artifact.editorialTimeline;
    if (!t) {
        if (artifact.style === 'highlight_first') throw new Error('Missing editorial timeline');
        return undefined;
    }
    const files = [t.baseline?.metadata, t.baseline?.media, t.baseline?.subtitles, t.opManifest, t.opMedia, t.opSubtitles];
    const keys = ['metadata', 'media', 'subtitles', 'opManifest', 'opMedia', 'opSubtitles'];
    const hashes = files.map((file: string, i: number) => {
        const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if (t.binding?.[keys[i]] !== actual) throw new Error('Editorial composing source changed');
        return actual;
    });
    const baseline = JSON.parse(fs.readFileSync(files[0], 'utf8').replace(/^\uFEFF/, ''));
    const op = JSON.parse(fs.readFileSync(files[3], 'utf8').replace(/^\uFEFF/, ''));
    if (op.mediaSha256 !== hashes[4] || op.srtSha256 !== hashes[5]
        || JSON.stringify(t.op) !== JSON.stringify({ id: op.id, source: op.source, subtitles: parseSrt(fs.readFileSync(files[5], 'utf8')) }))
        throw new Error('Editorial OP provenance changed');
    const cues = parseSrt(fs.readFileSync(files[2], 'utf8'));
    // End of the last body piece is the decoded baseline duration used during rendering.
    const body = t.pieces?.at(-1);
    const checked = composeTimeline(body?.end, op.duration, t.plan, cues);
    if (t.version !== 1 || body.kind !== 'body' || JSON.stringify(checked.pieces) !== JSON.stringify(t.pieces)
        || Math.abs(checked.duration - t.duration) > .05 || Math.abs(artifact.window.duration - checked.duration) > .05
        || baseline.window?.start !== artifact.window.start || baseline.window?.end !== artifact.window.end
        || writeSrt(projectCues(checked.pieces, cues, t.op.subtitles)) !== fs.readFileSync(artifact.output.srtPath, 'utf8'))
        throw new Error('Editorial timeline or projected subtitles changed');
    return createHash('sha256').update(hashes.join('\0')).digest('hex');
}
