import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { loadEditingExperiment, runEditingPairs } from './editingSkillExperiment';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'editing-skill-test-')); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function fixture() {
    const save = (name: string, data: string) => { fs.writeFileSync(path.join(directory, name), data); return createHash('sha256').update(data).digest('hex'); };
    const evidence = { sourceDuration: 5, sourceCues: [{ id: 'C1', start: 0, end: 2, text: '发生了事情' }], protectedSpans: [], protectedCues: [] };
    const manifest = { version: 1 as const, repetitions: 2,
        stage: { provider: 'daiYu' as const, model: 'fixture', apiMode: 'responses' as const, reasoningEffort: 'high',
            maxTokens: 1000, maxInputTokens: 20000, timeoutMs: 1000, capabilities: { reasoningEfforts: ['high'], images: false } },
        samples: [{ id: 'case', roomId: 'room', sessionId: 'session', split: 'screening' as const,
            promptPath: 'prompt.txt', promptSha256: save('prompt.txt', 'Frozen original prompt'),
            evidencePath: 'evidence.json', evidenceSha256: save('evidence.json', JSON.stringify(evidence)),
            reference: { requiredBeats: [{ label: 'WITHHELD_LABEL', cueIds: ['C1'] }], redundantCueIds: [] } }] };
    save('manifest.json', JSON.stringify(manifest));
    return path.join(directory, 'manifest.json');
}

test('paired runs alternate order, reuse parameters and withhold reference labels', async () => {
    const { manifest, samples } = loadEditingExperiment(fixture());
    const prompts: string[] = [];
    const rows = await runEditingPairs(manifest, samples, { save: jest.fn(),
        generate: async prompt => { prompts.push(prompt); return { text: '{"keep":[{}]}' }; },
        validate: () => ({ profile: {}, timeline: { keep: [{ start: 0, end: 2 }] } }) });
    expect(rows.map(r => r.variant)).toEqual(['baseline', 'story_beats', 'story_beats', 'baseline']);
    expect(prompts[0]).toBe(prompts[3]);
    expect(prompts.every(p => !p.includes('WITHHELD_LABEL'))).toBe(true);
    expect(rows.every(r => r.metrics.completeBeatCount === 1)).toBe(true);
});

test('changed input is rejected before making requests', () => {
    const file = fixture(); fs.appendFileSync(path.join(directory, 'evidence.json'), ' ');
    expect(() => loadEditingExperiment(file)).toThrow('input changed');
});

test('invalid plans are recorded, provider failures stop without manufacturing paired success', async () => {
    const { manifest, samples } = loadEditingExperiment(fixture()), save = jest.fn();
    const generate = jest.fn().mockResolvedValueOnce({ text: '{"keep":[]}' }).mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(runEditingPairs(manifest, samples, { save, generate, validate: () => { throw new Error('missing protected cue'); } })).rejects.toThrow('provider unavailable');
    expect(generate).toHaveBeenCalledTimes(2);
    const rows = save.mock.calls.filter(c => c[0] === 'results').at(-1)![1];
    expect(rows.map((r: any) => r.status)).toEqual(['invalid_plan', 'request_failed']);
});
