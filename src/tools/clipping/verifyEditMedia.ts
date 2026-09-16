import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { planFromEvidenceIds, mapSubtitles, AudioEvidence } from '../../workflows/clipping/editPlan';

async function main() {
    const root = path.resolve(__dirname, '../../..');
    const directory = path.join(root, 'tmp', 'clip-edit-media-validation');
    fs.mkdirSync(directory, { recursive: true });
    process.env.DANMAKU_WORKFLOW_RELEASE ||= JSON.parse(fs.readFileSync(path.join(root, 'build/workflow-candidate.json'), 'utf8')).releaseDir;
    const topic = require('../../scripts/topic_clipper');
    const own = require('../../scripts/own_stream_clipper');
    const config = own.getOwnStreamClipsConfig(require('../../scripts/config-loader').getConfig());
    const ffmpeg = config.ffmpegPath || 'ffmpeg';
    const original = path.join(directory, 'synthetic-source.mp4');
    execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=20',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20', '-af', "volume=0:enable='between(t,7,13)'",
        '-c:v', config.subtitleVideoEncoder, '-preset', config.subtitleVideoPreset, '-c:a', 'aac', original],
    { windowsHide: true, timeout: 60000 });
    const speech = [{ start: 0.5, end: 5, text: 'SETUP: original context' }, { start: 15, end: 19.5, text: 'CORRECTION: preserve this ending' }]
        .map(row => ({ ...row, asrEvidence: { sourceSpan: { start: row.start, end: row.end } } }));
    const evidence: AudioEvidence[] = [{ id: 'synthetic-silence', sourceId: 'synthetic-v1', kind: 'silence',
        start: 7, end: 13, verified: true, precisionSeconds: 0.02 }];
    const window = { start: 0, end: 20, duration: 20 };
    const plan = planFromEvidenceIds('synthetic-v1', window, ['synthetic-silence'], speech, evidence);
    const mapped = mapSubtitles(speech, plan);
    const duration = plan.keep.reduce((total, span) => total + span.end - span.start, 0);
    const results = [];
    for (const edited of [false, true]) {
        const name = edited ? 'edited' : 'continuous';
        const mediaPath = path.join(directory, `${name}.mp4`), srtPath = path.join(directory, `${name}.srt`);
        topic.writeClipSrt(edited ? mapped : speech, edited ? { start: 0, end: duration, duration } : window, srtPath);
        const media = await topic.cutClipMedia({ kind: 'video', mediaPath: original }, window, srtPath, mediaPath, {
            ...config, ffmpegPath: ffmpeg, ffmpegThreads: config.clipFfmpegThreads,
            ...(edited ? { editPlan: plan, editSourceId: 'synthetic-v1', originalSubtitleSegments: speech, editAudioEvidence: evidence } : {})
        });
        const probe = JSON.parse(execFileSync(topic.resolveFfprobePath(ffmpeg), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mediaPath],
            { encoding: 'utf8', windowsHide: true, timeout: 30000 }));
        const audio = probe.streams.find((row: any) => row.codec_type === 'audio');
        const video = probe.streams.find((row: any) => row.codec_type === 'video');
        const expected = edited ? duration : 20;
        if (!audio || !video || Math.abs(Number(probe.format.duration) - expected) > 0.15
            || Math.abs(Number(audio.duration) - Number(video.duration)) > 0.1 || !media.burnedSubtitles) throw new Error('Media validation failed');
        const preview = path.join(directory, `${name}.jpg`);
        execFileSync(ffmpeg, ['-y', '-v', 'error', '-ss', String(expected - 2), '-i', mediaPath, '-frames:v', '1', preview], { windowsHide: true, timeout: 30000 });
        results.push({ name, expected, videoSeconds: video.duration, audioSeconds: audio.duration, media, preview });
    }
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ synthetic: true, plan, results, paidRequests: 0 }, null, 2), 'utf8');
    console.log(JSON.stringify({ directory, results }));
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
