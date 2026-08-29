import { spawn, SpawnOptionsWithoutStdio, ChildProcessWithoutNullStreams } from 'child_process';

export function buildPythonEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  };
}

export function spawnPython(
  args: string[],
  options: SpawnOptionsWithoutStdio = {}
): ChildProcessWithoutNullStreams {
  return spawn('python', args, {
    ...options,
    windowsHide: true,
    shell: false,
    env: buildPythonEnv(options.env)
  });
}
