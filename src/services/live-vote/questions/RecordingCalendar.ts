import { SubtitleSource } from './SubtitleCorpus';
import { openingDates, openingSourceKey, openingSourcePriority, recordingClock } from './RecordingOpenings';

export interface ReadRecordingCalendar { fromDate: string; toDate: string; dayBoundaryHour: number }
export interface RecordingDay {
  date: string; weekday: string; subtitleRecordings: number; danmakuRecordings: number;
  unknownClockRecordings: number; recordingIds: string[];
}
export interface RecordingCalendar extends ReadRecordingCalendar { days: RecordingDay[]; limited: boolean; notice: string }

export function parseRecordingCalendar(args: unknown): ReadRecordingCalendar {
  const v = args as ReadRecordingCalendar;
  const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!v || Object.keys(v).sort().join(',') !== 'dayBoundaryHour,fromDate,toDate' ||
      !validDate(v.fromDate) || !validDate(v.toDate) || v.fromDate > v.toDate || Date.parse(v.toDate) - Date.parse(v.fromDate) > 30 * 86400000 ||
      !Number.isInteger(v.dayBoundaryHour) || v.dayBoundaryHour < 0 || v.dayBoundaryHour > 12) throw new Error('Invalid recording calendar');
  return v;
}

export const nextCalendarDate = (date: string): string => new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);

/** Recorded-file presence, not authoritative live status. A shifted day groups overnight continuations. */
export function summarizeRecordingDays<T extends SubtitleSource & { kind: string }>(input: ReadRecordingCalendar, sources: T[], idFor: (source: T) => string,
  limited: boolean): RecordingCalendar {
  const grouped = new Map<string, Map<string, T>>();
  for (const file of sources) {
    if (file.kind !== 'subtitle' && file.kind !== 'danmaku') continue;
    const clock = recordingClock(file);
    let date = clock ? clock.slice(0, 3).join('-') : file.date;
    if (!date) continue;
    if (clock && Number(clock[3]) < input.dayBoundaryHour) date = new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10);
    if (date < input.fromDate || date > input.toDate) continue;
    const group = grouped.get(date) || new Map<string, T>();
    const key = `${file.kind}:${openingSourceKey(file)}`, previous = group.get(key);
    if (!previous || openingSourcePriority(file) < openingSourcePriority(previous)) group.set(key, file);
    grouped.set(date, group);
  }
  return { ...input, days: openingDates(input).map(date => {
    const files = [...(grouped.get(date)?.values() || [])];
    // Keep two handles for targeted reads without returning a month's filenames or captions.
    const sample = [...files].sort((a, b) => Number(b.kind === 'subtitle') - Number(a.kind === 'subtitle') || a.file.localeCompare(b.file)).slice(0, 2);
    return { date, weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(date).getUTCDay()],
      subtitleRecordings: files.filter(file => file.kind === 'subtitle').length,
      danmakuRecordings: files.filter(file => file.kind === 'danmaku').length,
      unknownClockRecordings: files.filter(file => !recordingClock(file)).length, recordingIds: sample.map(idFor) };
  }), limited, notice: '只表示本次范围内发现的字幕/弹幕录制资料；副本按录制时钟和类型去重，计数不是直播场数。'
    + 'dayBoundaryHour以前的已知录制时钟归入前一天，便于观察夜间连续性，不证明真实开播日。无时钟文件按资料日期保留。'
    + '没有资料不等于休息或未开播，未来日期尚未发生；轮休规律须结合近期原文、观众线索及连续多日分布核对，推算需注明条件与临时调休可能。' };
}
