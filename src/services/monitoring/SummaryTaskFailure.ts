/** Bounded diagnostics for one summary child; no process, queue or network IO. */
export interface SummaryTaskFailureDetails {
  taskId: string;
  roomId: string;
  mediaPath: string;
  recoveryEpisode: number;
  stage: 'prepare' | 'asr' | 'postprocess';
  reason: string;
  durationSeconds?: number;
  retryCount?: number;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export class SummaryFailureDiagnostics {
  private errorTail = '';
  private asrStarted = false;
  private asrDone = false;
  private durationSeconds?: number;

  observeOutput(line: string): void {
    if (line.includes('-> [ASR]')) this.asrStarted = true;
    if (line.includes('[[ASR_PHASE_DONE]]') || line.includes('[[WHISPER_PHASE_DONE]]')) this.asrDone = true;
    const handoff = line.match(/\[\[ASR_HANDOFF_STATUS\]\]\s+({[^\r\n]+})/);
    if (handoff) {
      this.asrStarted = true;
      try { this.setDuration(JSON.parse(handoff[1]).audio_total_s); } catch { /* Diagnostic only. */ }
    }
    // The existing CLI duration line is a best-effort fallback for non-handoff routes.
    const duration = line.match(/^->\s*((?:\d+:)?\d+:\d{2})[,.](\d{3})\s*$/);
    if (duration) this.setDuration(duration[1].split(':').reduce((sum, part) => sum * 60 + Number(part), 0) + Number(duration[2]) / 1000);
    if (/错误:|(?:Error|Exception):|❌/.test(line)) this.observeError(line + '\n');
  }

  observeError(chunk: string): void {
    this.errorTail = (this.errorTail + chunk).slice(-16 * 1024);
  }

  failure(reason: string, context: Pick<SummaryTaskFailureDetails, 'taskId' | 'roomId' | 'mediaPath' | 'recoveryEpisode' | 'retryCount'>,
          useLastError = true): SummaryTaskFailureDetails {
    const lines = this.errorTail.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).map(line => line.trim());
    const errors = lines.map(line => line.match(/(?:^|\s)((?:[\w.]*Error|[\w.]*Exception|错误)\s*[:：].*)/)?.[1]).filter(Boolean);
    const lastError = errors[errors.length - 1] || lines.filter(line => line.includes('❌')).pop();
    const detail = useLastError && lastError ? `${reason}；${lastError}` : reason;
    return { ...context, stage: this.asrDone ? 'postprocess' : this.asrStarted ? 'asr' : 'prepare',
      reason: singleLine(detail).slice(0, 1000), durationSeconds: this.durationSeconds };
  }

  private setDuration(value: unknown): void {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) this.durationSeconds = value;
  }
}

export function summaryTaskFailureLines(details: SummaryTaskFailureDetails): string[] {
  const parts = details.mediaPath.split(/[\\/]/);
  const file = parts[parts.length - 1];
  const roomDirectory = parts.slice(0, -1).reverse().find(part => part.startsWith(`${details.roomId}_`));
  const roomName = roomDirectory?.slice(details.roomId.length + 1);
  const recording = file.match(/^录制-(\d+)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-\d{3}-(.+?)(?:_merged)?\.[^.]+$/);
  const sameRoom = recording && recording[1] === details.roomId;
  const started = sameRoom ? `${recording[2]}-${recording[3]}-${recording[4]} ${recording[5]}:${recording[6]}:${recording[7]}（北京时间）` : '未获取';
  const duration = details.durationSeconds;
  const seconds = duration && Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null;
  const formattedDuration = seconds === null ? '未获取（不会用任务等待时间代替直播时长）'
    : `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分${seconds % 60}秒`;
  return [
    `**直播间**: ${roomName ? `${singleLine(roomName)}（${details.roomId}）` : details.roomId}`,
    `**本场标题**: ${sameRoom ? singleLine(recording[8]) : singleLine(file)}`,
    `**录播开始**: ${started}`,
    `**录播时长**: ${formattedDuration}`,
    `**失败阶段**: ${{ prepare: '输入准备／任务启动', asr: '语音转字幕（ASR）', postprocess: '字幕完成后的处理' }[details.stage]}`,
    `**原因**: ${singleLine(details.reason)}`,
    `**结果**: 本任务已停止自动处理${details.retryCount ? `，累计失败 ${details.retryCount} 次` : ''}。`,
    details.stage === 'postprocess'
      ? '**后续影响**: 字幕阶段已完成；摘要、晚安文案／漫画等后处理未确认全部完成。独立入队的切片可能仍在运行，请核对现有产物与队列。'
      : '**后续影响**: 字幕阶段未完成；依赖本次字幕的摘要、晚安文案／漫画及自动切片无法继续（仅指该房间已启用的流程）。',
    '**处理建议**: 检查上述原因后恢复原任务重试；本提醒不会重新转写或重复投稿。',
    `**任务 ID**: ${details.taskId}`,
    `**录播文件**: ${file}`
  ];
}
