export {};
const fs = require('fs'), os = require('os'), path = require('path');
const t = require('./stream_activity_transcript');
const { sourceSnapshot } = require('./source_snapshot');

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-transcript-'));
    const mediaPath = path.join(dir, 'source.flv'), srtPath = path.join(dir, 'source.srt');
    fs.writeFileSync(mediaPath, 'source'); fs.writeFileSync(srtPath, '1\n00:01:40,000 --> 00:01:42,000\n旧的错位文字\n');
    fs.writeFileSync(path.join(dir, 'source.asr_meta.json'), JSON.stringify({ backend: 'paraformer',
        speakerProcessing: { intervalSource: 'funasr_vad+paraformer_sentence_info_fallback' } }));
    const source = sourceSnapshot({ source: { mediaPath, srtPath } });
    const extract = jest.fn(async args => fs.writeFileSync(args.at(-1), 'pcm'));
    const transcribe = jest.fn(async () => ({ backend: 'paraformer', segments: [{ start: 250, end: 253, text: '实际时间的演唱歌词' }] }));
    return { dir, source, options: { source, root: {}, directory: dir, duration: 500, extract, transcribe, probe: async () => 500 }, extract, transcribe };
}
test('known sentence_info fallback rebuilds a source-bound transcript and reuses it without changing the original', async () => {
    const f = fixture();
    try {
        const repaired = await t.prepareActivityTranscript(f.options);
        expect(repaired).toMatchObject({ mode: 'repaired_source_audio', reason: 'paraformer_sentence_info_alignment_fallback' });
        expect(fs.readFileSync(f.source.srtPath, 'utf8')).toContain('旧的错位文字');
        expect(fs.readFileSync(repaired.path, 'utf8')).toContain('00:04:10,000');
        expect(f.transcribe.mock.calls[0][1].asr.paraformer).toMatchObject({ model_profile: 'default', finetuned_model: null,
            enable_speaker: false, max_vad_segment_s: 8, gpu_throttle: { enabled: true, segment_paraformer: true } });
        expect(await t.prepareActivityTranscript(f.options)).toEqual(repaired);
        expect(f.transcribe).toHaveBeenCalledTimes(1);
        fs.appendFileSync(repaired.path, 'changed');
        await t.prepareActivityTranscript(f.options);
        expect(f.transcribe).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('an incompatible decoded timeline fails before producing claimed repaired timestamps', async () => {
    const f = fixture();
    try {
        await expect(t.prepareActivityTranscript({ ...f.options, probe: async () => 400 })).rejects.toThrow('timeline differs');
        expect(f.transcribe).not.toHaveBeenCalled();
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('ordinary transcripts retain their source identity and do not trigger another ASR', async () => {
    const f = fixture();
    try {
        fs.writeFileSync(path.join(f.dir, 'source.asr_meta.json'), JSON.stringify({ backend: 'paraformer',
            speakerProcessing: { intervalSource: 'paraformer_subtitle_timestamps' } }));
        expect(await t.prepareActivityTranscript(f.options)).toEqual({ path: f.source.srtPath, sha256: f.source.srtSha256, mode: 'source_srt' });
        expect(f.extract).not.toHaveBeenCalled();
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('the daily summary workflow flags bad timing without another whole-recording ASR', async () => {
    const f = fixture();
    try {
        const original = await t.prepareActivityTranscript({ ...f.options, reuseOnly: true });
        expect(original).toMatchObject({ mode: 'source_srt', timingReliable: false });
        expect(f.transcribe).not.toHaveBeenCalled(); expect(f.extract).not.toHaveBeenCalled();
        const repaired = await t.prepareActivityTranscript(f.options);
        expect(await t.prepareActivityTranscript({ ...f.options, reuseOnly: true })).toEqual(repaired);
        expect(f.transcribe).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
