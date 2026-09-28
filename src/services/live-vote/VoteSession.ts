export interface VoteDanmaku {
  roomId?: string;
  uid: string;
  text: string;
  sentAt: number;
}

export interface VoteConfig {
  authorizedUids: string[];
  botUid?: string;
  maxMessageChars?: number;
}

type VoteNumbering = 'number' | 'letter';

interface ActiveVote {
  labels: string[];
  keys: string[];
  startedAt: number;
  deadline: number;
  nextUpdate: number;
  votes: Map<string, number>;
}

const DEFAULT_DURATION = 30;
const SETTLE_MS = 3000;
const MAX_COMMAND_LAG_MS = 10000;

export function parseVoteCommand(text: string): { duration: number; labels: string[]; keys: string[]; numbering: VoteNumbering } | null {
  const normalized = text.normalize('NFKC').trim();
  if (/[\r\n]/u.test(normalized)) return null;
  const prefix = /^#投票\s*(?:(\d{2,3})\s+)?/u.exec(normalized);
  if (!prefix) return null;
  const duration = prefix[1] ? Number(prefix[1]) : DEFAULT_DURATION;
  if (duration < 30 || duration > 120) return null;
  const rest = normalized.slice(prefix[0].length);
  // Do not mistake the first letter of an English word for an option marker.
  const markers = [...rest.matchAll(/(?:^|\s+)(\d+|[a-z](?![a-z]))[.、:：]?/giu)];
  if (markers.length < 2 || markers.length > 9 || markers[0].index !== 0) return null;
  const numbering: VoteNumbering = /^[a-z]$/iu.test(markers[0][1]) ? 'letter' : 'number';
  const keys = markers.map(marker => marker[1].toUpperCase());
  const keyPattern = numbering === 'letter' ? /^[A-I]$/u : /^[1-9]$/u;
  if (keys.some(key => !keyPattern.test(key)) || new Set(keys).size !== keys.length) return null;
  const labels: string[] = [];
  for (const [index, marker] of markers.entries()) {
    const label = rest.slice(marker.index! + marker[0].length, markers[index + 1]?.index ?? rest.length).trim();
    if (!label || Array.from(label).length > 16) return null;
    labels.push(label);
  }
  return { duration, labels, keys, numbering };
}

export function parseVoteChoice(text: string, optionCount = 9, keys = Array.from({ length: optionCount }, (_, i) => String(i + 1))): number | null {
  const value = text.normalize('NFKC').trim().toUpperCase();
  const match = /^([1-9A-I])\1*$/u.exec(value);
  if (!match) return null;
  // Counts use positions, while public keys may be a subset such as B and C.
  const index = keys.indexOf(match[1]);
  return index >= 0 && index < optionCount ? index + 1 : null;
}

export class VoteSession {
  private active: ActiveVote | null = null;
  private readonly authorized: Set<string>;
  private readonly maxChars: number;

  constructor(private readonly config: VoteConfig, private readonly announce: (message: string) => void,
    private readonly onCancel: () => void = () => {}) {
    this.authorized = new Set(config.authorizedUids);
    this.maxChars = config.maxMessageChars ?? 40;
    if (!this.authorized.size || !Number.isInteger(this.maxChars) || this.maxChars < 20 || this.maxChars > 40)
      throw new Error('authorizedUids and maxMessageChars between 20 and 40 are required');
  }

  ingest(message: VoteDanmaku, now = Date.now()): void {
    if (!/^[1-9]\d*$/u.test(message.uid) || message.uid === this.config.botUid) return;
    const text = message.text.normalize('NFKC').trim();
    if (this.authorized.has(message.uid) && text === '#结束投票') {
      const vote = this.active;
      if (!vote || !Number.isFinite(message.sentAt) || message.sentAt < vote.startedAt ||
          Math.abs(now - message.sentAt) > MAX_COMMAND_LAG_MS) return;
      // Discard queued progress before enqueuing the final tally.
      this.cancel();
      this.emitCounts(vote, true);
      return;
    }
    if (this.authorized.has(message.uid) && text === '#取消投票') {
      if (this.active) {
        this.active = null;
        this.onCancel();
        this.emit('投票已取消');
      }
      return;
    }
    if (this.authorized.has(message.uid) && text.startsWith('#投票')) {
      if (this.active || Math.abs(now - message.sentAt) > MAX_COMMAND_LAG_MS) return;
      const command = parseVoteCommand(text);
      if (!command) {
        this.emit('格式有误，用1-9或A-I，勿重复');
        return;
      }
      this.active = {
        labels: command.labels,
        keys: command.keys,
        startedAt: now,
        deadline: now + command.duration * 1000,
        nextUpdate: now + 10000,
        votes: new Map()
      };
      this.emitPacked(`投票${command.duration}秒，发${command.numbering === 'letter' ? '字母' : '序号'}：`,
        command.labels.map((label, index) => `${command.keys[index]}.${label}`));
      return;
    }
    const vote = this.active;
    if (!vote || now > vote.deadline + SETTLE_MS || message.sentAt > vote.deadline || message.sentAt < vote.startedAt) return;
    const choice = parseVoteChoice(text, vote.labels.length, vote.keys);
    if (choice && !vote.votes.has(message.uid)) vote.votes.set(message.uid, choice);
  }

  tick(now = Date.now()): void {
    const vote = this.active;
    if (!vote) return;
    if (now >= vote.deadline + SETTLE_MS) {
      this.active = null;
      this.emitCounts(vote, true);
    } else if (now >= vote.nextUpdate && now < vote.deadline) {
      vote.nextUpdate += (Math.floor((now - vote.nextUpdate) / 10000) + 1) * 10000;
      this.emitCounts(vote, false, Math.ceil((vote.deadline - now) / 1000));
    }
  }

  cancel(): void {
    if (this.active) {
      this.active = null;
      this.onCancel();
    }
  }

  private count(vote: ActiveVote): number[] {
    const counts = vote.labels.map(() => 0);
    for (const choice of vote.votes.values()) counts[choice - 1]++;
    return counts;
  }

  private emitCounts(vote: ActiveVote, final: boolean, remainingSeconds?: number): void {
    const counts = this.count(vote);
    const parts = vote.labels.flatMap((label, index) => {
      const key = vote.keys[index];
      const text = `${key}.${label}:${counts[index]}票`;
      // A lower account limit may require separating a long label from its count.
      return Array.from(text).length <= this.maxChars ? [text] : [`${key}.${label}`, `${key}号：${counts[index]}票`];
    });
    if (final) {
      const highest = Math.max(...counts);
      const winners = counts.map((count, index) => count === highest ? index : -1).filter(index => index >= 0);
      if (highest === 0) parts.push('无人投票');
      else if (winners.length === 1) parts.push(`【${vote.labels[winners[0]]}】胜~`);
      else {
        const tie = `【${winners.map(index => vote.labels[index]).join('和')}平票】`;
        if (Array.from(tie).length <= this.maxChars) parts.push(tie);
        else parts.push(...winners.map(index => `【${vote.labels[index]}】`), '平票');
      }
    }
    if (!final && remainingSeconds !== undefined) {
      const timed = `剩余${remainingSeconds}秒~${parts.join(' ')}`;
      if (Array.from(timed).length <= this.maxChars) {
        this.emit(timed);
        return;
      }
    }
    this.emitPacked(final ? '结束：' : '票型：', parts);
  }

  private emitPacked(prefix: string, parts: string[]): void {
    let line = prefix;
    for (const part of parts) {
      const next = line === prefix ? line + part : `${line} ${part}`;
      if (Array.from(next).length <= this.maxChars) line = next;
      else {
        if (line) this.emit(line);
        line = Array.from(prefix + part).length <= this.maxChars ? prefix + part : part;
      }
    }
    if (line) this.emit(line);
  }

  private emit(text: string): void {
    if (Array.from(text).length > this.maxChars) throw new Error('Vote announcement exceeds maxMessageChars');
    this.announce(text);
  }
}
