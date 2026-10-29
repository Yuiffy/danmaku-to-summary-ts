import { execFile } from 'child_process';
import { promisify } from 'util';
import type { StyleIO } from './editorialRuntime';
import { parseLoudness } from './editorialAudio';
const exec = promisify(execFile);

/** The source CLI supplies the existing resource-scheduled FFmpeg adapter. */
export function editorialMediaIO(settings: Record<string, any>, ffprobe: string,
    run: (args: string[]) => Promise<unknown>): StyleIO {
    return {
        probe: async file => {
            const r = await exec(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true, timeout: 30000 });
            const p = JSON.parse(r.stdout), video = p.streams.find((s: any) => s.codec_type === 'video');
            if (!video) throw new Error('Video stream missing');
            return { duration: Number(p.format.duration), width: video.width, height: video.height,
                audio: p.streams.some((s: any) => s.codec_type === 'audio') };
        },
        measureAudio: async (file, start, end) => {
            const result = await run(['-nostats', ...(start === undefined ? [] : ['-ss', String(start)]), '-i', file,
                ...(end === undefined ? [] : ['-t', String(end - (start || 0))]), '-vn', '-map', '0:a:0',
                '-af', 'loudnorm=I=-23:TP=-1.5:LRA=7:print_format=json', '-f', 'null', '-']) as { stderr: string };
            return parseLoudness(result.stderr);
        },
        render: async (file, out, start, end, size, audioGainDb = 0) => {
            const encode = (encoder: string) => run(['-y', '-ss', String(start), '-i', file, '-t', String(end - start),
                '-map', '0:v:0', '-map', '0:a:0', '-vf', `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`,
                '-af', `volume=${audioGainDb}dB,aresample=48000,apad`, '-c:v', encoder,
                ...(encoder === 'h264_nvenc' ? ['-preset', settings.subtitleVideoPreset || 'p4', '-cq', String(settings.subtitleVideoCq || 23)] : ['-preset', 'fast', '-crf', String(settings.subtitleVideoCrf || 23)]),
                '-video_track_timescale', '15360', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', out]);
            try { await encode(settings.subtitleVideoEncoder || 'h264_nvenc'); }
            catch (error) { if (settings.subtitleVideoEncoder === 'libx264') throw error; await encode('libx264'); }
        },
        concat: async (list, out) => { await run(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]); }
    };
}
