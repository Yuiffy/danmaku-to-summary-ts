import { applyEditorialChoices, chooseOpManifest, parseStyleChoices, StyleCandidate } from './editorialSelection';

test('OP pool uses equal intervals and preserves explicit legacy manifests', () => {
    const settings = { opManifest: 'legacy.json', opManifests: ['sad.json', 'watch.json'] };
    for (const sample of [0, .25, .49999]) expect(chooseOpManifest(settings, () => sample)).toBe('sad.json');
    for (const sample of [.5, .75, .99999]) expect(chooseOpManifest(settings, () => sample)).toBe('watch.json');
    expect(chooseOpManifest({ opManifest: 'legacy.json' })).toBe('legacy.json');
    expect(chooseOpManifest({})).toBe('public/branding/shikamochi/OP.json');
    expect(chooseOpManifest({ opManifests: ['single.json'] }, () => .9)).toBe('single.json');
    for (const pool of [[], [''], ['a', 'a']]) expect(() => chooseOpManifest({ opManifests: pool })).toThrow(/opManifests/);
    for (const sample of [-1, 1, NaN]) expect(() => chooseOpManifest(settings, () => sample)).toThrow(/sample/);
});
const candidate: StyleCandidate = { id: 1, title: '完整对话', duration: 30,
    subtitles: [{ start: 0, end: 3, text: '起因' }, { start: 8, end: 11, text: '看点' }],
    binding: { baselineMediaSha256: 'original-media' } };
const plan = { version: 1, highlights: [{ start: 8, end: 11 }], reason: '完整反应', repetition: 'auto' };
function fixture() {
    const artifact: Record<string, any> = { uploadReady: true, window: { start: 100, end: 130, duration: 30 },
        output: { burnedSubtitles: true }, aiReview: { status: 'ready' } };
    const io = { candidate: jest.fn(async () => candidate),
        request: jest.fn(async () => JSON.stringify({ choices: [{ id: 1, style: 'highlight_first', reason: '反应强', plan }] })),
        highlight: jest.fn(async (row, p) => ({ ...row, editorialTimeline: { plan: p }, qaRequired: true, qaResult: { status: 'pending' } })),
        precision: jest.fn(async row => ({ ...row, creativeResult: { status: 'edited' } })), save: jest.fn(async () => {}) };
    return { artifact, io };
}
test('auto routes a valid hook with pre-request bindings and requires fresh QA', async () => {
    const f = fixture();
    const [result] = await applyEditorialChoices([f.artifact], { enabled: true, mode: 'auto' }, f.io);
    expect(result).toMatchObject({ style: 'highlight_first', qaRequired: true, qaResult: { status: 'pending' },
        editorialStyle: { selected: 'highlight_first', status: 'completed' },
        editorialTimeline: { plan: { baselineMediaSha256: 'original-media' } } });
    expect(f.io.precision).not.toHaveBeenCalled();
    expect(f.io.request.mock.calls[0][0]).toContain('不要强行凑齐三种');
});
test.each(['ordinary', 'precision'] as const)('fixed %s bypasses mode classification', async mode => {
    const f = fixture();
    const [result] = await applyEditorialChoices([f.artifact], { enabled: true, mode }, f.io);
    expect(result.style).toBe(mode); expect(f.io.request).not.toHaveBeenCalled();
    expect(f.io.precision).toHaveBeenCalledTimes(mode === 'precision' ? 1 : 0);
});
test.each(['provider', 'split-sentence', 'render', 'precision-fallback'])('%s retains the ordinary artifact with an honest failure', async kind => {
    const f = fixture();
    if (kind === 'provider') f.io.request.mockRejectedValue(new Error('unavailable'));
    if (kind === 'split-sentence') f.io.request.mockResolvedValue(JSON.stringify({ choices: [{ id: 1, style: 'highlight_first', reason: 'hook',
        plan: { ...plan, highlights: [{ start: 9, end: 11 }] } }] }));
    if (kind === 'render') f.io.highlight.mockRejectedValue(new Error('encoder'));
    if (kind === 'precision-fallback') f.io.precision.mockImplementation(async row => ({ ...row, creativeResult: { status: 'kept_original', reason: 'QA failed' } }));
    const [result] = await applyEditorialChoices([f.artifact], { enabled: true, mode: kind === 'precision-fallback' ? 'precision' : 'auto' }, f.io);
    expect(result).toMatchObject({ style: 'ordinary', window: f.artifact.window, editorialStyle: { status: 'kept_original' } });
    expect(result.editorialStyle.failure).toBeTruthy();
    expect(f.artifact.editorialStyle).toBeUndefined();
});
test.each(['off', 'held', 'failed', 'public-copy'])('%s never starts style work', async kind => {
    const f = fixture();
    if (kind === 'held') f.artifact.preRenderHold = true;
    if (kind === 'failed') f.artifact.output.mediaError = 'failed';
    if (kind === 'public-copy') f.artifact.publicCopyPending = true;
    const result = await applyEditorialChoices([f.artifact], { enabled: kind !== 'off' }, f.io);
    expect(result[0]).toBe(f.artifact); expect(f.io.request).not.toHaveBeenCalled(); expect(f.io.save).not.toHaveBeenCalled();
});
test('duplicate IDs, missing assignments and forced-mode contradictions are rejected', () => {
    expect(() => parseStyleChoices('{"choices":[]}', [candidate])).toThrow();
    const row = { id: 1, style: 'ordinary', reason: '紧凑' };
    expect(() => parseStyleChoices(JSON.stringify({ choices: [row, row] }), [candidate, { ...candidate, id: 2 }])).toThrow();
    expect(() => parseStyleChoices(JSON.stringify({ choices: [row] }), [candidate], 'precision')).toThrow();
});
