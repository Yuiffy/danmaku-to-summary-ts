import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { timingSearchWindow, prepareOwnTimingRecovery, retainTimingRecoveryIds, retainUnrecoveredTimingRows, prepareRenderedTimingRevision } from './ownTimingRecovery';

test('a bound transcript invalidates old approvals and cannot inherit the burned video as reviewed', () => {
    const original = { mediaPath: 'source.flv', srtPath: 'source.srt', srtSha256: 'old' };
    const transcript = { mode: 'repaired_source_audio', originalSrtPath: 'source.srt', originalSrtSha256: 'old', path: 'aligned.srt' };
    const old = { uploadId: 7, source: { ...original, xmlPath: 'source.xml' },
        output: { mediaPath: 'old.mp4' }, window: { start: 10, end: 20 }, attributionRequired: true,
        qaRequired: true, uploadReady: true, ownStreamHumanReview: { status: 'approved' },
        attributionReview: { status: 'passed' }, publicationReview: { status: 'passed' },
        publicationDecision: { action: 'auto_queue' },
        creativeResult: { reason: 'source_window_incomplete: old cue IDs' },
        sourceExpansionRequest: { oldCue: 'G10' }, editPlan: { removed: [{ start: 10, end: 15 }] } };
    const revised = prepareRenderedTimingRevision(old, transcript, original, '用户确认原音串题');
    expect(revised.creativeResult).toBeUndefined();
    expect(revised.sourceExpansionRequest).toBeUndefined();
    expect(revised.editPlan).toBeUndefined();
    expect(revised).toMatchObject({ uploadId: 7, attributionRequired: true, qaRequired: true,
        source: { srtPath: 'aligned.srt', xmlPath: 'source.xml' }, rebuildRequired: true, uploadReady: false });
    expect(revised.ownStreamHumanReview).toBeUndefined();
    expect(revised.attributionReview).toBeUndefined(); expect(revised.publicationReview).toBeUndefined();
    expect(revised.renderedTimingRepair.originalOutput.mediaPath).toBe('old.mp4');
    expect(old.publicationReview.status).toBe('passed');
    expect(() => prepareRenderedTimingRevision(old, { ...transcript, originalSrtSha256: 'changed' }, original, '修复')).toThrow('bound');
    expect(() => prepareRenderedTimingRevision({ ...old, renderedSubtitles: { edits: [{}] } }, transcript, original, '修复')).toThrow('corrections');
});

test('unique source words propose a corrected search window across changed cue splits', () => {
    const original = [{ start: 100, end: 104, text: '我刚刚睡醒以为现在还是半夜' }, { start: 104, end: 110, text: '看到手机才知道现在是晚上八点' }];
    const corrected = [{ start: 140, end: 142, text: '我刚刚睡醒以为' }, { start: 142, end: 145, text: '现在还是半夜' },
        { start: 145, end: 151, text: '看到手机才知道现在是晚上八点' }, { start: 180, end: 200, text: '下一话题' }];
    expect(timingSearchWindow({ start: 100, end: 110 }, original, corrected)).toMatchObject({ start: 111, end: 200, authority: 'unverified_search_window' });
    const repeated = [...corrected, ...corrected.map(cue => ({ ...cue, start: cue.start+200, end: cue.end+200 }))];
    expect(timingSearchWindow({ start: 100, end: 110 }, original, repeated)).toBeNull();
    expect(timingSearchWindow({ start: 0, end: 10 }, [{ start: 0, end: 4, text: '完全不同的文字无法定位' }], corrected)).toBeNull();
});

test('recovery preserves numeric identities, old media and held siblings and refuses an active ID', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'own-timing-recovery-'));
    try {
        const source = { mediaPath: path.join(directory,'source.flv'), srtPath: path.join(directory,'source.srt') };
        const row = { reviewIndex: 8, source, window: { start: 100, end: 120, index: 8 }, copy: { title: '原话题', description: '原看点' },
            output: { metadataPath: path.join(directory,'clip.json'), mediaPath: path.join(directory,'old.mp4') } };
        fs.writeFileSync(row.output.mediaPath,'old video'); fs.writeFileSync(row.output.metadataPath,JSON.stringify(row));
        fs.writeFileSync(path.join(directory,'PLAN.json'),JSON.stringify({ source }));
        fs.writeFileSync(path.join(directory,'REVIEW_STATE.json'),JSON.stringify({ entries: [{ metadataPath: row.output.metadataPath }] }));
        const registry = { clips: { 3102: { id: 3102, status: 'needs_review', metadataPath: row.output.metadataPath,
            attributionRequired: true, qaRequired: true } } };
        const original = [{ start: 102, end: 115, text: '这是足够长而且唯一的一句话用于定位原话题' }];
        const corrected = [{ start: 202, end: 215, text: original[0].text }, { start: 300, end: 400, text: '结尾' }];
        const recovery = prepareOwnTimingRecovery(directory,source,original,corrected,registry,'修复已证实的字幕漂移');
        const clips = retainTimingRecoveryIds([{ candidateIndex: 8, start: 200, end: 220 }],recovery);
        expect(clips[0].timingRecovery.metadataPath).toBe(row.output.metadataPath);
        expect(clips[0].timingRecovery.reviewIndex).toBe(8);
        expect(clips[0]).toMatchObject({ attributionRequired: true, qaRequired: true });
        expect(clips[0].attributionReview).toBeUndefined();
        expect(clips[0].qaResult).toBeUndefined();
        expect(retainUnrecoveredTimingRows([],recovery)).toEqual([row]);
        expect(retainUnrecoveredTimingRows([{ ...row, repaired: true }],recovery)).toHaveLength(1);
        expect(fs.readFileSync(row.output.mediaPath,'utf8')).toBe('old video');
        registry.clips[3102].status='queued';
        expect(() => prepareOwnTimingRecovery(directory,source,original,corrected,registry,'修复')).toThrow('unpublished pending IDs');
    } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
