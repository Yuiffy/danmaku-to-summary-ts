import { spawn } from 'child_process';
import type { QQVideoSpan } from './QQVideoCutPolicy';

/** Decode from each requested cut point and concatenate re-encoded picture and original audio. */
export async function renderQQVideo(input: string, output: string, spans: QQVideoSpan[], hasAudio: boolean,
  maxBytes: number, signal: AbortSignal): Promise<void> {
  const seconds = (ms: number) => (ms / 1000).toFixed(3);
  const inputs = spans.flatMap(({ startMs, endMs }) => [
    '-protocol_whitelist', 'file', '-f', 'mov', '-threads', '1',
    '-ss', seconds(startMs), '-t', seconds(endMs - startMs), '-i', input
  ]);
  const filters = spans.flatMap(({ endMs, startMs }, index) => [
    `[${index}:V:0]setpts=PTS-STARTPTS,fps=30,scale=w='min(iw,1920)':h='min(ih,1920)':force_original_aspect_ratio=decrease:force_divisible_by=2[v${index}]`,
    ...(hasAudio ? [`[${index}:a:0]aresample=48000:async=1:first_pts=0,apad,atrim=duration=${seconds(endMs - startMs)},asetpts=PTS-STARTPTS[a${index}]`] : [])
  ]);
  const segments = spans.map((_, index) => `[v${index}]${hasAudio ? `[a${index}]` : ''}`).join('');
  filters.push(`${segments}concat=n=${spans.length}:v=1:a=${Number(hasAudio)}[video]${hasAudio ? '[audio]' : ''}`);
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_complex_threads', '1',
      ...inputs, '-filter_complex', filters.join(';'), '-map', '[video]', ...(hasAudio ? ['-map', '[audio]', '-c:a', 'aac'] : []),
      '-map_metadata', '-1', '-map_chapters', '-1', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p', '-crf', '23', '-maxrate', '5M', '-bufsize', '10M',
      '-fs', String(maxBytes + 1), '-movflags', '+faststart', output],
    { windowsHide: true, shell: false, stdio: 'ignore', signal, killSignal: 'SIGKILL' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    let failed = false;
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && !failed) resolve();
      else reject(new Error('FFmpeg could not render the clip'));
    });
  });
}
