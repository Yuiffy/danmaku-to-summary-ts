import * as fs from 'fs';
import * as path from 'path';

/** Compare continuous decoded sample sequences; separate demux seeks can round at millisecond timebases. */
export function continuousAudioAudit(run: (args: string[]) => Promise<unknown>) {
    return async (source: string, rendered: string, sourceStart: number, outputStart: number, duration: number, directory: string) => {
        const { analyzeCreativeAudio, dialogueRmsFromPcm } = require('../../scripts/clipping/creative_audio_audit');
        fs.mkdirSync(directory);
        const rate = 48000, bytesPerSecond = rate * 2 * 4;
        const original = path.join(directory, 'source-continuous-48k.f32'), output = path.join(directory, 'output-continuous-48k.f32');
        await run(['-hide_banner', '-nostdin', '-n', '-ss', String(sourceStart), '-i', source, '-t', String(duration),
            '-map', '0:a:0', '-vn', '-ar', String(rate), '-ac', '2', '-c:a', 'pcm_f32le', '-f', 'f32le', original]);
        // Decode the output from its beginning, then trim by sample index. Seeking anew for each
        // 30-second chunk changes the resampling phase on real FLV/AAC recordings.
        const first = Math.round(outputStart * rate), last = first + Math.round(duration * rate);
        await run(['-hide_banner', '-nostdin', '-n', '-i', rendered, '-map', '0:a:0', '-vn',
            '-af', `aresample=${rate},atrim=start_sample=${first}:end_sample=${last},asetpts=PTS-STARTPTS`,
            '-ar', String(rate), '-ac', '2', '-c:a', 'pcm_f32le', '-f', 'f32le', output]);
        const lengths = [original, output].map(file => fs.statSync(file).size);
        if (lengths.some(n => n % 8 || Math.abs(n / bytesPerSecond - duration) > .08)
            || Math.abs(lengths[0] - lengths[1]) / bytesPerSecond > .08) throw new Error('Original audio preservation failed: audio_duration_changed');
        const handles = [original, output].map(file => fs.openSync(file, 'r'));
        const checks: unknown[] = [];
        try {
            for (let position = 0, bytes = Math.min(...lengths); position < bytes; position += 30 * bytesPerSecond) {
                const size = Math.min(30 * bytesPerSecond, bytes - position);
                const buffers = handles.map(handle => {
                    const b = Buffer.alloc(size);
                    if (fs.readSync(handle, b, 0, size, position) !== size) throw new Error('Incomplete original audio audit');
                    return b;
                });
                const originalRms = dialogueRmsFromPcm(buffers[0]), renderedRms = dialogueRmsFromPcm(buffers[1]);
                const silent = originalRms < 1e-5 && renderedRms < 1e-5;
                const checked = analyzeCreativeAudio(buffers[0], buffers[1], { duration: size / bytesPerSecond, effects: [] }, {}, rate);
                const issues = silent ? checked.issues.filter((s: string) => s !== 'original_audio_changed_outside_effects') : checked.issues;
                const check = { ...checked, issues, status: issues.length ? 'failed' : 'passed', silent, originalRms, renderedRms, offset: position / bytesPerSecond };
                checks.push(check);
                fs.writeFileSync(path.join(directory, `${checks.length - 1}-CHECK.json`), JSON.stringify(check, null, 2) + '\n');
                if (issues.length) throw new Error(`Original audio preservation failed: ${issues.join(', ')}`);
            }
        } finally { handles.forEach(handle => fs.closeSync(handle)); }
        return { status: 'passed', method: 'continuous_native_rate_pcm', source, sourceStart, outputStart, duration, lengths, checks };
    };
}
