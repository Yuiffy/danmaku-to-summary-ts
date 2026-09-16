export {};
const fs = require('fs'), os = require('os'), path = require('path');
const { createIncrementalRender } = require('./incremental_render');
test('a failed render remains a held record and does not discard the rest of the batch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-failure-'));
    const source = { mediaPath: path.join(dir, 'source.mp4'), srtPath: path.join(dir, 'source.srt') };
    fs.writeFileSync(source.mediaPath, 'source'); fs.writeFileSync(source.srtPath, 'source subtitles');
    const clips = [{ start: 0, end: 30 }, { start: 40, end: 70 }];
    try {
        const run = createIncrementalRender({ outputRoot: dir, source, config: {}, initialClips: clips,
            pipelineOptions: { mediaConcurrency: 1, enhancementConcurrency: 1 }, prepare: async batch => ({ clips: batch }),
            render: async (clip, index, execution) => {
                if (index === 0) throw new Error('encoder failed');
                const output = { metadataPath: path.join(dir, 'good.json'), mediaPath: path.join(dir, 'good.mp4'), srtPath: path.join(dir, 'good.srt'), burnedSubtitles: true };
                const value = { window: { index: 2, ...clip }, uploadReady: true, output };
                fs.writeFileSync(output.metadataPath, JSON.stringify(value)); fs.writeFileSync(output.mediaPath, 'video'); fs.writeFileSync(output.srtPath, 'words');
                await execution.finishMedia(false); return value;
            } });
        await run.submitBatch(clips.map((clip, index) => ({ clip, index })));
        const result = await run.finish();
        expect(result.results).toHaveLength(2);
        expect(result.results[0]).toMatchObject({ uploadReady: false, publicCopyPending: true, window: { index: 1 } });
        expect(result.results[1].uploadReady).toBe(true);
        expect(fs.existsSync(result.results[0].output.metadataPath)).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('renders a published review batch before later reviews and reuses only hash-bound completed outputs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-render-'));
    const source = { mediaPath: path.join(dir, 'source.mp4'), srtPath: path.join(dir, 'source.srt') };
    fs.writeFileSync(source.mediaPath, 'source'); fs.writeFileSync(source.srtPath, 'subtitles');
    const clips = [{ start: 0, end: 30 }, { start: 40, end: 70 }];
    const render = jest.fn(async (clip, index, execution) => {
        const output = { mediaPath: path.join(dir, `${index}.mp4`), srtPath: path.join(dir, `${index}.srt`),
            metadataPath: path.join(dir, `${index}.json`), burnedSubtitles: true };
        for (const key of ['mediaPath', 'srtPath']) fs.writeFileSync(output[key], `clip ${index}`);
        const value = { window: { index: index + 1, ...clip }, uploadReady: index === 0, output };
        fs.writeFileSync(output.metadataPath, JSON.stringify(value));
        await execution.finishMedia(false); return value;
    });
    const make = () => createIncrementalRender({ outputRoot: dir, source, config: {}, initialClips: clips,
        pipelineOptions: { mediaConcurrency: 1, enhancementConcurrency: 1 }, prepare: async batch => ({ clips: batch }), render });
    try {
        const run = make(); await run.submitBatch([{ index: 1, clip: clips[1] }]);
        while (!fs.existsSync(path.join(dir, '1.json'))) await new Promise(resolve => setImmediate(resolve));
        expect(fs.existsSync(path.join(dir, '0.json'))).toBe(false);
        const progress = JSON.parse(fs.readFileSync(run.progressPath, 'utf8'));
        expect(progress.entries[0].status).toBe('awaiting_review');
        expect(fs.existsSync(progress.entries[1].snapshot)).toBe(true);
        await run.submitBatch([{ index: 0, clip: clips[0] }]);
        const result = await run.finish(); expect(result.results.map(x => x.window.index)).toEqual([1, 2]);
        expect(result.results[1].uploadReady).toBe(false);
        const resumed = make();
        await resumed.submitBatch([{ index: 1, clip: clips[1] }]); await resumed.submitBatch([{ index: 0, clip: clips[0] }]); await resumed.finish();
        expect(render).toHaveBeenCalledTimes(2);
        fs.writeFileSync(path.join(dir, '0.mp4'), 'changed');
        const changed = make(); await changed.submitBatch([{ index: 1, clip: clips[1] }]); await changed.submitBatch([{ index: 0, clip: clips[0] }]); await changed.finish();
        expect(render).toHaveBeenCalledTimes(3);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
