export {};
const fs = require('fs'), os = require('os'), path = require('path');
const { preparePacingBatch } = require('./pacing_prepare');
test('local audio preparation selects only a verified useful pause without model generation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacing-prep-'));
    const source = { mediaPath: path.join(dir, 'video.flv'), srtPath: path.join(dir, 'video.srt') };
    fs.writeFileSync(source.mediaPath, 'source'); fs.writeFileSync(source.srtPath, 'subtitle bytes');
    const clips = [0, 1, 2, 3].map(i => ({ start: i * 30, end: i * 30 + 20, title: 'verified story' }));
    const parsed = { segments: clips.flatMap(clip => [{ start: clip.start, end: clip.start + 5, text: 'setup' },
        { start: clip.end - 5, end: clip.end, text: 'ending' }]).map(row => ({ ...row, asrEvidence: { sourceSpan: row } })) };
    const settings = { enhancements: { editing: true, experiment: { ratio: .25, maxClips: 5 },
        pacing: { maxRemovedRatio: .4, nonSpeechVad: false } } };
    const decode = jest.fn(async gap => {
        const buffer = Buffer.alloc(Math.round((gap.end - gap.start) * 16000) * 4);
        // 4 seconds of actual quiet, then non-quiet PCM; only the first clip has a useful pause.
        for (let frame = 0; frame < buffer.length / 4; frame++) if (gap.start > 10 || frame > 64000) buffer.writeInt16LE(2000, frame * 4);
        return buffer;
    });
    try {
        const result = await preparePacingBatch(clips, parsed, settings, { selectionCacheDirectory: path.join(dir, 'cache') }, source,
            { probe: async () => ({ streams: [{ channels: 2 }] }), decode });
        expect(result.summary.selected.map(row => row.id)).toEqual([1]);
        expect(result.summary.selectionLog).toBeNull();
        expect(result.clips[0].precisionPreparation.events[0].kind).toBe('silence');
        const count = decode.mock.calls.length;
        await preparePacingBatch(clips, parsed, settings, { selectionCacheDirectory: path.join(dir, 'cache') }, source,
            { probe: async () => ({ streams: [{ channels: 2 }] }), decode });
        expect(decode).toHaveBeenCalledTimes(count);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
