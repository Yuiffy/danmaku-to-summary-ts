import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import type { RecorderStallDiagnosticsConfig } from '../../core/config/ConfigInterface';
import { getLogger } from '../../core/logging/LogManager';

export type RecorderLifecycleEventType =
  | 'StreamStarted'
  | 'SessionStarted'
  | 'FileOpening'
  | 'FileClosed'
  | 'StreamEnded'
  | 'SessionEnded';

export interface RecorderStallDiagnosticEvent {
  type: RecorderLifecycleEventType;
  observedAt: string;
  eventTimestamp?: string;
  sessionId?: string;
  recording?: boolean;
  streaming?: boolean;
  fileOpenTime?: string;
  fileCloseTime?: string;
  relativePath?: string;
}

export interface RecorderFileInventoryEntry {
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface RecorderLogEvidence {
  path: string;
  sizeBytes?: number;
  modifiedAt?: string;
  matchedLines: string[];
  error?: string;
}

export interface RecorderProcessInfo {
  processId: number;
  name?: string;
  executablePath?: string;
  commandLine?: string;
}

export interface RecorderProcessSnapshot {
  capturedAt: string;
  platform: string;
  processes: RecorderProcessInfo[];
  error?: string;
}

export interface RecorderDumpResult {
  requested: boolean;
  status: string;
  tool?: string;
  processId?: number;
  path?: string;
  sizeBytes?: number;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  analysis?: {
    status: string;
    path?: string;
    stdout?: string;
    stderr?: string;
  };
}

export interface RecorderStallDiagnosticSnapshot {
  roomId: string;
  roomName?: string;
  title?: string;
  sessionId?: string;
  sessionStartedAt?: string;
  observedAt: string;
  capturedAt: string;
  elapsedSeconds: number;
  reason: string;
  state?: Record<string, unknown>;
  events: RecorderStallDiagnosticEvent[];
  recordingRoot?: string;
  fileInventory: {
    entries: RecorderFileInventoryEntry[];
    truncated?: boolean;
    error?: string;
  };
  logEvidence: RecorderLogEvidence[];
  processSnapshot: RecorderProcessSnapshot;
  dump?: RecorderDumpResult;
  diagnosticDirectory: string;
  diagnosticFile: string;
  writeError?: string;
}

export interface RecorderStallDiagnosticsOptions {
  onSnapshot?: (snapshot: RecorderStallDiagnosticSnapshot) => Promise<void> | void;
  getState?: (roomId: string) => Record<string, unknown> | undefined;
  now?: () => Date;
  runCommand?: CommandRunner;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>;

interface RuntimeConfig {
  enabled: boolean;
  delayMs: number;
  outputDirectory: string;
  storageTempPath: string;
  recordingRoot: string;
  logDirectory?: string;
  includeProcessDump: boolean;
  analyzeDump: boolean;
  dumpTool: string;
  dumpToolPath?: string;
  dumpTimeoutMs: number;
  maxLogBytes: number;
  maxFileEntries: number;
}

interface DiagnosticContext {
  roomId: string;
  roomName?: string;
  title?: string;
  sessionId?: string;
  sessionStartedAt?: string;
  observedAt: Date;
  eventTime?: Date;
  events: RecorderStallDiagnosticEvent[];
  timer: NodeJS.Timeout;
  runtime: RuntimeConfig;
}

const DEFAULT_DELAY_SECONDS = 480;
const DEFAULT_MAX_LOG_BYTES = 256 * 1024;
const DEFAULT_MAX_FILE_ENTRIES = 300;
const DEFAULT_DUMP_TIMEOUT_MS = 180 * 1000;
const EVENT_TIMESTAMP_TOLERANCE_MS = 5 * 1000;
const RECENT_FILE_OPENING_TTL_MS = 15 * 60 * 1000;
const LOG_FILE_LIMIT = 8;
const LOG_LINE_LIMIT = 120;
const LOG_KEYWORDS = /SessionStarted|FileOpening|FileClosed|SessionEnded|StreamStarted|StreamEnded|开始接收直播流|新建录制文件|录制结束|连接直播服务器|推送直播开始|推送直播结束/i;
const RECORDING_EXTENSIONS = new Set(['.flv', '.mp4', '.mkv', '.ts', '.mov', '.m4a', '.aac', '.mp3', '.wav', '.xml', '.txt']);
const LOCAL_DUMP_TOOL_PATHS = [
  path.join('temp', 'recorder-diagnostics', 'tools', 'procdump', 'procdump64.exe'),
  path.join('temp', 'recorder-diagnostics', 'tools', 'procdump', 'procdump.exe'),
  path.join('tools', 'procdump', 'procdump64.exe'),
  path.join('tools', 'procdump', 'procdump.exe')
];
const MIN_VALID_DUMP_BYTES = 4;

function defaultRunCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise(resolve => {
    execFile(command, args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      const code = error && typeof (error as any).code === 'number'
        ? Number((error as any).code)
        : error
          ? 1
          : 0;
      resolve({
        exitCode: code,
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      });
    });
  });
}

function asString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function asDate(value: unknown): Date | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function safeComponent(value: unknown, fallback: string): string {
  const normalized = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return normalized || fallback;
}

function formatPathTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
}

function truncateText(value: unknown, maxLength = 4096): string {
  const text = String(value || '');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function getEventSessionId(payload: any): string | undefined {
  return asString(payload?.EventData?.SessionId);
}

function getRoomId(payload: any): string | undefined {
  return asString(payload?.EventData?.RoomId);
}

function getPayloadEventDate(payload: any): Date | undefined {
  return asDate(payload?.EventTimestamp);
}

function redactLogLine(line: string): string {
  return line
    .replace(/(access[_-]?token|refresh[_-]?token|authorization|cookie|sessdata|bili_jct|sign|signature|token|api[_-]?key)(\s*[=:]\s*)[^\s,&"']+/gi, '$1$2<redacted>')
    .replace(/(直播流地址|StreamUrl|stream_url)[^\r\n]*/gi, '$1 <redacted>');
}

export class RecorderStallDiagnostics {
  private static logger = getLogger('RecorderStallDiagnostics');
  private readonly contexts = new Map<string, DiagnosticContext>();
  private readonly recentFileOpenings = new Map<string, Date>();
  private readonly onSnapshot: (snapshot: RecorderStallDiagnosticSnapshot) => Promise<void> | void;
  private readonly getState?: (roomId: string) => Record<string, unknown> | undefined;
  private readonly now: () => Date;
  private readonly runCommand: CommandRunner;

  constructor(options: RecorderStallDiagnosticsOptions = {}) {
    this.onSnapshot = options.onSnapshot || (() => undefined);
    this.getState = options.getState;
    this.now = options.now || (() => new Date());
    this.runCommand = options.runCommand || defaultRunCommand;
  }

  startSession(payload: any): void {
    const runtime = this.getRuntimeConfig();
    if (!runtime.enabled) return;

    const roomId = getRoomId(payload);
    if (!roomId) return;

    const observedAt = this.now();
    const sessionId = getEventSessionId(payload);
    const previous = this.contexts.get(roomId);
    if (previous && previous.sessionId && sessionId && previous.sessionId === sessionId) {
      previous.events.push(this.toDiagnosticEvent('SessionStarted', payload, observedAt));
      return;
    }
    if (previous) this.cancelContext(roomId, previous);

    const recentFileOpeningAt = this.recentFileOpenings.get(roomId);
    if (recentFileOpeningAt && observedAt.getTime() - recentFileOpeningAt.getTime() <= EVENT_TIMESTAMP_TOLERANCE_MS) {
      this.recentFileOpenings.delete(roomId);
      RecorderStallDiagnostics.logger.info(`SessionStarted 已有近期 FileOpening 证据，跳过卡住诊断: ${roomId}`);
      return;
    }

    const eventTime = getPayloadEventDate(payload);
    const context: Omit<DiagnosticContext, 'timer'> = {
      roomId,
      roomName: asString(payload?.EventData?.Name),
      title: asString(payload?.EventData?.Title),
      sessionId,
      sessionStartedAt: eventTime?.toISOString(),
      observedAt,
      eventTime,
      events: [this.toDiagnosticEvent('SessionStarted', payload, observedAt)],
      runtime
    };

    let diagnosticContext!: DiagnosticContext;
    const timer = setTimeout(() => {
      void this.capture(diagnosticContext).catch(error => {
        RecorderStallDiagnostics.logger.warn(`录制卡住诊断执行失败: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, runtime.delayMs);
    timer.unref?.();

    diagnosticContext = { ...context, timer };
    this.contexts.set(roomId, diagnosticContext);
    RecorderStallDiagnostics.logger.info(`启动录制卡住诊断: ${roomId} (等待 ${runtime.delayMs / 1000} 秒)`);
  }

  observe(eventType: RecorderLifecycleEventType, payload: any): void {
    const roomId = getRoomId(payload);
    if (!roomId) return;

    if (eventType === 'FileOpening') {
      this.recentFileOpenings.set(roomId, this.now());
      this.pruneRecentFileOpenings();
    }

    const context = this.contexts.get(roomId);
    if (!context || !this.matchesContext(context, payload)) return;

    context.events.push(this.toDiagnosticEvent(eventType, payload, this.now()));
    if (eventType === 'FileOpening' || eventType === 'FileClosed' || eventType === 'SessionEnded') {
      this.cancelContext(roomId, context);
    }
  }

  dispose(): void {
    for (const [roomId, context] of this.contexts.entries()) {
      this.cancelContext(roomId, context);
    }
    this.recentFileOpenings.clear();
  }

  private cancelContext(roomId: string, context: DiagnosticContext): void {
    clearTimeout(context.timer);
    if (this.contexts.get(roomId) === context) this.contexts.delete(roomId);
  }

  private matchesContext(context: DiagnosticContext, payload: any): boolean {
    const eventSessionId = getEventSessionId(payload);
    if (context.sessionId && eventSessionId && context.sessionId !== eventSessionId) return false;

    const eventTime = getPayloadEventDate(payload);
    const referenceTime = context.eventTime || context.observedAt;
    if (eventTime && eventTime.getTime() < referenceTime.getTime() - EVENT_TIMESTAMP_TOLERANCE_MS) return false;
    return true;
  }

  private toDiagnosticEvent(type: RecorderLifecycleEventType, payload: any, observedAt: Date): RecorderStallDiagnosticEvent {
    const event: RecorderStallDiagnosticEvent = {
      type,
      observedAt: observedAt.toISOString(),
      eventTimestamp: getPayloadEventDate(payload)?.toISOString(),
      sessionId: getEventSessionId(payload),
      recording: typeof payload?.EventData?.Recording === 'boolean' ? payload.EventData.Recording : undefined,
      streaming: typeof payload?.EventData?.Streaming === 'boolean' ? payload.EventData.Streaming : undefined,
      fileOpenTime: asDate(payload?.EventData?.FileOpenTime)?.toISOString(),
      fileCloseTime: asDate(payload?.EventData?.FileCloseTime)?.toISOString(),
      relativePath: asString(payload?.EventData?.RelativePath)
    };
    return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)) as RecorderStallDiagnosticEvent;
  }

  private async capture(context: DiagnosticContext): Promise<void> {
    if (this.contexts.get(context.roomId) !== context) return;
    this.contexts.delete(context.roomId);

    const capturedAt = this.now();
    const outputRoot = this.resolveOutputRoot(context.runtime);
    const diagnosticDirectory = path.join(
      outputRoot,
      `room-${safeComponent(context.roomId, 'unknown')}-${formatPathTimestamp(capturedAt)}-${safeComponent(context.sessionId, 'session')}`
    );
    const diagnosticFile = path.join(diagnosticDirectory, 'diagnostic.json');

    let writeError: string | undefined;
    try {
      fs.mkdirSync(diagnosticDirectory, { recursive: true });
    } catch (error) {
      writeError = `无法创建诊断目录: ${error instanceof Error ? error.message : String(error)}`;
    }

    const processSnapshot = await this.captureProcessSnapshot();
    const dump = await this.captureDump(context.runtime, processSnapshot, diagnosticDirectory);
    const snapshot: RecorderStallDiagnosticSnapshot = {
      roomId: context.roomId,
      roomName: context.roomName,
      title: context.title,
      sessionId: context.sessionId,
      sessionStartedAt: context.sessionStartedAt,
      observedAt: context.observedAt.toISOString(),
      capturedAt: capturedAt.toISOString(),
      elapsedSeconds: Math.max(0, (capturedAt.getTime() - context.observedAt.getTime()) / 1000),
      reason: 'SessionStarted 已观察，但在诊断等待窗口内没有观察到同一会话的 FileOpening',
      state: this.readState(context.roomId),
      events: context.events,
      recordingRoot: context.runtime.recordingRoot,
      fileInventory: this.collectFileInventory(context.runtime.recordingRoot, context.roomId, context.observedAt, context.runtime.maxFileEntries),
      logEvidence: this.collectLogEvidence(context.runtime, context.roomId),
      processSnapshot,
      dump,
      diagnosticDirectory,
      diagnosticFile,
      writeError
    };

    if (!writeError) {
      try {
        fs.writeFileSync(diagnosticFile, JSON.stringify(snapshot, null, 2), 'utf8');
      } catch (error) {
        snapshot.writeError = `无法写入诊断文件: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    RecorderStallDiagnostics.logger.warn(`录制卡住诊断已生成: ${context.roomId}`, {
      diagnosticFile,
      fileCount: snapshot.fileInventory.entries.length,
      logFileCount: snapshot.logEvidence.length,
      processCount: snapshot.processSnapshot.processes.length,
      dumpStatus: snapshot.dump?.status
    });

    try {
      await this.onSnapshot(snapshot);
    } catch (error) {
      RecorderStallDiagnostics.logger.warn(`录制卡住诊断提醒发送失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private readState(roomId: string): Record<string, unknown> | undefined {
    if (!this.getState) return undefined;
    try {
      return this.getState(roomId);
    } catch (error) {
      return { error: `读取summary-ts会话状态失败: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private getRuntimeConfig(): RuntimeConfig {
    let config: any = {};
    try {
      config = ConfigProvider.getConfig() as any;
    } catch {
      // Keep diagnostics usable during tests or early startup.
    }

    const configured = (config.monitoring?.recorderStallDiagnostics || {}) as RecorderStallDiagnosticsConfig;
    const storageTempPath = asString(config.storage?.tempPath) || path.join(process.cwd(), 'temp');
    const recordingRoot = asString(config.webhook?.endpoints?.mikufans?.basePath) || asString(config.storage?.basePath) || path.join(process.cwd(), 'output');
    const delaySeconds = Number(configured.delaySeconds);
    const dumpTimeoutSeconds = Number(configured.dumpTimeoutSeconds);
    const maxLogBytes = Number(configured.maxLogBytes);
    const maxFileEntries = Number(configured.maxFileEntries);

    return {
      enabled: configured.enabled !== false,
      delayMs: (Number.isFinite(delaySeconds) && delaySeconds >= 0 ? delaySeconds : DEFAULT_DELAY_SECONDS) * 1000,
      outputDirectory: asString(configured.outputDirectory) || 'recorder-diagnostics',
      storageTempPath,
      recordingRoot,
      logDirectory: asString(configured.logDirectory),
      includeProcessDump: configured.includeProcessDump !== false,
      analyzeDump: configured.analyzeDump !== false,
      dumpTool: asString(configured.dumpTool) || 'auto',
      dumpToolPath: asString(configured.dumpToolPath),
      dumpTimeoutMs: (Number.isFinite(dumpTimeoutSeconds) && dumpTimeoutSeconds > 0 ? dumpTimeoutSeconds * 1000 : DEFAULT_DUMP_TIMEOUT_MS),
      maxLogBytes: Number.isFinite(maxLogBytes) && maxLogBytes > 0 ? Math.min(maxLogBytes, 2 * 1024 * 1024) : DEFAULT_MAX_LOG_BYTES,
      maxFileEntries: Number.isFinite(maxFileEntries) && maxFileEntries > 0 ? Math.min(Math.floor(maxFileEntries), 2000) : DEFAULT_MAX_FILE_ENTRIES
    };
  }

  private resolveOutputRoot(runtime: RuntimeConfig): string {
    return path.isAbsolute(runtime.outputDirectory)
      ? runtime.outputDirectory
      : path.resolve(runtime.storageTempPath, runtime.outputDirectory);
  }

  private collectFileInventory(rootPath: string, roomId: string, observedAt: Date, maxEntries: number): RecorderStallDiagnosticSnapshot['fileInventory'] {
    const result: RecorderStallDiagnosticSnapshot['fileInventory'] = { entries: [] };
    const root = path.resolve(rootPath);
    if (!fs.existsSync(root)) {
      result.error = `录播目录不存在: ${root}`;
      return result;
    }

    const cutoff = observedAt.getTime() - 10 * 60 * 1000;
    const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    const visited = new Set<string>();

    while (queue.length > 0 && result.entries.length < maxEntries) {
      const current = queue.shift()!;
      const normalizedDirectory = path.resolve(current.directory).toLowerCase();
      if (visited.has(normalizedDirectory)) continue;
      visited.add(normalizedDirectory);

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current.directory, { withFileTypes: true });
      } catch (error) {
        result.error = result.error || `读取录播目录失败: ${error instanceof Error ? error.message : String(error)}`;
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current.directory, entry.name);
        if (entry.isDirectory() && current.depth < 4) {
          queue.push({ directory: fullPath, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;

        const extension = path.extname(entry.name).toLowerCase();
        if (!RECORDING_EXTENSIONS.has(extension)) continue;

        try {
          const stats = fs.statSync(fullPath);
          const pathText = fullPath.toLowerCase();
          const roomMatch = pathText.includes(roomId.toLowerCase());
          const recentMatch = stats.mtimeMs >= cutoff;
          if (!roomMatch && !recentMatch) continue;
          result.entries.push({
            relativePath: path.relative(root, fullPath),
            sizeBytes: stats.size,
            modifiedAt: stats.mtime.toISOString()
          });
          if (result.entries.length >= maxEntries) break;
        } catch {
          // Files may be rotated or deleted while the snapshot is running.
        }
      }
    }

    result.entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    if (queue.length > 0) result.truncated = true;
    return result;
  }

  private collectLogEvidence(runtime: RuntimeConfig, roomId: string): RecorderLogEvidence[] {
    const files = this.findLogFiles(runtime).slice(0, LOG_FILE_LIMIT);
    return files.map(filePath => this.readLogEvidence(filePath, roomId, runtime.maxLogBytes));
  }

  private findLogFiles(runtime: RuntimeConfig): string[] {
    const directories = new Set<string>();
    const addDirectory = (value: string | undefined): void => {
      if (value) directories.add(path.resolve(value));
    };

    addDirectory(runtime.logDirectory);
    addDirectory(process.env.BILILIVE_RECORDER_LOG_DIR);
    addDirectory(path.join(runtime.recordingRoot, 'logs'));
    addDirectory(path.join(runtime.storageTempPath, 'logs'));
    addDirectory(path.join(process.cwd(), 'logs'));
    if (process.env.LOCALAPPDATA) addDirectory(path.join(process.env.LOCALAPPDATA, 'BililiveRecorder'));

    const files = new Map<string, number>();
    for (const directory of directories) {
      this.collectLogFilesFromDirectory(directory, files);
    }

    return Array.from(files.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([filePath]) => filePath);
  }

  private collectLogFilesFromDirectory(directory: string, files: Map<string, number>): void {
    if (!fs.existsSync(directory)) return;
    let directoryStat: fs.Stats;
    try {
      directoryStat = fs.statSync(directory);
    } catch {
      return;
    }
    if (!directoryStat.isDirectory()) {
      if (/\.(log|txt)$/i.test(directory)) files.set(directory, directoryStat.mtimeMs);
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile() && /\.(log|txt)$/i.test(entry.name)) {
        try {
          files.set(fullPath, fs.statSync(fullPath).mtimeMs);
        } catch {
          // Ignore files that rotate during enumeration.
        }
      } else if (entry.isDirectory() && /^app-[^/\\]+$/i.test(entry.name)) {
        this.collectLogFilesFromDirectory(path.join(fullPath, 'logs'), files);
      }
    }
  }

  private readLogEvidence(filePath: string, roomId: string, maxBytes: number): RecorderLogEvidence {
    const evidence: RecorderLogEvidence = { path: filePath, matchedLines: [] };
    let fd: number | undefined;
    try {
      const stats = fs.statSync(filePath);
      evidence.sizeBytes = stats.size;
      evidence.modifiedAt = stats.mtime.toISOString();
      const bytesToRead = Math.min(stats.size, maxBytes);
      const offset = Math.max(0, stats.size - bytesToRead);
      const buffer = Buffer.alloc(bytesToRead);
      fd = fs.openSync(filePath, 'r');
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (offset > 0) {
        const firstNewline = text.indexOf('\n');
        if (firstNewline >= 0) text = text.slice(firstNewline + 1);
      }

      const lines = text.split(/\r?\n/);
      const selected = new Set<number>();
      lines.forEach((line, index) => {
        if (line.includes(roomId) || LOG_KEYWORDS.test(line)) {
          selected.add(index);
          if (index > 0) selected.add(index - 1);
          if (index + 1 < lines.length) selected.add(index + 1);
        }
      });
      evidence.matchedLines = Array.from(selected)
        .sort((a, b) => a - b)
        .map(index => redactLogLine(lines[index]))
        .filter(Boolean)
        .slice(-LOG_LINE_LIMIT);
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* Ignore a rotated file handle. */ }
      }
    }
    return evidence;
  }

  private async captureProcessSnapshot(): Promise<RecorderProcessSnapshot> {
    const snapshot: RecorderProcessSnapshot = {
      capturedAt: this.now().toISOString(),
      platform: process.platform,
      processes: []
    };
    if (process.platform !== 'win32') {
      snapshot.error = '进程详细快照仅在 Windows 上启用';
      return snapshot;
    }

    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$rows = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '(?i)bililive|dotnet' -or $_.CommandLine -match '(?i)bililive|bilirecorder' } | Select-Object ProcessId,Name,ExecutablePath,CommandLine",
      '$rows | ConvertTo-Json -Compress'
    ].join('; ');
    const result = await this.runCommand('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], 10 * 1000);
    if (result.exitCode !== 0) {
      snapshot.error = `读取Windows进程信息失败: ${truncateText(result.stderr || result.stdout, 1000)}`;
      return snapshot;
    }

    try {
      const parsed = JSON.parse(result.stdout.trim() || '[]');
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      snapshot.processes = rows.map(row => ({
        processId: Number(row.ProcessId),
        name: asString(row.Name),
        executablePath: asString(row.ExecutablePath),
        commandLine: redactLogLine(asString(row.CommandLine) || '') || undefined
      })).filter(row => Number.isFinite(row.processId) && row.processId > 0);
    } catch (error) {
      snapshot.error = `解析Windows进程信息失败: ${error instanceof Error ? error.message : String(error)}`;
    }
    return snapshot;
  }

  private async captureDump(runtime: RuntimeConfig, processSnapshot: RecorderProcessSnapshot, diagnosticDirectory: string): Promise<RecorderDumpResult> {
    if (!runtime.includeProcessDump) {
      return { requested: false, status: 'disabled' };
    }
    if (process.platform !== 'win32') {
      return { requested: true, status: 'unsupported_platform' };
    }

    const processInfo = this.findRecorderProcess(processSnapshot.processes);
    if (!processInfo) {
      return { requested: true, status: 'recorder_process_not_found' };
    }

    const tool = await this.resolveDumpTool(runtime);
    if (!tool) {
      return { requested: true, status: 'dump_tool_not_found', processId: processInfo.processId };
    }

    const requestedDumpPath = path.join(diagnosticDirectory, `recorder-${processInfo.processId}.dmp`);
    const args = tool.kind === 'dotnet-dump'
      ? ['collect', '--process-id', String(processInfo.processId), '--output', requestedDumpPath, '--type', 'Full']
      // ProcDump treats the final argument as an output directory and chooses
      // its own file name, so pass the unique diagnostic directory and resolve
      // the actual .dmp file after the command exits.
      : ['-accepteula', '-ma', String(processInfo.processId), diagnosticDirectory];
    const result = await this.runCommand(tool.command, args, runtime.dumpTimeoutMs);
    const dumpPath = this.findDumpPath(tool.kind, requestedDumpPath, diagnosticDirectory);
    const dumpSize = dumpPath ? this.getFileSize(dumpPath) : undefined;
    const dumpIsValid = Boolean(dumpPath && dumpSize && dumpSize >= MIN_VALID_DUMP_BYTES && this.hasMinidumpHeader(dumpPath));
    const dumpResult: RecorderDumpResult = {
      requested: true,
      status: dumpIsValid
        ? (result.exitCode === 0 ? 'collected' : 'collected_with_nonzero_exit')
        : (result.exitCode === null ? 'collect_timeout' : 'collect_failed'),
      tool: tool.kind,
      processId: processInfo.processId,
      path: dumpPath || requestedDumpPath,
      sizeBytes: dumpSize,
      exitCode: result.exitCode,
      stdout: truncateText(result.stdout),
      stderr: truncateText(result.stderr)
    };
    if (dumpIsValid && dumpPath && tool.kind === 'dotnet-dump' && runtime.analyzeDump) {
      const analysisPath = path.join(diagnosticDirectory, `recorder-${processInfo.processId}.analysis.txt`);
      const analysisResult = await this.runCommand(
        tool.command,
        ['analyze', dumpPath, '-c', 'clrstack -all', '-c', 'clrthreads', '-c', 'exit'],
        runtime.dumpTimeoutMs
      );
      const analysisText = [analysisResult.stdout, analysisResult.stderr]
        .filter(Boolean)
        .join('\n');
      let analysisStatus = analysisResult.exitCode === 0 ? 'analyzed' : 'analysis_failed';
      try {
        fs.writeFileSync(analysisPath, analysisText, 'utf8');
      } catch (error) {
        analysisStatus = `analysis_write_failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      dumpResult.analysis = {
        status: analysisStatus,
        path: analysisPath,
        stdout: truncateText(analysisResult.stdout),
        stderr: truncateText(analysisResult.stderr)
      };
    }
    return dumpResult;
  }

  private findDumpPath(
    toolKind: 'dotnet-dump' | 'procdump',
    requestedPath: string,
    diagnosticDirectory: string
  ): string | undefined {
    if (toolKind === 'dotnet-dump') return fs.existsSync(requestedPath) ? requestedPath : undefined;
    try {
      const candidates = fs.readdirSync(diagnosticDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.dmp')
        .map(entry => path.join(diagnosticDirectory, entry.name))
        .sort((a, b) => this.getFileModifiedAt(b) - this.getFileModifiedAt(a));
      return candidates[0];
    } catch {
      return undefined;
    }
  }

  private getFileSize(filePath: string): number | undefined {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return undefined;
    }
  }

  private getFileModifiedAt(filePath: string): number {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private hasMinidumpHeader(filePath: string): boolean {
    let fd: number | undefined;
    try {
      const header = Buffer.alloc(4);
      fd = fs.openSync(filePath, 'r');
      return fs.readSync(fd, header, 0, header.length, 0) === header.length && header.toString('ascii') === 'MDMP';
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* Ignore a rotated or locked dump. */ }
      }
    }
  }

  private findRecorderProcess(processes: RecorderProcessInfo[]): RecorderProcessInfo | undefined {
    return processes
      .filter(processInfo => {
        const text = `${processInfo.name || ''} ${processInfo.executablePath || ''} ${processInfo.commandLine || ''}`.toLowerCase();
        return text.includes('bililive') || text.includes('bilirecorder');
      })
      .sort((a, b) => {
        const aExact = /bililive|bilirecorder/i.test(a.name || '') ? 0 : 1;
        const bExact = /bililive|bilirecorder/i.test(b.name || '') ? 0 : 1;
        return aExact - bExact;
      })[0];
  }

  private async resolveDumpTool(runtime: RuntimeConfig): Promise<{ kind: 'dotnet-dump' | 'procdump'; command: string } | undefined> {
    const configuredKind = runtime.dumpTool.toLowerCase();
    const candidates: Array<{ kind: 'dotnet-dump' | 'procdump'; command: string }> = [];
    if (runtime.dumpToolPath) {
      const kind = configuredKind === 'procdump' || /procdump/i.test(runtime.dumpToolPath) ? 'procdump' : 'dotnet-dump';
      candidates.push({ kind, command: runtime.dumpToolPath });
    } else if (configuredKind === 'dotnet-dump') {
      candidates.push({ kind: 'dotnet-dump', command: 'dotnet-dump' });
    } else if (configuredKind === 'procdump') {
      candidates.push({ kind: 'procdump', command: 'procdump' });
    } else {
      candidates.push({ kind: 'dotnet-dump', command: 'dotnet-dump' });
      candidates.push({ kind: 'procdump', command: 'procdump' });
    }

    if (!runtime.dumpToolPath && configuredKind === 'auto') {
      candidates.push(...LOCAL_DUMP_TOOL_PATHS.map(command => ({ kind: 'procdump' as const, command })));
    }

    for (const candidate of candidates) {
      const resolvedPath = path.isAbsolute(candidate.command)
        ? candidate.command
        : path.resolve(process.cwd(), candidate.command);
      if (fs.existsSync(resolvedPath)) return { ...candidate, command: resolvedPath };
      if (path.isAbsolute(candidate.command) || candidate.command.includes(path.sep)) continue;
      const result = await this.runCommand('where', [candidate.command], 5 * 1000);
      if (result.exitCode === 0) {
        const resolved = result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
        if (resolved) return { ...candidate, command: resolved };
      }
    }
    return undefined;
  }

  private pruneRecentFileOpenings(): void {
    const cutoff = this.now().getTime() - RECENT_FILE_OPENING_TTL_MS;
    for (const [roomId, timestamp] of this.recentFileOpenings.entries()) {
      if (timestamp.getTime() < cutoff) this.recentFileOpenings.delete(roomId);
    }
  }
}
