import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { AdminJob } from '../../core/admin/contracts';
import { OperatorCommand } from './AdminCommandPolicy';
import { AdminError, atomicJson, readJson } from './AdminFiles';
import { deepMerge, findConfigPaths, readJsonObject } from '../../core/config/ConfigLayers';

export type CommandRunner = (command: OperatorCommand, output: (chunk: string) => void) => Promise<number>;
export function createCommandRunner(root: string, python = 'python'): CommandRunner {
  return async (command, output) => {
    let configFile: string | undefined;
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', PYTHONIOENCODING: 'utf-8' };
    if (command.reviewOnly) {
      const original = findConfigPaths({ root, env })[0];
      if (!original) throw new AdminError('制作流程需要现有生产配置');
      configFile = path.join(root, 'data/runtime/admin/command-configs', `${randomUUID()}.json`);
      atomicJson(configFile, deepMerge(readJsonObject(original), {
        streamActivityClips: { automaticPublication: { mode: 'off' }, notify: { enabled: false } },
        streamGameClips: { autoUpload: false, authorizationNote: '', notify: { enabled: false } }
      }));
      env.CONFIG_PATH = configFile;
    }
    try { return await new Promise<number>((resolve, reject) => {
    const child = spawn(command.executable === 'node' ? process.execPath : python, command.args, {
      cwd: root, shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.once('error', reject); child.once('close', code => resolve(code ?? 1));
    }); } finally { if (configFile) fs.rmSync(configFile, { force: true }); }
  };
}

/** Serialized operator commands, independent of the existing media/upload workers. */
export class AdminJobs {
  private readonly jobs = new Map<string, AdminJob>();
  private tail = Promise.resolve();
  private pending = 0;
  constructor(private readonly directory: string, private readonly run: CommandRunner) {
    if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory).filter(name => /^[0-9a-f-]{36}\.json$/u.test(name))) {
      const job = readJson(path.join(directory, name)) as AdminJob;
      if (['running', 'queued'].includes(job.status)) {
        job.status = 'interrupted'; job.output += '\n管理进程中断；请核对已有结果后再提交操作，不自动重试。';
        atomicJson(path.join(directory, name), job);
      }
      this.jobs.set(job.id, job);
    }
  }
  list(): AdminJob[] { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100); }
  submit(command: OperatorCommand, validate = () => {}): AdminJob {
    if (this.pending >= 20) throw new AdminError('管理操作队列已满', 429);
    const now = new Date().toISOString(), job: AdminJob = { id: randomUUID(), action: command.action, target: command.target,
      status: 'queued', createdAt: now, updatedAt: now, output: '' };
    this.jobs.set(job.id, job); this.persist(job); this.pending++;
    this.tail = this.tail.then(async () => {
      try {
        validate(); job.status = 'running'; this.persist(job);
        const code = await this.run(command, chunk => {
          job.output = (job.output + chunk.replace(/(bili_jct|SESSDATA|api[_-]?key|access_token)([=:]\s*)[^\s;,]+/giu, '$1$2[hidden]')).slice(-24000);
          this.persist(job);
        });
        job.exitCode = code; job.status = code === 0 ? 'succeeded' : 'failed';
      } catch (error) {
        job.status = 'failed'; job.output += `\n${error instanceof Error ? error.message : '操作失败'}`;
      } finally { this.pending--; this.persist(job); }
    });
    return structuredClone(job);
  }
  private persist(job: AdminJob): void {
    job.updatedAt = new Date().toISOString(); atomicJson(path.join(this.directory, `${job.id}.json`), job);
  }
  async flush(): Promise<void> { await this.tail; }
}
