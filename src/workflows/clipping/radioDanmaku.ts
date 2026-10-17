import * as fs from 'fs/promises';
import * as path from 'path';
import { reactionOutputTime, ReactionTimeline } from './reactionTiming';

export interface RadioSettings {
  enabled?: boolean;
  mode?: 'portrait' | 'radio' | 'off';
  roomIds?: string[];
  fontScale?: number;
  fps?: number;
}
interface Window { start: number; duration: number }
interface Resolution { width: number; height: number }
export interface Comment { time: number; text: string; color: number }
interface Span { start: number; end: number }

/** Project only comments that begin in retained source spans, including inserted reaction holds. */
export function projectComments(comments: Comment[], window: Window, editKeep?: Span[], timeline?: ReactionTimeline) {
  if (timeline) {
    const rows = comments.filter(c => timeline.keep.some(s => c.time - window.start >= s.start && c.time - window.start < s.end));
    return { comments: rows.map(c => ({ ...c, time: reactionOutputTime(c.time - window.start, timeline) })),
      window: { start: 0, duration: timeline.duration } };
  }
  if (editKeep) {
    let offset = 0;
    const rows = editKeep.flatMap(span => {
      const mapped = comments.filter(c => c.time >= span.start && c.time < span.end)
        .map(c => ({ ...c, time: offset + c.time - span.start }));
      offset += span.end - span.start;
      return mapped;
    });
    return { comments: rows, window: { start: 0, duration: offset } };
  }
  return { comments, window };
}

/** The configured Sui portrait layout is the radio layout; landscape needs an explicit radio mode. */
export function radioEnabled(mediaPath: string, resolution: Resolution, settings: RadioSettings = {}): boolean {
  if (settings.enabled !== true || settings.mode === 'off') return false;
  if (settings.mode === 'radio') return true;
  const room = path.basename(mediaPath).match(/^(?:录制-)?(\d{5,})[-_]/u)?.[1];
  return Boolean(room && (settings.roomIds || ['25788785']).includes(room) && resolution.height > resolution.width);
}

/** Parse entries separately so old browser-preview markup cannot corrupt otherwise valid comments. */
export async function parseComments(xml: string): Promise<Comment[]> {
  const { parseStringPromise } = await import('xml2js');
  const entries = xml.match(/<d\b[^>]*>[\s\S]*?<\/d>/gu) || [];
  const parsed = await parseStringPromise(`<i>${entries.join('')}</i>`);
  return (parsed.i?.d || []).map((row: { $?: { p?: string }; _?: string }) => {
    const attrs = String(row.$?.p || '').split(',');
    return { time: Number(attrs[0]), text: String(row._ || '').trim(), color: Number(attrs[3] || 16777215) };
  }).filter((row: Comment) => Number.isFinite(row.time) && row.time >= 0 && row.text)
    .sort((a: Comment, b: Comment) => a.time - b.time);
}

function assTime(seconds: number): string {
  const centiseconds = Math.round(Math.max(0, seconds) * 100);
  return `${Math.floor(centiseconds / 360000)}:${String(Math.floor(centiseconds / 6000) % 60).padStart(2, '0')}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

function displayText(text: string): string {
  return text.replace(/\[岁己收藏集表情包_([^\]]+)\]/gu, '[$1]')
    .replace(/[\r\n]+/gu, ' ').replace(/[\x00-\x1f\x7f]/gu, '')
    .replace(/\\/gu, '＼').replace(/\{/gu, '｛').replace(/\}/gu, '｝');
}

export function buildRadioAss(comments: Comment[], window: Window, resolution: Resolution, settings: RadioSettings = {}) {
  const { width, height } = resolution;
  const scale = settings.fontScale ?? 2;
  const fps = settings.fps ?? 30;
  if (![width, height, window.duration, scale, fps].every(v => Number.isFinite(v) && v > 0)
      || !Number.isFinite(window.start) || window.start < 0 || fps < 24 || fps > 60 || scale > 4) {
    throw new Error('Invalid radio danmaku dimensions, window, scale or frame rate');
  }
  const fontSize = Math.round(Math.min(width, height) * 40 / 1080 * scale);
  const lineHeight = Math.ceil(fontSize * 1.15);
  const laneCount = Math.max(1, Math.floor(height * .26 / lineHeight));
  const lanes: Array<{ start: number; end: number; width: number } | null> = Array(laneCount).fill(null);
  const selected = comments.filter(c => c.time >= window.start && c.time < window.start + window.duration);
  const events = selected.map(comment => {
    const start = comment.time - window.start;
    const end = start + 8; // Let the video boundary clip motion; never accelerate late comments.
    const text = displayText(comment.text);
    const textWidth = Math.ceil(Array.from(text).reduce((sum, char) => sum + (/\p{Script=Latin}|[\x20-\x7e]/u.test(char) ? .6 : 1), 0) * fontSize);
    // Only share a lane after the previous tail cleared the entrance and cannot be caught.
    const fits = (last: NonNullable<typeof lanes[number]>) => {
      const speed = (width + last.width) / (last.end - last.start);
      const gap = speed * (start - last.start) - last.width;
      const closing = (width + textWidth) / (end - start) - speed;
      return gap >= fontSize && gap - Math.max(0, closing) * Math.max(0, last.end - start) >= fontSize;
    };
    let lane = lanes.findIndex(last => !last || start >= last.end || fits(last));
    if (lane < 0) lane = lanes.reduce((best, row, i) => row!.start < lanes[best]!.start ? i : best, 0);
    lanes[lane] = { start, end, width: textWidth };
    const y = lane * lineHeight;
    const rgb = (Number.isFinite(comment.color) ? comment.color : 16777215) & 0xffffff;
    const color = rgb.toString(16).padStart(6, '0').match(/../gu)!.reverse().join('').toUpperCase();
    return `Dialogue: 2,${assTime(start)},${assTime(end)},Radio,,0,0,0,,{\\move(${width},${y},${-textWidth},${y})\\c&H${color}&}${text}`;
  });
  const ass = ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`,
    'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Radio,Microsoft YaHei,${fontSize},&H33FFFFFF,&H33FFFFFF,&H33000000,&H33000000,0,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(fontSize / 25))},0,7,0,0,0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...events, ''].join('\n');
  return { ass, commentCount: events.length, fontSize, fps };
}

export function overlayFilter(escapedAssPath: string, fps: number, duration: number): string {
  // Resample decoded background frames BEFORE libass evaluates animated positions.
  // Output-only -r would merely duplicate already-rendered, frozen comment positions.
  return `fps=fps=${fps}:round=near,tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},ass='${escapedAssPath}'`;
}

export async function prepareRadioDanmaku(input: {
  mediaPath: string; xmlPath?: string; assPath: string; window: Window; resolution: Resolution; settings?: RadioSettings;
  editKeep?: Span[]; timeline?: ReactionTimeline;
}, io = { read: (file: string) => fs.readFile(file, 'utf8'), write: (file: string, content: string) => fs.writeFile(file, content, 'utf8') }) {
  if (!radioEnabled(input.mediaPath, input.resolution, input.settings)) return null;
  const xmlPath = input.xmlPath || input.mediaPath.replace(/\.[^.]+$/u, '.xml');
  // Fail visibly on missing/invalid XML: a requested overlay must not silently disappear.
  const xml = await io.read(xmlPath);
  const projected = projectComments(await parseComments(xml), input.window, input.editKeep, input.timeline);
  const built = buildRadioAss(projected.comments, projected.window, input.resolution, input.settings);
  await io.write(input.assPath, built.ass);
  return { assPath: input.assPath, xmlPath, commentCount: built.commentCount, fontSize: built.fontSize, fps: built.fps, duration: projected.window.duration };
}
