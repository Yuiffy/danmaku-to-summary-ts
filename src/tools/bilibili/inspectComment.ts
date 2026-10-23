import { loadConfigLayers } from '../../core/config/ConfigLayers';
import { CommentVisibilityTarget, inspectCommentVisibility, validateVisibilityTarget } from '../../services/bilibili/comment-replies/CommentVisibility';

const USAGE = 'inspectComment --oid ID --type 1|11|12|17 --root ID --reply ID [--authenticated --config path]';
export function parseInspectCommentArgs(args: string[]): { target: CommentVisibilityTarget; config?: string } {
  const values = new Map<string, string>();
  let authenticated = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--authenticated' && !authenticated) authenticated = true;
    else if (['--oid', '--type', '--root', '--reply', '--config'].includes(key) &&
        !values.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) values.set(key, args[++i]);
    else throw new Error(USAGE);
  }
  if (authenticated !== values.has('--config') || !/^(1|11|12|17)$/u.test(values.get('--type') || '')) throw new Error(USAGE);
  const target = { oid: values.get('--oid')!, type: Number(values.get('--type')), root: values.get('--root')!, replyId: values.get('--reply')! };
  validateVisibilityTarget(target);
  return { target, ...(authenticated ? { config: values.get('--config') } : {}) };
}

export async function runInspectComment(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') { console.info(USAGE); return; }
  const options = parseInspectCommentArgs(args);
  let cookie: string | undefined;
  if (options.config) {
    const bilibili = loadConfigLayers({ configPath: options.config }).bilibili as { cookie?: unknown } | undefined;
    const value = bilibili?.cookie;
    if (typeof value !== 'string' || !/(?:^|;\s*)SESSDATA=[^;]+/u.test(value) ||
        !/(?:^|;\s*)DedeUserID=\d+/u.test(value)) throw new Error('Authenticated inspection needs a configured Bilibili account');
    cookie = value;
  }
  const result = await inspectCommentVisibility(options.target, { cookie });
  console.info(JSON.stringify(result, null, 2));
  if ([result.anonymous, result.authenticated].some(row => row && ['unavailable', 'truncated'].includes(row.status))) process.exitCode = 2;
}

if (require.main === module) runInspectComment(process.argv.slice(2)).catch(() => {
  console.error(`Comment inspection failed. Usage: ${USAGE}. No publication or state changes performed.`);
  process.exitCode = 1;
});
