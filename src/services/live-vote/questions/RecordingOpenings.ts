import * as path from 'path';
import { recordingSessionKey, SubtitleSource } from './SubtitleCorpus';

export interface ReadOpenings {
  fromDate: string; toDate: string; offset: number; limit: number; endSeconds: number; cuesPerRecording: number;
}
export interface OpeningCoverage {
  roomId?: string; fromDate: string; toDate: string; startSeconds: 0; endSeconds: number; datesWithoutSubtitles: string[];
}
export function openingDates(input: Pick<ReadOpenings, 'fromDate' | 'toDate'>): string[] {
  const dates: string[] = [];
  for (let day = Date.parse(input.fromDate); day <= Date.parse(input.toDate); day += 86400000) dates.push(new Date(day).toISOString().slice(0, 10));
  return dates;
}
export function parseReadOpenings(args: unknown): ReadOpenings {
  const v = args as ReadOpenings;
  const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!v || Object.keys(v).sort().join(',') !== 'cuesPerRecording,endSeconds,fromDate,limit,offset,toDate' ||
      !validDate(v.fromDate) || !validDate(v.toDate) || v.fromDate > v.toDate || Date.parse(v.toDate) - Date.parse(v.fromDate) > 30 * 86400000 ||
      !Number.isInteger(v.offset) || v.offset < 0 || v.offset > 10000 || !Number.isInteger(v.limit) || v.limit < 1 || v.limit > 8 ||
      !Number.isFinite(v.endSeconds) || v.endSeconds < 1 || v.endSeconds > 3600 || !Number.isInteger(v.cuesPerRecording) ||
      v.cuesPerRecording < 1 || v.cuesPerRecording > 80 || v.limit * v.cuesPerRecording > 384) throw new Error('Invalid recording openings');
  return v;
}

/** Recorder clocks identify archive copies, never a confirmed broadcast start. */
export function recordingClock(file: SubtitleSource): string[] | undefined {
  const name = path.basename(file.file);
  const match = /^(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_/u.exec(name) ||
    /^录制-\d+-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/u.exec(name);
  return match?.slice(1, 7);
}
export function openingSourceKey(file: SubtitleSource): string {
  return recordingClock(file)?.join('-') || recordingSessionKey(file);
}
export function openingSourcePriority(file: SubtitleSource): number {
  const part = /_(\d+)_fix(?:\.speaker)?\.srt$/iu.exec(file.file);
  return (part ? Number(part[1]) - 1 : 0) * 10 + (/\.live\.srt$/iu.test(file.file) ? 2 : 0);
}
