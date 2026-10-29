import * as path from 'path';
import { spawnPython } from '../../utils/pythonProcess';
import { MainReplyIntent, PublishCommentResponse } from './interfaces/types';

/** One bounded, read-only lookup; ongoing retries belong to the delayed task scheduler. */
export async function recoverCommentReceipt(intent: MainReplyIntent,
  credentials: { session: string; csrf: string; uid: string; payload: string }): Promise<PublishCommentResponse | undefined> {
  if (intent.request.replyToId !== undefined) return undefined;
  const args = [path.join(process.cwd(), 'src/scripts/bilibili_comment_receipt.py'),
    intent.request.dynamicId, intent.request.content, credentials.session, credentials.csrf, credentials.uid,
    String(intent.startedAt), intent.request.images?.length ? '1' : '0', credentials.payload];
  return new Promise(resolve => {
    const child = spawnPython(args, { windowsHide: true });
    let stdout = '', settled = false;
    const finish = (receipt?: PublishCommentResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(receipt);
    };
    const timer = setTimeout(() => { child.kill(); finish(); }, 30000);
    child.stdout.on('data', data => {
      if (settled) return;
      stdout += data.toString('utf8');
      if (stdout.length > 64 * 1024) { child.kill(); finish(); }
    });
    child.stderr.resume(); // Diagnostic text may contain credentials; never forward it to UI/logs.
    child.on('error', () => finish());
    child.on('close', code => {
      if (code !== 0) return finish();
      try {
        const value = JSON.parse(stdout.trim()), receipt = value.receipt;
        if (value.status === 'found' && typeof receipt?.replyId === 'string' && /^[1-9]\d*$/u.test(receipt.replyId)
          && Number.isFinite(receipt.replyTime) && receipt.replyTime >= intent.startedAt - 5000
          && receipt.replyTime <= intent.startedAt + 120000) return finish(receipt);
      } catch { /* A malformed response is an unavailable lookup, never permission to repost. */ }
      finish();
    });
  });
}
