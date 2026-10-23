import * as fs from 'fs/promises';

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error; // Permission errors and uncertain ownership cannot authorize reclamation.
  }
}

/** Serialize dead-owner reclamation; a live, malformed or uninspectable owner always retains its lock. */
export async function openCommentOwnerLock(file: string, botUid: string, isAlive = processExists): Promise<fs.FileHandle> {
  try { return await fs.open(file, 'wx'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const guard = await fs.open(`${file}.recovery`, 'wx');
  try {
    let owner;
    try { owner = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return await fs.open(file, 'wx');
      throw error;
    }
    if (owner?.botUid !== botUid || !Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || isAlive(owner.pid)) {
      throw Object.assign(new Error('Comment state owner cannot be reclaimed'), { code: 'EEXIST' });
    }
    await fs.unlink(file);
    // Another ordinary opener can win here, but the recovery guard prevents a second stale reader deleting its lock.
    return await fs.open(file, 'wx');
  } finally { await guard.close(); await fs.unlink(`${file}.recovery`); }
}
