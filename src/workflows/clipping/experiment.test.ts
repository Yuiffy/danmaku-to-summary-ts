import { assignExperiment, buildExperimentSelection, parseExperimentSelection, labelExperimentDescription,
    PRECISION_EXPERIMENT_NAME, PRECISION_EXPERIMENT_MARKER, experimentDetailMarkdown } from './experiment';

const clips = Array.from({ length: 20 }, (_, i) => ({ start: i * 100, end: i * 100 + 80, title: `Story ${i}` }));
const speech = clips.map(clip => ({ start: clip.start, end: clip.end, text: `${clip.title}: setup, correction, ending` }));
const settings = { ratio: 0.25, maxClips: 5 };

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
