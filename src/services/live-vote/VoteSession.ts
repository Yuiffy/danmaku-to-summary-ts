export interface VoteDanmaku {
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
  labels: [string, string];
  startedAt: number;
  deadline: number;
  nextUpdate: number;
  votes: Map<string, 1 | 2>;
}

const DEFAULT_DURATION = 30;
const SETTLE_MS = 3000;
const MAX_COMMAND_LAG_MS = 10000;

export function parseVoteCommand(text: string): { duration: number; labels: [string, string] } | null {
  const normalized = text.normalize('NFKC').trim();
  const prefix = /^#投票\s*(?:(\d{2,3})\s+)?1[.、:：]?\s*/u.exec(normalized);
  if (!prefix) return null;
  const duration = prefix[1] ? Number(prefix[1]) : DEFAULT_DURATION;
  if (duration < 30 || duration > 120) return null;
  const rest = normalized.slice(prefix[0].length);
  const separator = /\s+2[.、:：]?\s*/u.exec(rest);
  if (!separator || separator.index === undefined) return null;
  const first = rest.slice(0, separator.index).trim();
  const second = rest.slice(separator.index + separator[0].length).trim();
  if (!first || !second || first.length > 16 || second.length > 16 || /[\r\n]/u.test(normalized)) return null;
  return { duration, labels: [first, second] };
}

export function parseVoteChoice(text: string): 1 | 2 | null {
  const value = text.normalize('NFKC').trim();
  if (/^1+$/u.test(value)) return 1;
  if (/^2+$/u.test(value)) return 2;
  return null;
}

export class VoteSession {
  private active: ActiveVote | null = null;
  private readonly authorized: Set<string>;
  private readonly maxChars: number;

  constructor(private readonly config: VoteConfig, private readonly announce: (message: string) => void,
    private readonly onCancel: () => void = () => {}) {
    this.authorized = new Set(config.authorizedUids);
    this.maxChars = config.maxMessageChars ?? 20;
    if (!this.authorized.size || !Number.isInteger(this.maxChars) || this.maxChars < 20 || this.maxChars > 40)
      throw new Error('authorizedUids and maxMessageChars between 20 and 40 are required');
  }

  ingest(message: VoteDanmaku, now = Date.now()): void {
    if (!/^\d+$/u.test(message.uid) || message.uid === this.config.botUid) return;
    const text = message.text.normalize('NFKC').trim();
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
      if (!command) return;
      const first = `投票${command.duration}秒：发1投${command.labels[0]}`;
      const second = `发2投${command.labels[1]}`;
      if ([first, second].some(text => Array.from(text).length > this.maxChars)) {
        this.emit('投票选项太长，请缩短后重试');
        return;
      }
      this.active = {
        labels: command.labels,
        startedAt: now,
        deadline: now + command.duration * 1000,
        nextUpdate: now + 10000,
        votes: new Map()
      };
      this.emit(first);
      this.emit(second);
      return;
    }
    const vote = this.active;
    if (!vote || now > vote.deadline + SETTLE_MS || message.sentAt > vote.deadline || message.sentAt < vote.startedAt) return;
    const choice = parseVoteChoice(text);
    if (choice && !vote.votes.has(message.uid)) vote.votes.set(message.uid, choice);
  }

  tick(now = Date.now()): void {
    const vote = this.active;
    if (!vote) return;
    if (now >= vote.deadline + SETTLE_MS) {
      const [one, two] = this.count(vote);
      this.active = null;
      const result = one === two ? '平票' : `${one > two ? 1 : 2}胜`;
      this.emitCounts(`结束 1:${one}票 2:${two}票 ${result}`, one, two);
    } else if (now >= vote.nextUpdate && now < vote.deadline) {
      const [one, two] = this.count(vote);
      vote.nextUpdate += (Math.floor((now - vote.nextUpdate) / 10000) + 1) * 10000;
      this.emitCounts(`票型 1:${one}票 2:${two}票`, one, two);
    }
  }

  cancel(): void {
    if (this.active) {
      this.active = null;
      this.onCancel();
    }
  }

  private count(vote: ActiveVote): [number, number] {
    let one = 0;
    let two = 0;
    for (const choice of vote.votes.values()) choice === 1 ? one++ : two++;
    return [one, two];
  }

  private emitCounts(text: string, one: number, two: number): void {
    if (Array.from(text).length <= this.maxChars) {
      this.emit(text);
    } else {
      this.emit(text.startsWith('结束') ? '投票结束' : '当前票型');
      this.emit(`1:${one}票`);
      this.emit(`2:${two}票`);
    }
  }

  private emit(text: string): void {
    if (Array.from(text).length > this.maxChars) throw new Error('Vote announcement exceeds maxMessageChars');
    this.announce(text);
  }
}
