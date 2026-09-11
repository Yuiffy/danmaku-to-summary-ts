import { assignExperiment, buildExperimentSelection, parseExperimentSelection, labelExperimentDescription,
    PRECISION_EXPERIMENT_NAME, PRECISION_EXPERIMENT_MARKER, experimentDetailMarkdown } from './experiment';
import { createHash } from 'crypto';

const clips = Array.from({ length: 20 }, (_, i) => ({ start: i * 100, end: i * 100 + 80, title: `Story ${i}` }));
const speech = clips.map(clip => ({ start: clip.start, end: clip.end, text: `${clip.title}: setup, correction, ending` }));
const settings = { ratio: 0.25, maxClips: 5 };
const copyHash = (copy: any) => createHash('sha256').update(['title', 'coverText', 'description']
    .map(key => String(copy[key] || '')).join('\0')).digest('hex');

test('a fully attribution-reviewed batch still offers its passed clips for precision selection', () => {
    const reviewed = Array.from({ length: 23 }, (_, i) => {
        const clip = { start: i * 100, end: i * 100 + 80, title: `Story ${i}`, coverText: 'Story', description: 'Complete story',
            attributionRequired: true, publicCopyPending: i >= 14 };
        return { ...clip, attributionReview: { version: 1, status: i < 14 ? 'passed' : 'needs_review',
            copyDigest: copyHash(clip), start: clip.start, end: clip.end, sourceSha256: 'source-v1' } };
    });
    const packet = (buildExperimentSelection as any)(reviewed, reviewed.map(clip => ({ ...clip, text: 'Complete source story' })), settings, 'source-v1');
    expect(packet.eligibleIds).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(packet.maxSelected).toBe(5);
    for (const changed of [{ title: 'Changed copy' }, { end: 90 }, { attributionReview: { ...reviewed[0].attributionReview, sourceSha256: 'stale' } }]) {
        const invalid = (buildExperimentSelection as any)([{ ...reviewed[0], ...changed }], speech, settings, 'source-v1');
        expect(invalid.eligibleIds).toEqual([]);
    }
});

test.each(['no_eligible_candidates', 'batch_below_minimum', 'selection_failed', 'model_selected_none'])(
    'zero selection explicitly reports %s without inventing a model decision', reason => {
        const detail = experimentDetailMarkdown([], { precisionExperiment: { total: 23, selected: [], reason,
            status: reason === 'selection_failed' ? 'selection_failed_control' : 'ordinary_control',
            excludedCounts: { attribution_not_passed: 9 }, error: reason === 'selection_failed' ? 'upstream timeout' : undefined } });
        expect(detail).toContain('本批精切 0 条');
        if (reason === 'selection_failed') expect(detail).toContain('upstream timeout');
    });

test('a batch of twenty lets AI choose five, leaving the other fifteen unchanged', () => {
    const packet = buildExperimentSelection(clips, speech, settings);
    expect(packet.maxSelected).toBe(5);
    speech.forEach(row => expect(packet.prompt).toContain(row.text));
    const choices = parseExperimentSelection(JSON.stringify({ selected: [2, 4, 6, 8, 10].map(id => ({ id, reason: 'Clear contrast' })) }), packet);
    const assigned = assignExperiment(clips, packet, choices, 'ledger-1');
    expect(assigned.filter(clip => clip.precisionExperiment.selected)).toHaveLength(5);
    assigned.forEach((clip, index) => {
        const { precisionExperiment, ...original } = clip;
        expect(original).toEqual(clips[index]);
        expect(precisionExperiment.selectionLedgerId).toBe('ledger-1');
    });
    expect(parseExperimentSelection('{"selected":[]}', packet)).toEqual([]);
});

test('invalid, duplicate, pending or oversized AI choices cannot enable an experiment', () => {
    const packet = buildExperimentSelection(clips.map((clip, index) => ({ ...clip,
        publicCopyPending: index === 0, attributionRequired: index === 1 })), speech, settings);
    for (const ids of [[1], [2], [21], [3, 3], [3, 4, 5, 6, 7, 8]]) {
        expect(() => parseExperimentSelection(JSON.stringify({ selected: ids.map(id => ({ id, reason: 'test' })) }), packet)).toThrow();
    }
    expect(buildExperimentSelection(clips.slice(0, 3), speech, settings).maxSelected).toBe(0);
    expect(buildExperimentSelection(clips, speech, { ratio: 0.5, maxClips: 3 }).maxSelected).toBe(3);
});

test('public disclosure is deterministic and does not claim a deletion when timing was retained', () => {
    const description = labelExperimentDescription('Story', true, false);
    expect(description).toContain(PRECISION_EXPERIMENT_MARKER);
    expect(labelExperimentDescription(description, true, false)).toBe(description);
    expect(labelExperimentDescription('Story', false, true)).toBe('Story');
    expect(labelExperimentDescription(description, true, true).split(PRECISION_EXPERIMENT_MARKER)).toHaveLength(2);
});

test('detail messages use the same sparse upload IDs and report usage separately', () => {
    const results = assignExperiment(clips.slice(0, 2), buildExperimentSelection(clips, speech, settings), [{ id: 2, reason: 'Contrast' }])
        .map(clip => ({ ...clip, copy: { title: clip.title }, enhancement: { removedSeconds: 4.5,
            generationLogs: [{ stage: 'qa', status: 'success', usage: { input_tokens: 100, output_tokens: 50 }, elapsedMs: 1234 }] } }));
    const detail = experimentDetailMarkdown(results, { uploadRegistry: { clipIdsByReviewIndex: { 2: 1234 } } });
    expect(detail).toContain(PRECISION_EXPERIMENT_NAME);
    expect(detail).toContain('2. ID1234');
    expect(detail).toContain('4.50s');
    expect(detail).toContain('input=100');
    expect(detail).toContain('CNY=unknown');
});
