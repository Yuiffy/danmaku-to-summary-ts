import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { validateRenderedTimingRepair } from './publicationTiming';
import { verifyRenderedTimingAudio } from './ownTimingRecovery';

test('new timing audio reads the rebuilt file in bounded windows and binds the same proof in Python', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'final-timing-audio-'));
    const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const make = name => { const file = path.join(directory, name); fs.writeFileSync(file, name); return file; };
    try {
        const media = make('original.flv'), output = make('new.mp4'), srt = make('new.srt');
        const original = make('original.srt'), aligned = make('aligned.srt');
        const metadataPath = make('original.asr_meta.json'), speakers = make('aligned.asr_speakers.json'), evidence = make('aligned.asr_evidence.json');
        const stat = fs.statSync(media, { bigint: true });
        const artifact = { source: { mediaPath: media, srtPath: aligned }, window: { start: 100, end: 130.1, duration: 30.1 },
            output: { mediaPath: output, srtPath: srt, metadataPath: path.join(directory, 'clip.json') },
            renderedTimingRepair: { version: 1, originalSource: { mediaPath: media, mediaBytes: String(stat.size), mediaMtimeNs: String(stat.mtimeNs) },
                rendered: { window: { start: 100, end: 130.1 }, video: hash(output), subtitles: hash(srt) },
                transcript: { mode: 'repaired_source_audio', path: aligned, sha256: hash(aligned), originalSrtPath: original,
                    originalSrtSha256: hash(original), metadataPath, metadataSha256: hash(metadataPath),
                    speakerPath: speakers, speakerSha256: hash(speakers), evidencePath: evidence, evidenceSha256: hash(evidence) } } };
        const runAudio = jest.fn(async (input, result) => {
            const request = JSON.parse(fs.readFileSync(input, 'utf8'));
            expect(request.source.mediaPath).toBe(output);
            expect(request.windows).toHaveLength(2);
            expect(request.windows[0].start).toBe(0); expect(request.windows.at(-1).end).toBe(30.1);
            expect(request.windows.every(row => row.end - row.start <= 30)).toBe(true);
            const windows = request.windows.map((row, index) => {
                const wav = make(`audio-${index}.wav`);
                return { ...row, audioPath: wav, audioSha256: hash(wav), decodes: ['nano', 'sensevoice'].map(model => ({
                    model, text: '吐槽捂脸，快打字', prompted: false, hotwords: [], useItn: false })) };
            });
            fs.writeFileSync(result, JSON.stringify({ requestSha256: request.requestSha256, source: request.source, windows }));
        });
        const revised = await verifyRenderedTimingAudio(artifact, { python: { executable: 'unused', args: [] },
            scriptPath: make('decoder.py'), settings: { use_itn: false }, runAudio });
        const binding = validateRenderedTimingRepair(revised);
        fs.writeFileSync(artifact.output.metadataPath, JSON.stringify(revised));
        const python = spawnSync('python', ['-c', 'import json,sys; from src.scripts.clip_source_timing import validate_rendered_timing_repair; print(validate_rendered_timing_repair(json.load(open(sys.argv[1],encoding="utf-8"))))',
            artifact.output.metadataPath], { encoding: 'utf8', windowsHide: true });
        expect(python.status).toBe(0); expect(python.stdout.trim()).toBe(binding);
        expect(() => validateRenderedTimingRepair({ ...revised, window: { ...revised.window, start: 99 } })).toThrow('尚未重建');
        expect(() => validateRenderedTimingRepair(artifact)).toThrow('独立原音复核');
        fs.appendFileSync(revised.renderedTimingRepair.finalAudio.windows[0].audioPath, 'changed');
        expect(() => validateRenderedTimingRepair(revised)).toThrow('原音证据');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
