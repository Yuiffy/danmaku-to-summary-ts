export {};
const { precisionDetail, labelCreativeCopy, publicationCopy } = require('./precision_copy');

function fixture() {
    return { copy: { title: '【小岁】驾驶反转', description: '原有内容与来源', coverText: '驾驶反转' },
        creativeResult: { status: 'edited' }, qaResult: { status: 'passed' },
        creativePlan: { workflow: 'creative', duration: 30, music: { id: 'bgm' }, timeline: { removedSeconds: 5 },
            effects: [{ start: 5, end: 9, faceInset: {}, sound: { id: 'sitcom_laugh', offsetSeconds: 3 } },
                { start: 20, end: 22, zoom: { target: 'detail' }, faceInset: { mode: 'retain' } },
                { start: 29, end: 30, sticker: { id: 'question' }, sound: { id: 'ding' } }] },
        audioQa: { status: 'passed', effects: [{ id: 'sitcom_laugh', start: 8, end: 10.6 }] } };
}

test('discloses rendered effects on the final timeline including sound offsets and full music coverage', () => {
    const metadata = fixture();
    const copy = publicationCopy(metadata);
    expect(copy.title).toBe('【小岁】驾驶反转（AI精切）');
    expect(copy.description).toContain('原有内容与来源');
    expect(copy.description).toContain('删减 5 秒，成片 30 秒');
    expect(copy.description).toContain('00:00.00-00:30.00 添加 BGM');
    expect(copy.description).toContain('00:05.00-00:09.00 头像放大（圆窗）');
    expect(copy.description).toContain('00:08.00-00:10.60 后期罐头笑声');
    expect(copy.description).toContain('00:20.00-00:22.00 画面细节放大、原大小人脸保留窗');
    expect(copy.description).toContain('00:29.00-00:29.25 后期提示音效');
    expect(publicationCopy(metadata, copy)).toEqual(copy);
});

test('removes obsolete generated disclosures after actual music and sound removal', () => {
    const original = fixture();
    const copy = publicationCopy(original);
    const { music, ...plan } = original.creativePlan;
    const repaired = { ...original, creativePlan: { ...plan, effects: [{ start: 5, end: 9, zoom: { target: 'avatar' } }] } };
    const updated = publicationCopy(repaired, copy);
    expect(updated.description).not.toContain('添加 BGM');
    expect(updated.description).not.toContain('后期罐头笑声');
    expect(updated.description).toContain('头像放大');
    expect(updated.description.match(/【AI精切说明】/g)).toHaveLength(1);
});

test('refuses fallback, failed audio, missing plans, invented timing and overflow', () => {
    const metadata = fixture();
    for (const change of [{ creativeResult: { status: 'kept_original' } }, { qaResult: { status: 'failed' } },
        { audioQa: { status: 'failed' } }, { creativePlan: null }]) {
        expect(() => publicationCopy({ ...metadata, ...change })).toThrow();
    }
    expect(() => publicationCopy(metadata, { title: '长'.repeat(80), description: '' })).toThrow(/80-character/);
    expect(() => publicationCopy(metadata, { title: '标题', description: '长'.repeat(2000) })).toThrow(/2000-character/);
    const unknown = { ...metadata, audioQa: null, creativePlan: { ...metadata.creativePlan,
        effects: [{ start: 29, end: 30, sound: { id: 'new_laugh' } }] } };
    expect(() => precisionDetail(unknown)).toThrow(/timing/);
    const labeled = labelCreativeCopy(metadata.copy, unknown, { new_laugh: { sampleSeconds: 3, family: 'laughter' } });
    expect(labeled.description).toContain('00:29.00-00:30.00 后期罐头笑声');
});
