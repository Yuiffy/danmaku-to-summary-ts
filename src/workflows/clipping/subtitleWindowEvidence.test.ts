import { projectRetainedSubtitleEvidence, projectRenderedSubtitleEvidence } from './subtitleWindowEvidence';

test('actor evidence uses rendered corrections while preserving original groups, voice and source identity', () => {
    const original = fixture(), before = JSON.stringify(original.cues);
    const artifact: any = { window: { start: 10, end: 18 }, renderedSubtitles: { version: 1,
        revision: 2, renderedRevision: 2, sha256: 'bound', renderedSha256: 'bound', sourceSha256: original.sourceSha256,
        window: { start: 10, end: 18 }, cues: [{ start: 3, end: 5, text: '蚊子停在麦克风' }], edits: [
            { authority: 'user', changes: [{ start: 13, end: 15, before: '蚊子趴上麦克风', after: '蚊子停在麦克风' }] }
        ] } };
    const projected = projectRenderedSubtitleEvidence(original, artifact);
    expect(projected.sourceSha256).toBe(original.sourceSha256);
    expect(projected.cues[0].id).toBe('G8');
    expect(projected.cues[0].text).toContain('蚊子停在麦克风');
    expect(projected.cues[0].items[1].speakerEvidence).toBe(original.cues[0].items[1].speakerEvidence);
    expect(JSON.stringify(original.cues)).toBe(before);
    const change = artifact.renderedSubtitles.edits[0].changes[0];
    for (const patch of [
        { renderedRevision: 1 }, { sourceSha256: 'changed' }, { renderedSha256: 'changed' },
        { cues: [{ start: 3, end: 5, text: '未经渲染的另一句话' }] },
        { edits: [{ authority: 'user', changes: [{ ...change, before: '不是原话' }] }] },
        { edits: [{ authority: 'user', changes: [{ ...change, start: 14 }] }] }
    ]) expect(() => projectRenderedSubtitleEvidence(original, { ...artifact,
        renderedSubtitles: { ...artifact.renderedSubtitles, ...patch } })).toThrow();
});

function fixture() {
    const items = [
        { index: 7, start: 10, end: 12, text: '前一个家庭话题', speakerEvidence: { status: 'unknown' } },
        { index: 8, start: 13, end: 15, text: '蚊子趴上麦克风', speakerEvidence: { status: 'row_supported', label: 'Host' } },
        { index: 9, start: 16, end: 18, text: '我打死了它', speakerEvidence: { status: 'row_supported', label: 'Host' } }
    ];
    const cue = { id: 'G8', start: 10, end: 18, text: items.map(row => row.text).join(' '), items };
    return { sourceSha256: 'unchanged-original-source', cues: [cue], byId: new Map([['G8', cue]]) };
}

test('fully retained original rows remain citable when their old group also contains excluded context', () => {
    const original = fixture(), before = JSON.stringify(original.cues);
    const projected = projectRetainedSubtitleEvidence(original, { start: 13, end: 18 });
    expect(projected.sourceSha256).toBe(original.sourceSha256);
    expect(projected.cues.map(cue => [cue.id, cue.text])).toEqual([['G8', '前一个家庭话题'], ['G9', '蚊子趴上麦克风 我打死了它']]);
    expect(projected.byId.get('G9')!.items[0].speakerEvidence).toEqual({ status: 'row_supported', label: 'Host' });
    expect(projected.cues.filter(cue => cue.start >= 13 && cue.end <= 18).map(cue => cue.id)).toEqual(['G9']);
    expect(JSON.stringify(original.cues)).toBe(before);
});

test('a partly retained ASR row cannot be cropped into a complete claim or borrow its voice identity', () => {
    const projected = projectRetainedSubtitleEvidence(fixture(), { start: 14, end: 18 });
    expect(projected.cues.filter(cue => cue.start >= 14 && cue.end <= 18).map(cue => cue.text)).toEqual(['我打死了它']);
    expect(projected.byId.get('G8')!.text).toContain('蚊子趴上麦克风');
    expect(projected.byId.get('G8')!.start).toBe(10);
});

test('whole groups, incompatible legacy identities and repeated projection keep original bindings', () => {
    const original = fixture();
    expect(projectRetainedSubtitleEvidence(original, { start: 10, end: 18 })).toBe(original);
    const projected = projectRetainedSubtitleEvidence(original, { start: 13, end: 18 });
    expect(projectRetainedSubtitleEvidence(projected, { start: 13, end: 18 })).toBe(projected);
    original.cues[0].id = 'R1';
    expect(projectRetainedSubtitleEvidence(original, { start: 13, end: 18 })).toBe(original);
});
