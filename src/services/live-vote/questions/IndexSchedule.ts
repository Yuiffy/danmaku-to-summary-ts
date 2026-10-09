/** Daily 05:00 Asia/Shanghai, independent of the host timezone. Startup catches up after outages. */
export function nextIndexRun(now: number, lastSuccess?: number, lastFailure?: number): number {
  if (lastFailure !== undefined && (!lastSuccess || lastFailure > lastSuccess)) return Math.max(now, lastFailure + 15 * 60000);
  const offset = 8 * 3600000, day = 86400000;
  const today = Math.floor((now + offset) / day) * day - offset + 5 * 3600000;
  const latest = now >= today ? today : today - day;
  if (lastSuccess === undefined || lastSuccess < latest) return now;
  return now < today ? today : today + day;
}
