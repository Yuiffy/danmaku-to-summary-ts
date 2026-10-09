import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import fetch from 'node-fetch';
import { ConfigObject, loadConfigLayers } from '../../../core/config/ConfigLayers';
import { getProjectRoot } from '../../../core/config/ProjectPaths';
import { formatQuestionRecord, LiveQuestionConfig, QuestionRecord, QuestionRecordWriter } from '../../live-vote/questions/QuestionPolicy';

interface PublisherOptions {
  dynamicId: string;
  botUid: string;
  live: boolean;
  cookie: () => string;
  journalDirectory: string;
}
interface RecordJournal {
  schemaVersion: 1;
  state: 'ready' | 'publishing' | 'published' | 'failed' | 'unknown' | 'cancelled';
  dynamicId: string;
  roomId: string;
  askedAt: number;
  content: string;
  replyId?: string;
}

function object(value: unknown): ConfigObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ConfigObject : {};
}

function positiveId(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  return /^[1-9]\d*$/u.test(text) ? text : undefined;
}

export function questionSummaryDynamic(config: ConfigObject): string {
  const summary = object(object(object(config.bilibili).delayedReply).summaryDynamic);
  const id = positiveId(summary.dynamicId);
  if (summary.enabled !== true || !id) throw new Error('Configure bilibili.delayedReply.summaryDynamic for question records');
  return id;
}

/** Application-only writer to one configured summary dynamic. Never an agent tool. */
export class QuestionRecordPublisher {
  constructor(private readonly options: PublisherOptions, private readonly transport = fetch) {
    if (!positiveId(options.dynamicId) || !positiveId(options.botUid) || !path.isAbsolute(options.journalDirectory)) {
      throw new Error('Invalid question record publisher configuration');
    }
  }

  async publish(record: QuestionRecord, parentSignal: AbortSignal, isCurrent: () => boolean): Promise<void> {
    if (parentSignal.aborted || !isCurrent()) return;
    const content = formatQuestionRecord(record);
    if (!Number.isFinite(record.request.askedAt) || !positiveId(record.request.roomId) || content.length > 2000) {
      throw new Error('Invalid question record');
    }
    if (!this.options.live) {
      console.log(`[dry-run question record dynamic ${this.options.dynamicId}] ${content}`);
      return;
    }
    const id = createHash('sha256').update(JSON.stringify(record.request)).digest('hex');
    const file = path.join(this.options.journalDirectory, `${id}.json`);
    const journal: RecordJournal = {
      schemaVersion: 1, state: 'ready', dynamicId: this.options.dynamicId,
      roomId: record.request.roomId, askedAt: record.request.askedAt!, content
    };
    await fs.mkdir(this.options.journalDirectory, { recursive: true });
    try { await fs.writeFile(file, JSON.stringify(journal), { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw new Error('Could not save question record intent'); }
    const save = async () => {
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(journal), 'utf8');
      await fs.rename(temporary, file);
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal.addEventListener('abort', abort, { once: true });
    if (parentSignal.aborted) abort();
    const timeout = setTimeout(abort, 30000);
    const checkCurrent = () => {
      if (controller.signal.aborted || !isCurrent()) throw new Error('Question record cancelled');
    };
    try {
      checkCurrent();
      const cookie = this.options.cookie();
      const uid = /(?:^|;\s*)DedeUserID=(\d+)/u.exec(cookie)?.[1];
      const csrf = /(?:^|;\s*)bili_jct=([^;]+)/u.exec(cookie)?.[1];
      if (uid !== this.options.botUid || !csrf || !/(?:^|;\s*)SESSDATA=/u.test(cookie)) throw new Error('Invalid question record credentials');
      const headers = { Cookie: cookie, Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' };
      const detail = await this.transport(`https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${this.options.dynamicId}`, {
        headers, signal: controller.signal as any, redirect: 'error', timeout: 15000, size: 128 * 1024
      });
      if (!detail.ok) throw new Error('Summary dynamic lookup failed');
      const result = await detail.json() as any;
      const item = result?.data?.item;
      const oid = positiveId(item?.basic?.comment_id_str);
      const type = item?.basic?.comment_type;
      if (result?.code !== 0 || !oid || ![1, 11, 12, 17].includes(type) ||
          positiveId(item?.id_str) !== this.options.dynamicId ||
          positiveId(item?.modules?.module_author?.mid) !== this.options.botUid) throw new Error('Summary dynamic identity mismatch');
      checkCurrent();
      journal.state = 'publishing';
      await save(); // Persist before POST so restarts/uncertain responses cannot duplicate comments.
      checkCurrent();
      const body = new URLSearchParams({ oid, type: String(type), message: content,
        root: '0', parent: '0', plat: '1', csrf, csrf_token: csrf });
      const response = await this.transport('https://api.bilibili.com/x/v2/reply/add', {
        method: 'POST', body, headers, signal: controller.signal as any, redirect: 'error', timeout: 15000, size: 128 * 1024
      });
      if (!response.ok) throw new Error('Question record publish failed');
      const data = await response.json() as any;
      const replyId = positiveId(data?.data?.rpid_str) || positiveId(data?.data?.rpid);
      if (data?.code !== 0 || !replyId) throw new Error('Question record publication unconfirmed');
      journal.state = 'published'; journal.replyId = replyId;
      await save();
    } catch {
      if (journal.state === 'publishing') journal.state = 'unknown';
      else if (journal.state !== 'published') journal.state = parentSignal.aborted || !isCurrent() ? 'cancelled' : 'failed';
      try { await save(); } catch { /* Keep the prior intent; never resend automatically. */ }
      throw new Error('Question record publication not confirmed');
    } finally {
      clearTimeout(timeout);
      parentSignal.removeEventListener('abort', abort);
    }
  }
}

export function createQuestionRecordWriter(config: LiveQuestionConfig, botUid: string, live: boolean,
  cookie: () => string): QuestionRecordWriter {
  let dynamicId: string;
  try { dynamicId = questionSummaryDynamic(loadConfigLayers({ configPath: config.providerConfigPath })); }
  catch { throw new Error('Could not load configured summary dynamic for question records'); }
  const publisher = new QuestionRecordPublisher({ dynamicId, botUid, live, cookie,
    journalDirectory: path.join(getProjectRoot(), 'data', 'runtime', 'live-question-records') });
  return (record, signal, current) => publisher.publish(record, signal, current);
}
