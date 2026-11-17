import type { AdminAIVideoCreditUsage } from '../../core/admin/aiVideoQueue';
import { digest } from './AdminFiles';

/** Quotes measure submitted usage ceilings, never final charges or refunds. */
export function aiVideoCreditUsage(tasks: any[]): AdminAIVideoCreditUsage[] {
  const users = new Map<string, AdminAIVideoCreditUsage>();
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!/^[1-9]\d{0,24}$/u.test(task.qq?.app) || !/^[a-f0-9]{64}$/u.test(task.qq?.user)) continue;
    const key = digest(JSON.stringify([task.qq.app, task.qq.user]));
    let user = users.get(key);
    if (!user) {
      user = { key, tasks: 0, completed: 0, submittedCredits: 0, uncertainCredits: 0, unpricedTasks: 0 };
      users.set(key, user);
    }
    const name = typeof task.qq_sender_name === 'string' ? task.qq_sender_name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 80) : '';
    if (name) user.senderName = name;
    const identity = `${key}:${task.canvas?.submitId || task.id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    user.tasks++;
    if (task.status === 'completed') user.completed++;
    const usage = task.credit_usage;
    if (usage && usage.submit_id === task.canvas?.submitId && Number.isSafeInteger(usage.quoted_credits) && usage.quoted_credits >= 0 &&
      ['quoted', 'intent', 'accepted', 'rejected'].includes(usage.run_state)) {
      if (usage.run_state === 'accepted' || usage.run_state === 'intent' && task.status === 'completed') user.submittedCredits += usage.quoted_credits;
      else if (usage.run_state === 'intent') user.uncertainCredits += usage.quoted_credits;
    } else if (!['draft', 'cancelled'].includes(task.status)) user.unpricedTasks++;
  }
  return [...users.values()].sort((a, b) => b.submittedCredits - a.submittedCredits || a.key.localeCompare(b.key));
}
