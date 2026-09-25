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

interface ActiveVote {
  labels: string[];
  startedAt: number;
  deadline: number;
  nextUpdate: number;
  votes: Map<string, number>;
}

const DEFAULT_DURATION = 30;
const SETTLE_MS = 3000;
const MAX_COMMAND_LAG_MS = 10000;

export function parseVoteCommand(text: string): { duration: number; labels: string[] } | null {
  const normalized = text.normalize('NFKC').trim();
  if (/[\r\n]/u.test(normalized)) return null;
  const prefix = /^#投票\s*(?:(\d{2,3})\s+)?/u.exec(normalized);
  if (!prefix) return null;
  const duration = prefix[1] ? Number(prefix[1]) : DEFAULT_DURATION;
  if (duration < 30 || duration > 120) return null;
  const rest = normalized.slice(prefix[0].length);
  const markers = [...rest.matchAll(/(?:^|\s+)(\d+)[.、:：]?/gu)];
  if (markers.length < 2 || markers.length > 9 || markers[0].index !== 0) return null;
  const labels: string[] = [];
  for (const [index, marker] of markers.entries()) {
    if (marker[1] !== String(index + 1)) return null;
    const label = rest.slice(marker.index! + marker[0].length, markers[index + 1]?.index ?? rest.length).trim();
    if (!label || Array.from(label).length > 16) return null;
    labels.push(label);
  }
  return { duration, labels };
}

export function parseVoteChoice(text: string, optionCount = 9): number | null {
  const value = text.normalize('NFKC').trim();
  const match = /^([1-9])\1*$/u.exec(value);
  return match && Number(match[1]) <= optionCount ? Number(match[1]) : null;
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
        this.emit('投票格式有误，请连续编号1至9');
        return;
      }
      this.active = {
        labels: command.labels,
        startedAt: now,
        deadline: now + command.duration * 1000,
        nextUpdate: now + 10000,
        votes: new Map()
      };
      this.emitPacked(`投票${command.duration}秒，发序号：`, command.labels.map((label, index) => `${index + 1}.${label}`));
      return;
    }
    const vote = this.active;
    if (!vote || now > vote.deadline + SETTLE_MS || message.sentAt > vote.deadline || message.sentAt < vote.startedAt) return;
    const choice = parseVoteChoice(text, vote.labels.length);
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
      this.emitCounts(vote, false);
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

  private emitCounts(vote: ActiveVote, final: boolean): void {
    const counts = this.count(vote);
    const parts = vote.labels.flatMap((label, index) => {
      const text = `${index + 1}.${label}:${counts[index]}票`;
      // A lower account limit may require separating a long label from its count.
      return Array.from(text).length <= this.maxChars ? [text] : [`${index + 1}.${label}`, `${index + 1}号：${counts[index]}票`];
    });
    if (final) {
      const highest = Math.max(...counts);
      const winners = counts.map((count, index) => count === highest ? index : -1).filter(index => index >= 0);
      parts.push(highest === 0 ? '无人投票' : winners.length > 1 ? '平票' : `${vote.labels[winners[0]]}胜`);
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
