import { deferredSelectionRows, enrichSkippedRanking, preserveDeferredSelection, recoverRejectedPresentation, reviewDisplayRows, uniqueRejectedArtifacts, withReviewSource } from './reviewSelectionHistory';
import { deferredReviewLines } from './reviewDigest';

test('source-less progressive P13/P14 history collapses only against one identical source-bound decision', () => {
    const decisions = [13, 14].map(index => ({ index, candidateIndex: index + 10, selected: false,
        title: `话题${index}`, start: index * 100, end: index * 100 + 20, score: 78, reason: 'below_score' }));
    const first = { publication: { policy: { mode: 'curated' }, decisions } };
    const legacy = deferredSelectionRows(first);
    const metadata = { ...first, source: { mediaPath: 'stream.flv', srtPath: 'source.srt' },
        deferredSelectionHistory: { rows: legacy }, deferredResolutions: [{ selectionKey: legacy[0].selectionKey, clipId: 900 }] };
    const before = JSON.stringify(metadata);
    const rows = deferredSelectionRows(metadata);
    expect(rows).toHaveLength(2);
    expect(rows[0].selectionAliases).toContain(legacy[0].selectionKey);
    const text = deferredReviewLines(metadata).join('\n');
    expect(text.match(/- P13 \|/gu)).toHaveLength(1);
    expect(text.match(/- P14 \|/gu)).toHaveLength(1);
    expect(text).toContain('已补切ID900');
    const refreshed = { ...metadata, deferredSelectionHistory: { rows } };
    expect(deferredReviewLines(refreshed).join('\n')).toContain('已补切ID900');
    expect(deferredSelectionRows(refreshed)).toHaveLength(2);
    expect(JSON.stringify(metadata)).toBe(before);
    const different = { ...rows[0], selectionKey: 'other-source', sourceSrtPath: 'repaired.srt' };
    expect(deferredSelectionRows({ ...metadata, deferredSelectionHistory: { rows: [...legacy, different] } })).toHaveLength(4);
    const changed = { ...legacy[0], title: '同时间的不同看点', selectionKey: 'another-event' };
    expect(deferredSelectionRows({ ...metadata, deferredSelectionHistory: { rows: [changed] } })).toHaveLength(3);
});

test('progressive review obtains a unique source before preserving history without guessing across recordings', () => {
    const source = { mediaPath: 'stream.flv', srtPath: 'source.srt' };
    expect(withReviewSource({}, [{ source }]).source).toEqual(source);
    expect(withReviewSource({}, [{ source }, { source: { ...source, srtPath: 'other.srt' } }]).source).toBeUndefined();
    const existing = { source: { mediaPath: 'other.flv' } };
    expect(withReviewSource(existing, [{ source }])).toBe(existing);
    const metadata = { publication: { decisions: [{ index: 13, start: 100, end: 120, selected: false }] } };
    const saved = preserveDeferredSelection(null, withReviewSource(metadata, [{ source }]));
    expect(saved.deferredSelectionHistory.rows[0].selectionKey).not.toContain('P:::');
    expect(deferredSelectionRows(preserveDeferredSelection(saved, withReviewSource(metadata, [{ source }])))).toHaveLength(1);
});

test('repeated rejection artifacts collapse without hiding distinct records sharing a review index', () => {
    const first = { reviewIndex: 123, output: { metadataPath: 'D:\\clips\\rejected-a.json' } };
    const duplicate = { ...first, output: { metadataPath: 'd:/clips/rejected-a.json' } };
    const other = { reviewIndex: 123, output: { metadataPath: 'D:/clips/rejected-b.json' } };
    expect(uniqueRejectedArtifacts([first, duplicate, other])).toEqual([first, other]);
    expect(uniqueRejectedArtifacts([{}, {}])).toHaveLength(2);
});

test('a timing revision retains old skipped topics without inheriting old QA or publication authority', () => {
    const previous = { source: { mediaPath: 'stream.flv', srtPath: 'old.srt' },
        aiStatus: { ranking: { sourceSha256: 'old', skipped: [{ candidateIndex: 8, start: 100, end: 140, title: '没找到奶茶', score: 65, reason: '看点偏弱' }] } },
        automaticPublication: { enabled: true }, publicationReview: { status: 'passed' } };
    const current = { source: { mediaPath: 'stream.flv', srtPath: 'aligned.srt' }, aiStatus: { validation: {} },
        publicationReview: { status: 'needs_review' } };
    const before = JSON.stringify([previous, current]);
    const result = preserveDeferredSelection(previous, current);
    expect(result.aiStatus).toEqual(current.aiStatus);
    expect(result.publicationReview).toEqual(current.publicationReview);
    expect(result.automaticPublication).toBeUndefined();
    expect(result.deferredSelectionHistory.rows).toHaveLength(1);
    expect(deferredReviewLines(result).join('\n')).toContain('R8 | 原窗口1:40–2:20（待校准） | 65分 | 没找到奶茶');
    expect(preserveDeferredSelection(result, current).deferredSelectionHistory.rows).toHaveLength(1);
    expect(JSON.stringify([previous, current])).toBe(before);
    expect(preserveDeferredSelection(previous, { ...current, source: { mediaPath: 'other.flv' } }).deferredSelectionHistory).toBeUndefined();
});

test('already made low-score candidates retain their score, original decision and upload ID in the list', () => {
    const data = { source: { mediaPath: 'stream.flv', srtPath: 'aligned.srt' },
        publication: { policy: { mode: 'curated' }, decisions: [{ index: 3, selected: false, start: 100, end: 150,
            title: '洗手像玩泡泡', score: 79, reason: 'below_score' }] }, uploadRegistry: { clipIdsByReviewIndex: { 7: 3099 } } };
    const results = [{ reviewIndex: 7, source: data.source, window: { start: 99, end: 151 }, output: { burnedSubtitles: true } }];
    const text = deferredReviewLines(preserveDeferredSelection(null, data), results).join('\n');
    expect(text).toContain('P3 | 1:40–2:30 | 79分 | 洗手像玩泡泡 | 低于分数线 | 已补切ID3099');
    expect(text.match(/P3 \|/gu)).toHaveLength(1);
    expect(data.publication.decisions[0].selected).toBe(false);
    expect(deferredReviewLines(data, [{ ...results[0], rebuildRequired: true }]).join('\n')).not.toContain('已补切ID');
});

test('legacy nameless rejections gain recall context only for display; approval and exact windows stay unchanged', () => {
    const rejection = { candidateIndex: 12, reason: 'topic_boundary_incomplete', issues: ['收尾不完整'] };
    const candidates = [{ index: 12, event: '突然想变白，研究身体乳和防晒窗膜', start: 800, end: 960,
        grounding: { subtitles: [{ id: 'G8', start: 820, end: 824, text: '我昨天晚上突然想白一点' }] } }];
    const presentation = recoverRejectedPresentation(rejection, candidates);
    const row = { copy: { title: '被剔除候选 12' }, window: { index: 999, start: null, end: null },
        reviewPresentation: presentation, selectionRejection: rejection, publicCopyPending: true, uploadReady: false,
        output: { metadataPath: 'held.json' } };
    const before = JSON.stringify(row), [display] = reviewDisplayRows([row]);
    expect(display.copy.title).toBe(candidates[0].event);
    expect(display.window).toMatchObject({ index: 999, start: 800, end: 960 });
    expect(presentation.windowAuthority).toBe('recall_context');
    expect(presentation.recallSubtitles).toEqual([{ id: 'G8', text: '我昨天晚上突然想白一点' }]);
    expect(display.selectionRejection).toBe(rejection);
    expect(display.uploadReady).toBe(false);
    expect(display.publicCopyPending).toBe(true);
    expect(display.ownStreamHumanReview).toBeUndefined();
    expect(JSON.stringify(row)).toBe(before);
    expect(reviewDisplayRows([{ ...row, output: { mediaPath: 'already.mp4' } }])[0].copy.title).toBe(row.copy.title);
    expect(enrichSkippedRanking({ skipped: [{ candidateIndex: 12, score: 60, title: '初选话题 12' }] }, candidates).skipped[0])
        .toMatchObject({ title: candidates[0].event, start: 800, end: 960, score: 60 });
});
