import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { parseComments } from '../clipping/radioDanmaku';
import { buildPrompt, Evidence, formatPlans, MAX_OUTPUT_TOKENS, Memory, queryPlans, responseFormat, selectEvidence, summarizeUsage, validateExtraction, validatePlans, VERSION } from './policy';

interface Session { roomId: string; startedAt: string; title?: string; sessionId: string; }
interface Options {
  root: string; config: Record<string, any>; session: Session; srtPath?: string; xmlPath?: string;
  dynamics?: Array<{ id: string; content: string; publishTime: string }>;
}
interface Generate { (prompt: string, options: Record<string, any>): Promise<{ text: string; meta?: unknown }> }
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const settings = (config: Record<string, any>) => config.ai?.itineraryMemory || {};
const registry = (config: Record<string, any>) => config.ai?.streamerRegistry || {};
function hostFor(config: Record<string, any>, room: string): string | undefined {
  return Object.keys(registry(config)).find(id => (registry(config)[id].roomIds || []).map(String).includes(String(room)));
}
export function enabled(config: Record<string, any>, room: string): boolean {
  const cfg = settings(config), host = hostFor(config, room);
  return cfg.enabled === true && !!host && (cfg.scope === 'all' || (cfg.streamerIds || []).includes(host));
}
function directory(options: Pick<Options, 'root' | 'config'>) {
  return path.resolve(options.root, settings(options.config).directory || 'data/runtime/itinerary-memory');
}
function atomic(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function acquire(file: string): boolean {
  try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); return true; }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return false; }
    catch (probe: any) {
      if (probe.code !== 'ESRCH') return false;
      fs.unlinkSync(file); return acquire(file);
    }
  }
}
function seconds(stamp: string): number {
  const parts = stamp.replace(',', '.').split(':').map(Number);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}
/** IO only. Every accepted quote remains tied to the complete source digest and original offset/time. */
export async function collectEvidence(options: Options) {
  const { session } = options, rows: Evidence[] = [], inputs: Record<string, string> = {};
  const start = Date.parse(session.startedAt);
  if (!Number.isFinite(start)) throw new Error('itinerary_session_time_missing');
  const add = (id: string, kind: Evidence['kind'], text: string, observedAt: string, source: string, offsetSeconds?: number) => {
    if (text.trim()) rows.push({ id, kind, text: text.trim(), observedAt, source, ...(offsetSeconds == null ? {} : { offsetSeconds }) });
  };
  if (session.title) add('H1', 'title', session.title, session.startedAt, session.sessionId);
  for (const item of options.dynamics || []) {
    if (!Number.isFinite(Date.parse(item.publishTime))) continue;
    add(`P${item.id}`, 'dynamic', item.content, item.publishTime, `https://t.bilibili.com/${item.id}`);
  }
  if (options.srtPath) {
    const content = fs.readFileSync(options.srtPath, 'utf8'); inputs[options.srtPath] = hash(content);
    const pattern = /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->[^\r\n]*\r?\n([\s\S]*?)(?=\r?\n\s*\r?\n|$)/gu;
    let index = 0;
    for (const m of content.matchAll(pattern)) {
      const offset = seconds(m[1]);
      add(`T${++index}`, 'subtitle', m[2].replace(/\r?\n/gu, ' '), new Date(start + offset * 1000).toISOString(), options.srtPath, offset);
    }
  }
  if (options.xmlPath && fs.existsSync(options.xmlPath)) {
    const content = fs.readFileSync(options.xmlPath, 'utf8'); inputs[options.xmlPath] = hash(content);
    const parsed = await parseComments(content);
    for (const [index, row] of parsed.entries()) {
      const offset = row.time;
      add(`D${index + 1}`, 'danmaku', row.text, new Date(start + offset * 1000).toISOString(), options.xmlPath, offset);
    }
  }
  return { rows, inputs };
}

export async function estimateSession(options: Options) {
  const collected = await collectEvidence(options), selected = selectEvidence(collected.rows, registry(options.config));
  const prompt = selected.rows.length ? buildPrompt(selected.rows, registry(options.config), options.session.roomId) : '';
  return { enabled: enabled(options.config, options.session.roomId), scannedRows: selected.scanned,
    matchedRows: selected.matched, sentRows: selected.rows.length, truncated: selected.truncated,
    fullTextChars: collected.rows.reduce((n, r) => n + r.text.length, 0), promptChars: prompt.length,
    estimatedInputTokens: Math.ceil(prompt.length * 1.5), inputUtf8Bytes: Buffer.byteLength(prompt),
    maxOutputTokens: prompt ? MAX_OUTPUT_TOKENS : 0, estimateMethod: '1.5 tokens per UTF-16 character; UTF-8 bytes also reported as an upper bound' };
}

/** Read-only accounting; provider attempts are preserved verbatim in per-session receipts. */
export function usageReport(options: Pick<Options, 'root' | 'config'>) {
  const dir = path.join(directory(options), 'receipts');
  const receipts: Record<string, any>[] = [];
  if (fs.existsSync(dir)) for (const file of fs.readdirSync(dir).filter(f => /^[a-f0-9]{64}-[a-f0-9]{64}\.json$/u.test(f))) {
    try { receipts.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))); } catch { /* Show healthy receipts. */ }
  }
  return { scope: settings(options.config).scope, streamerIds: settings(options.config).streamerIds,
    configuredRooms: Object.keys(options.config.ai?.roomSettings || {}).length,
    totals: summarizeUsage(receipts),
    receipts: receipts.map(r => ({ sourceRoom: r.sourceRoom, startedAt: r.session?.startedAt, status: r.status,
      plans: r.plans?.length || 0, coverage: r.coverage, usage: r.usage || null, generation: r.generation || null })) };
}

/** Exactly one bounded request per source/config revision. A failure receipt prevents repeated paid retries. */
export async function learnPlans(options: Options, generate: Generate) {
  const { config, session } = options;
  if (!enabled(config, session.roomId)) return { status: 'disabled' };
  const cfg = settings(config), dir = directory(options);
  fs.mkdirSync(dir, { recursive: true });
  const sourceId = hash(path.resolve(session.sessionId));
  const file = path.join(dir, `${sourceId}.json`), lock = `${file}.lock`;
  if (!acquire(lock)) return { status: 'pending' };
  try {
    const collected = await collectEvidence(options);
    const fingerprint = hash(JSON.stringify({ version: VERSION, session, inputs: collected.inputs,
      dynamics: options.dynamics, registry: registry(config), cfg }));
    const receiptDirectory = path.join(dir, 'receipts');
    fs.mkdirSync(receiptDirectory, { recursive: true });
    const receiptFile = path.join(receiptDirectory, `${sourceId}-${fingerprint}.json`);
    const save = (receipt: unknown) => { atomic(receiptFile, receipt); atomic(file, receipt); };
    try {
      const previous = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      if (previous.fingerprint === fingerprint) { atomic(file, previous); return { ...previous, reused: true }; }
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const selected = selectEvidence(collected.rows, registry(config));
    const receipt: Record<string, any> = { version: VERSION, sourceId, sourceRoom: session.roomId, session, fingerprint,
      evidence: selected.rows, inputs: collected.inputs, plans: [], generatedAt: new Date().toISOString(),
      coverage: { scannedRows: selected.scanned, matchedRows: selected.matched, sentRows: selected.rows.length,
        truncated: selected.truncated, mode: 'local_cue_windows', fullTextChars: collected.rows.reduce((n, row) => n + row.text.length, 0) } };
    try {
      if (!selected.rows.length) { receipt.status = 'no_evidence'; save(receipt); return receipt; }
      const prompt = buildPrompt(selected.rows, registry(config), session.roomId);
      receipt.usage = { estimatedInputTokens: Math.ceil(prompt.length * 1.5), inputUtf8Bytes: Buffer.byteLength(prompt),
        maxOutputTokens: MAX_OUTPUT_TOKENS, model: cfg.model || 'gpt-6-luna', requests: 1 };
      // A crash/timeout after dispatch must not silently repeat a potentially charged request.
      receipt.status = 'outcome_unknown'; save(receipt);
      const result = await generate(prompt, { primaryModel: cfg.model || 'gpt-6-luna', maxTokens: MAX_OUTPUT_TOKENS,
        thinkingBudgetTokens: 512, reasoningEffort: 'low', timeoutMs: 120000, wordLimit: 1600,
        responseFormat: responseFormat(), strictEvaluation: true, fallbackModelsEnabled: false, transientMaxAttempts: 1 });
      receipt.generation = result.meta || null;
      receipt.responseText = result.text; receipt.responseSha256 = hash(result.text);
      const raw = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
      const extracted = validateExtraction(raw, selected.rows, registry(config));
      for (const [input, digest] of Object.entries(collected.inputs)) {
        if (hash(fs.readFileSync(input, 'utf8')) !== digest) throw new Error('itinerary_source_changed');
      }
      receipt.plans = extracted.plans; receipt.rejected = extracted.rejected;
      receipt.repairedCitations = extracted.repairedCitations;
      receipt.status = extracted.rejected.length && !extracted.plans.length ? 'failed' : 'success';
      if (receipt.status === 'failed') receipt.error = 'all_itinerary_proposals_rejected';
    } catch (error: any) {
      receipt.status = 'failed'; receipt.error = String(error.message).slice(0, 500);
      if (Array.isArray(error.attempts)) receipt.generation = { attempts: error.attempts };
    }
    save(receipt);
    return receipt;
  } finally { fs.unlinkSync(lock); }
}

/** Refresh the configured circle before voice discovery, including members who have not streamed recently. */
export async function refreshDynamics(options: Pick<Options, 'root' | 'config' | 'session'>, io: {
  fetch(roomId: string, asOf: string): Promise<{ dynamics: NonNullable<Options['dynamics']> }>;
  generate: Generate;
}) {
  if (!enabled(options.config, options.session.roomId)) return [];
  const results = [];
  const rooms = Object.values(registry(options.config)).flatMap((p: any) => (p.roomIds || []).slice(0, 1).map(String));
  for (const roomId of rooms.filter(room => enabled(options.config, room))) {
    try {
      const result = await io.fetch(roomId, options.session.startedAt);
      const dynamics = result.dynamics.filter(d => Number.isFinite(Date.parse(d.publishTime))
        && Date.parse(d.publishTime) <= Date.parse(options.session.startedAt));
      if (!dynamics.length) continue;
      const startedAt = new Date(Math.max(...dynamics.map(d => Date.parse(d.publishTime)))).toISOString();
      results.push(await learnPlans({ root: options.root, config: options.config, dynamics,
        session: { roomId, startedAt, sessionId: `itinerary-dynamics-${roomId}` } }, io.generate));
    } catch (error: any) { results.push({ sourceRoom: roomId, status: 'unavailable', error: String(error.message).slice(0, 200) }); }
  }
  return results;
}

export function recallPlans(options: Pick<Options, 'root' | 'config' | 'session'>) {
  if (!enabled(options.config, options.session.roomId)) return { plans: [], candidateIds: [], prompt: '' };
  const host = hostFor(options.config, options.session.roomId)!;
  const dir = directory(options), memories: Memory[] = [];
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter(f => /^[a-f0-9]{64}\.json$/u.test(f));
    for (const file of files) {
      try {
        const memory = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (memory.version !== VERSION || memory.status !== 'success' || !enabled(options.config, memory.sourceRoom)) continue;
        // Unknown identities, invalid dates, and altered citations cannot enter the downstream context.
        memory.plans = validatePlans({ plans: memory.plans }, memory.evidence, registry(options.config));
        memories.push(memory);
      } catch { /* A malformed receipt cannot provide identity or presence evidence. */ }
    }
  }
  const plans = queryPlans(memories, host, options.session.startedAt);
  const candidateIds = [...new Set(plans.filter(p => ['collaboration', 'meeting', 'stay'].includes(p.kind))
    .flatMap(p => p.participants))].filter(id => id !== host);
  return { plans, candidateIds, prompt: formatPlans(plans) };
}

/** Enrich an existing source-bound discovery without promoting a plan to attendance. */
export function augmentDiscovery(discovery: Record<string, any>, recalled: ReturnType<typeof recallPlans>, config: Record<string, any>) {
  const participants = [...discovery.participants];
  for (const id of recalled.candidateIds) {
    if (participants.some(p => p.streamerId === id)) continue;
    const p = registry(config)[id];
    if (!p) continue;
    participants.push({ streamerId: id, displayName: p.displayName || id, speakerLabels: p.speakerLabels || [],
      role: 'participant', status: 'candidate', planned: false, presence: 'historical_plan_only', evidence: [] });
  }
  const added = participants.filter(p => p.presence === 'historical_plan_only').map(p => p.streamerId);
  return { ...discovery, participants, itineraryMemory: recalled,
    candidateStreamerIds: [...new Set([...discovery.candidateStreamerIds, ...added])],
    rosterStreamerIds: [...new Set([...discovery.rosterStreamerIds, ...added])], constrainToRoster: false,
    ...(added.length && discovery.mode !== 'multi' && discovery.modeStatus !== 'confirmed'
      ? { mode: 'multi', modeStatus: 'candidate' } : {}) };
}
