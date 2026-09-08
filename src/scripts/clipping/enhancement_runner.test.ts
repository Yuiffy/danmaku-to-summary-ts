export {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const { enhancementEnabled, runEnhancements, selectExperimentBatch } = require('./enhancement_runner');

test('enhancements require both an explicit switch and a matching room', async () => {
    const metadata = { copy: { title: 'Existing' } };
    expect(enhancementEnabled({ enabled: true, roomIds: [] }, 'room')).toBe(false);
    expect(enhancementEnabled({ enabled: false, roomIds: ['room'] }, 'room')).toBe(false);
    expect(await runEnhancements(metadata, { config: {}, info: { roomId: 'room' } })).toBe(metadata);
});

test('ordinary controls do not run per-clip enhancement or require an AI review', async () => {
    const metadata = { uploadReady: true, precisionExperiment: { selected: false } };
    expect(await runEnhancements(metadata, { config: { enhancements: { enabled: true, roomIds: ['room'],
        experiment: { enabled: true } } }, info: { roomId: 'room' } })).toBe(metadata);
});

test('one model request assigns the experiment and persists its usage without rendering controls', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'precision-selection-'));
    const generator = require('../ai_text_generator');
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({
        text: JSON.stringify({ selected: [1, 2, 3, 4, 5].map(id => ({ id, reason: 'Clear improvement' })) }),
        meta: { usage: { input_tokens: 100, output_tokens: 40 }, attempts: [
            { provider: 'daiYu', model: 'fixture', apiModeUsed: 'responses', reasoningEffortSent: 'high' }
        ] }
    });
    const clips = Array.from({ length: 20 }, (_, i) => ({ start: i * 100, end: i * 100 + 60, title: 'Story' }));
    const parsed = { segments: clips.map(clip => ({ ...clip, text: 'Setup and ending' })) };
    const config = { ai: { enabled: true }, enhancements: { enabled: true, roomIds: ['room'],
        experiment: { enabled: true, ratio: 0.25, maxClips: 5 },
        budget: { mode: 'log_only', ledgerPath: path.join(directory, 'ledger.json') },
        stageDefaults: { provider: 'daiYu', model: 'fixture', apiMode: 'responses', reasoningEffort: 'high',
            maxTokens: 1000, maxInputTokens: 50000, timeoutMs: 1000, capabilities: { reasoningEfforts: ['high'], images: false } } } };
    try {
        const info = { roomId: 'room', sessionId: 'session', selectionCacheDirectory: path.join(directory, 'cache') };
        const result = await selectExperimentBatch(clips, parsed, config, {}, info);
        expect(result.clips.filter(clip => clip.precisionExperiment.selected)).toHaveLength(5);
        expect(result.summary.selectionLog.usage.input_tokens).toBe(100);
        expect((await selectExperimentBatch(clips, parsed, config, {}, info)).summary.selectionLog.cacheHit).toBe(true);
        expect(generate).toHaveBeenCalledTimes(1);
    } finally { generate.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('global no-AI configuration cannot be bypassed by enhancement stages', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'enhancement-disabled-'));
    const metadata = { uploadReady: true, output: { metadataPath: path.join(directory, 'clip.json') } };
    try {
        const result = await runEnhancements(metadata, { config: { ai: { enabled: false }, enhancements: { enabled: true, roomIds: ['room'] } },
            info: { roomId: 'room' } });
        expect(result.uploadReady).toBe(false);
        expect(result.qaResult).toMatchObject({ status: 'failed', error: 'AI is disabled; required QA cannot run' });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
