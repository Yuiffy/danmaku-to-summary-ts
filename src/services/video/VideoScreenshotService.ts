import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../../core/logging/LogManager';
import { IVideoScreenshotService } from './IVideoScreenshotService';
import { ProcessingAlertService } from '../monitoring/ProcessingAlertService';
import {
  applyFfmpegProcessPriority,
  getFfmpegResourceConfig,
  startFfmpegResourcePeakMonitor,
  waitForAsrAvailability,
  withFfmpegResourceLimits
} from '../../utils/ffmpegResource';

export class VideoScreenshotService implements IVideoScreenshotService {
  private logger = getLogger('VideoScreenshotService');

  private async getVideoDuration(videoPath: string): Promise<number | null> {
    return new Promise((resolve) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoPath
      ], { windowsHide: true });

      let output = '';
      ffprobe.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
      });

      ffprobe.on('close', (code: number | null) => {
        if (code === 0 && output.trim()) {
          const duration = parseFloat(output.trim());
          if (!Number.isNaN(duration)) {
            resolve(duration);
            return;
          }
        }
        this.logger.error(`获取视频时长失败: ${videoPath}`);
        resolve(null);
      });

      ffprobe.on('error', (error) => {
        this.logger.error(`ffprobe进程错误: ${error.message}`);
        resolve(null);
      });
    });
  }

  async generateScreenshots(videoPath: string): Promise<string | null> {
    const startedAt = Date.now();
    try {
      this.logger.info(`开始生成视频截图: ${path.basename(videoPath)}`);

      if (!fs.existsSync(videoPath)) {
        this.logger.error(`视频文件不存在: ${videoPath}`);
        return null;
      }

      const duration = await this.getVideoDuration(videoPath);
      if (!duration) {
        this.logger.error(`无法获取视频时长: ${videoPath}`);
        return null;
      }

      this.logger.info(`视频时长: ${duration.toFixed(2)}秒`);

      const timestamps = [
        duration * 0.2,
        duration * 0.4,
        duration * 0.6,
        duration * 0.8
      ];

      this.logger.info(`截图时间点: ${timestamps.map(t => t.toFixed(2)).join(', ')}秒`);

      const dir = path.dirname(videoPath);
      const baseName = path.basename(videoPath, path.extname(videoPath));
      const outputPath = path.join(dir, `${baseName}_SCREENSHOTS.jpg`);
      const args = this.buildFastSeekScreenshotArgs(videoPath, timestamps, outputPath);

      this.logger.info(`执行ffmpeg命令: ffmpeg ${args.join(' ')}`);
      await this.runFFmpeg(args);

      if (fs.existsSync(outputPath)) {
        const fileSize = fs.statSync(outputPath).size;
        this.logger.info(`截图生成成功: ${path.basename(outputPath)} (${(fileSize / 1024).toFixed(2)} KB)`);
        const elapsedSeconds = (Date.now() - startedAt) / 1000;
        await ProcessingAlertService.notifyIfSlowStage(
          '截图',
          elapsedSeconds,
          ProcessingAlertService.getThresholds().screenshotSlowSeconds,
          videoPath,
          { output: path.basename(outputPath) }
        );
        return outputPath;
      }

      this.logger.error(`截图文件未生成: ${outputPath}`);
      return null;
    } catch (error: any) {
      this.logger.error(`生成视频截图失败: ${error.message}`, { error });
      return null;
    }
  }

  private buildFastSeekScreenshotArgs(videoPath: string, timestamps: number[], outputPath: string): string[] {
    const args = ['-y'];
    for (const timestamp of timestamps) {
      args.push('-ss', Math.max(0, timestamp).toFixed(3), '-i', videoPath);
    }

    args.push(
      '-filter_complex',
      [
        '[0:v]scale=640:-2[s0]',
        '[1:v]scale=640:-2[s1]',
        '[2:v]scale=640:-2[s2]',
        '[3:v]scale=640:-2[s3]',
        '[s0][s1]hstack=inputs=2[top]',
        '[s2][s3]hstack=inputs=2[bottom]',
        '[top][bottom]vstack=inputs=2[out]'
      ].join(';'),
      '-map', '[out]',
      '-frames:v', '1',
      '-q:v', '2',
      outputPath
    );

    return args;
  }

  private async runFFmpeg(args: string[]): Promise<void> {
    const resourceConfig = getFfmpegResourceConfig();
    const asrState = await waitForAsrAvailability(
      '视频截图 ffmpeg',
      resourceConfig,
      message => this.logger.info(message)
    );
    const effectiveResourceConfig = { ...resourceConfig };
    if (asrState.asrActive && Number(effectiveResourceConfig.threads) > 0) {
      effectiveResourceConfig.threads = Math.min(
        Number(effectiveResourceConfig.threads),
        Math.max(1, Number(effectiveResourceConfig.asrGuard?.overlapThreads) || 1)
      );
      this.logger.info(`视频截图 ffmpeg 与 ASR 重叠，threads=${effectiveResourceConfig.threads}`);
    }
    return new Promise((resolve, reject) => {
      const limitedArgs = withFfmpegResourceLimits(args, effectiveResourceConfig);
      const ffmpeg = spawn('ffmpeg', limitedArgs, { windowsHide: true });
      applyFfmpegProcessPriority(ffmpeg.pid, effectiveResourceConfig.priority);
      const peakMonitor = startFfmpegResourcePeakMonitor(
        '视频截图 ffmpeg',
        effectiveResourceConfig,
        message => this.logger.info(message)
      );

      let errorMsg = '';
      ffmpeg.stderr?.on('data', (data: Buffer) => {
        errorMsg += data.toString();
      });

      ffmpeg.on('close', (code: number | null) => {
        peakMonitor.stop();
        if (code === 0) {
          resolve();
        } else {
          this.logger.error('ffmpeg执行失败', {
            code,
            args: limitedArgs.join(' '),
            error: errorMsg.substring(0, 500)
          });
          reject(new Error(`ffmpeg exited with code ${code}: ${errorMsg.substring(0, 200)}`));
        }
      });

      ffmpeg.on('error', (error) => {
        peakMonitor.stop();
        this.logger.error('ffmpeg进程错误', { error: error.message });
        reject(error);
      });
    });
  }
}
