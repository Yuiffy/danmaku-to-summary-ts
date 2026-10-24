import { AsrProgress } from '../../core/admin/asrStatus';

/** Per-invocation, monotonic committed audio only. Never infer speed from batch numbers. */
export class AdminAsrTelemetry {
  private points: { at: number; done: number }[] = [];
  private structured = false;
  private device?: string;
  private tier?: string;
  private lastProgressAt?: number;
  progress?: AsrProgress;

  reset(): void {
    this.points = [];
    this.lastProgressAt = undefined;
    if (this.progress) {
      delete this.progress.speedX;
      delete this.progress.speedWindowSeconds;
      delete this.progress.speedProvisional;
      delete this.progress.etaSeconds;
    }
  }

  accept(line: string, at: number): { device: 'cpu' | 'gpu'; phase: string } | undefined {
    const marker = line.match(/\[\[ASR_HANDOFF_STATUS\]\]\s*(\{[^}]{1,1000}\})/u);
    let data: { device: string; state: string; audio_done_s: number; audio_total_s: number; window_s?: number; batch_size_s?: number; performance_tier?: string };
    if (marker) {
      try { data = JSON.parse(marker[1]); } catch { return undefined; }
      if (!data || typeof data !== 'object') return undefined;
      if (!['cpu', 'cuda'].includes(data.device) || !['loading', 'running', 'waiting', 'postprocessing'].includes(data.state)) return undefined;
    } else {
      if (/ASR 分段接力:|ASR 接力中断:/u.test(line)) this.reset();
      if (this.structured) return undefined;
      const checkpoint = line.match(/ASR 接力已保存:\s*([\d.]+)\/([\d.]+)s，device=(cpu|cuda(?::\d+)?)/u);
      if (!checkpoint) return undefined;
      data = { device: checkpoint[3] === 'cpu' ? 'cpu' : 'cuda', state: 'running',
        audio_done_s: Number(checkpoint[1]), audio_total_s: Number(checkpoint[2]) };
      if (data.audio_done_s === data.audio_total_s) data.state = 'postprocessing';
    }
    const { audio_done_s: done, audio_total_s: total } = data;
    if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done < 0 || done > total + 0.01) return undefined;
    if (marker) this.structured = true;
    const tier = data.device === 'cpu' ? 'cpu_background' : data.performance_tier === 'gpu_low_impact' ? 'gpu_low_impact' : 'gpu_throughput';
    if (this.device !== data.device || this.tier !== `${tier}:${data.batch_size_s}` || this.progress?.audioTotalSeconds !== total
      || done < (this.progress?.audioDoneSeconds ?? 0) || data.state !== 'running'
      || (this.lastProgressAt !== undefined && at - this.lastProgressAt > 120000)) this.reset();
    this.device = data.device;
    this.tier = `${tier}:${data.batch_size_s}`;
    this.progress = { audioDoneSeconds: Math.min(done, total), audioTotalSeconds: total,
      percent: Math.min(100, done / total * 100),
      performanceTier: data.state === 'waiting' ? 'waiting' : data.state === 'postprocessing' ? 'postprocessing'
        : tier };
    if (Number.isFinite(data.window_s) && data.window_s! > 0) this.progress.windowSeconds = data.window_s;
    if (Number.isFinite(data.batch_size_s) && data.batch_size_s! > 0) this.progress.batchSeconds = data.batch_size_s;
    const last = this.points.at(-1);
    if (data.state === 'running' && (!last || done > last.done)) {
      this.points.push({ at, done });
      this.lastProgressAt = at;
      // Keep the trailing two minutes, including one bracketing observation.
      while (this.points.length > 2 && this.points[1].at < at - 120000) this.points.shift();
    }
    const first = this.points[0], latest = this.points.at(-1);
    if (data.state === 'running' && first && latest && latest.at - first.at >= 10000
      && latest.done > first.done && this.points.length >= 3) {
      const wall = (latest.at - first.at) / 1000, speed = (latest.done - first.done) / wall;
      this.progress.speedX = speed;
      this.progress.speedWindowSeconds = wall;
      this.progress.speedProvisional = wall < 60;
      if (wall >= 60 && done < total) this.progress.etaSeconds = (total - done) / speed;
    }
    return { device: data.device === 'cpu' ? 'cpu' : 'gpu', phase: !marker && data.state === 'running' ? '已保存分段进度' : {
      loading: '加载模型 / 准备首段', running: '转写中', waiting: '等待计算资源', postprocessing: '文字转写完成，后处理中',
    }[data.state]! };
  }

  current(now: number): AsrProgress | undefined {
    if (!this.progress) return undefined;
    if (this.lastProgressAt === undefined || now - this.lastProgressAt <= 120000) return this.progress;
    const { speedX: _speed, speedWindowSeconds: _window, speedProvisional: _provisional, etaSeconds: _eta, ...progress } = this.progress;
    return progress;
  }
}
