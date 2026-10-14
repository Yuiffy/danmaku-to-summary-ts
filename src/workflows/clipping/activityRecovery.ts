/** Extending an end must not shift every earlier P and force a full re-encode. */
export function retainWatchPartBoundaries(planned: Record<string, any>[], previous: Record<string, any>[],
  target: number, maximum: number): Record<string, any>[] {
  if (!(Number.isFinite(target) && Number.isFinite(maximum) && target > 0 && target <= maximum)) throw new Error('Invalid watch part size');
  const result: Record<string, any>[] = [];
  for (const id of new Set(planned.map(p => p.activityId))) {
    const next = planned.filter(p => p.activityId === id), old = previous.filter(p => p.activityId === id);
    const valid = old.length > 0 && old[0].start === next[0].start
      && old.every((p, i) => p.end > p.start && p.duration === p.end - p.start && p.duration <= maximum
        && (i === 0 || p.start === old[i - 1].end));
    if (valid && old.at(-1)!.end === next.at(-1)!.end) {
      result.push(...old.map(p => ({ ...next[0], start: p.start, end: p.end, duration: p.duration })));
      continue;
    }
    if (!valid || old.length < 2 || old.at(-1)!.end > next.at(-1)!.end) { result.push(...next); continue; }
    const template = next[0], prefix = old.slice(0, -1), start = old.at(-1)!.start, end = next.at(-1)!.end;
    const count = Math.max(1, Math.ceil((end - start) / target), Math.ceil((end - start) / maximum));
    result.push(...prefix.map(p => ({ ...template, start: p.start, end: p.end, duration: p.duration })));
    for (let i = 0; i < count; i++) {
      const from = start + (end - start) * i / count, to = start + (end - start) * (i + 1) / count;
      result.push({ ...template, start: from, end: to, duration: to - from });
    }
  }
  if (result.length > 100) throw new Error('A multipart submission exceeds the 100-P limit; keep the plan for review');
  return result;
}

/** Reused bytes are local progress, never publication approval. */
export function reusableActivityPart(part: Record<string, any>, previous: Record<string, any> | null,
  source: Record<string, any>, io: { size(file: string): number; digest(file: string): string }): Record<string, any> | null {
  if (!previous || JSON.stringify(previous.sourceSnapshot) !== JSON.stringify(source)) return null;
  const old = previous.output?.parts?.find((p: Record<string, any>) => p.activityId === part.activityId
    && p.start === part.start && p.end === part.end && p.duration === part.duration);
  if (!old || !Number.isFinite(old.actualDuration) || Math.abs(old.actualDuration - part.duration) > .25) return null;
  try {
    if (io.size(old.mediaPath) === old.bytes && io.digest(old.mediaPath) === old.sha256) return { ...old, ...part };
  } catch { /* Missing or changed media must be rendered again. */ }
  return null;
}

export async function resumeVerifiedPart<T extends { bytes: number; sha256: string; actualDuration: number }>(
  binding: string, duration: number, io: {
    read(): { version: number; binding: string; result: T } | null;
    matches(result: T): Promise<boolean>;
    invalidate(): void;
    render(): Promise<T>;
    save(receipt: { version: number; binding: string; result: T }): void;
    reused(): void;
  }): Promise<T> {
  const receipt = io.read();
  if (receipt?.version === 1 && receipt.binding === binding
      && Number.isFinite(receipt.result?.actualDuration)
      && Math.abs(receipt.result.actualDuration - duration) <= .25
      && await io.matches(receipt.result)) {
    io.reused();
    return receipt.result;
  }
  // Remove a prior receipt before overwriting media, including failed attempts.
  io.invalidate();
  const result = await io.render();
  if (!Number.isFinite(result.actualDuration) || Math.abs(result.actualDuration - duration) > .25) {
    throw new Error('Activity render did not produce the complete requested duration');
  }
  io.save({ version: 1, binding, result });
  return result;
}

/** Bounded job retries survive process restart; review holds are successful jobs. */
export function failedJob(entry: Record<string, any>, error: unknown, now: number): Record<string, any> {
  const attempts = Number(entry.attempts || 0) + 1;
  return { ...entry, attempts, status: attempts >= 3 ? 'failed' : 'pending',
    lastError: error instanceof Error ? error.message : String(error),
    updatedAt: new Date(now).toISOString(), nextAttemptAt: now + (attempts === 1 ? 60_000 : 300_000) };
}

export interface StageProgress {
  version: number;
  completed: Record<string, any>;
  status?: string;
  stage?: string;
}

export async function resumeStage<T>(state: StageProgress, stage: string,
  save: (state: StageProgress) => void, run: () => Promise<T>): Promise<T> {
  if (Object.prototype.hasOwnProperty.call(state.completed, stage)) return state.completed[stage] as T;
  state.status = 'running'; state.stage = stage; save(state);
  const result = await run();
  state.completed[stage] = result;
  save(state);
  return result;
}

/** Retry transport failures only; valid responses and evidence errors are final. */
export function transientActivityFailure(error: unknown): boolean {
  const failure = error as { message?: string; code?: string; type?: string; attempts?: { httpStatus?: number }[] };
  const status = failure?.attempts?.at(-1)?.httpStatus
    ?? Number(/\bHTTP (\d{3})\b/u.exec(failure?.message || '')?.[1]);
  if (status >= 400) return status === 408 || status === 429 || status >= 500 && status <= 599;
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE'].includes(failure?.code || '')
    || failure?.type === 'request-timeout'
    || /network timeout|socket hang up|connection reset/iu.test(failure?.message || '');
}

export async function retryBoundaryRequest<T>(io: {
  available(): boolean;
  request(attempt: number): Promise<T>;
  wait(ms: number): Promise<void>;
  failed(error: unknown, attempt: number, delayMs: number): void;
}): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!io.available()) throw new Error('Per-stream AI budget reached');
    try { return await io.request(attempt); }
    catch (error) {
      const delayMs = attempt < 3 && io.available() && transientActivityFailure(error)
        ? (attempt === 1 ? 2000 : 8000) : 0;
      io.failed(error, attempt, delayMs);
      if (!delayMs) throw error;
      await io.wait(delayMs);
    }
  }
  throw new Error('Activity transport retry exhausted');
}
