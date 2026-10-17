/** Editorial signals only: ASR can mishear; audience requests never authorize publication. */
export interface ClipIntentSignal {
  source: 'asr' | 'danmaku'; action: 'request' | 'hold'; start: number; end: number;
  text: string; id?: string;
}
export interface ClipIntent { version: 1; needsHumanReview: boolean; signals: ClipIntentSignal[] }
type Cue = { id?: string; start: number; end: number; text: string; items?: Cue[] };
type Comment = { id?: string; time: number; text: string };

export function parseClipIntentCommand(text: string): 'request' | 'hold' | null {
  if (typeof text !== 'string' || text.length > 100) return null;
  const value = text.normalize('NFKC').trim();
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const match = /^@鹿饼[\s:：,，]*(我要这段|这段别切|这段不要切)[\s!！。~～]*$/u.exec(value);
  return match ? match[1] === '我要这段' ? 'request' : 'hold' : null;
}
function speechHold(text: string): boolean {
  const value = text.replace(/[\s，,。.!！?？、]/gu, '');
  return /(?:别|不要|不准|不许|不能)(?:给我|帮我|把这段|这段|这个|那个|也|就|真的|千万)*切(?!歌|菜|换|屏|镜头)/u.test(value);
}
export function collectClipIntentSignals(cues: Cue[], audience: Comment[]): ClipIntentSignal[] {
  const speech = cues.flatMap(cue => cue.items?.length ? cue.items : [cue])
    .filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
    .sort((a, b) => a.start - b.start);
  const signals: ClipIntentSignal[] = speech.filter(cue => speechHold(cue.text))
    .map(cue => ({ source: 'asr', action: 'hold', start: cue.start, end: cue.end, text: cue.text, id: cue.id }));
  // Match split words without joining unrelated turns or bridging long silences.
  for (let i = 0; i < speech.length; i++) {
    let text = speech[i].text;
    for (let j = i + 1; j < Math.min(speech.length, i + 3); j++) {
      if (speech[j].start - speech[j - 1].end > 1.5 || speech[j].end - speech[i].start > 15) break;
      text += speech[j].text;
      if (!speechHold(text)) continue;
      if (!signals.some(row => row.source === 'asr' && row.start < speech[j].end && row.end > speech[i].start)) {
        signals.push({ source: 'asr', action: 'hold', start: speech[i].start, end: speech[j].end, text });
      }
      break;
    }
  }
  for (const row of audience) {
    const action = parseClipIntentCommand(row.text);
    if (action && Number.isFinite(row.time) && row.time >= 0) signals.push({ source: 'danmaku', action,
      start: row.time, end: row.time, text: row.text, id: row.id });
  }
  return signals.sort((a, b) => a.start - b.start);
}
/** A warning immediately after the ending can refer back to the retained story. */
export function clipIntentForWindow(signals: ClipIntentSignal[], window: { start: number; end: number }): ClipIntent {
  const selected = signals.filter(row => row.start < window.end + 30 && row.end >= window.start);
  return { version: 1, needsHumanReview: selected.some(row => row.action === 'hold'), signals: selected };
}
export function clipIntentReasons(intent?: ClipIntent): string[] {
  return (intent?.signals || []).filter(row => row.action === 'hold').map(row => {
    const at = `${Math.floor(row.start / 60)}:${String(Math.floor(row.start % 60)).padStart(2, '0')}`;
    return `${row.source === 'asr' ? 'ASR疑似识别到主播要求别切' : '弹幕@鹿饼要求这段别切'}（${at}：“${row.text}”），需人工核对语境后决定是否切片`;
  });
}
