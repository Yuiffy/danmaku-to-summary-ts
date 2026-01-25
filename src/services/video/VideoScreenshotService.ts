/**
 * 视频截图服务实现
 * 使用ffmpeg在视频的1/5、2/5、3/5、4/5时间点截取帧并拼接成2x2图
 */
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../../core/logging/LogManager';
import { IVideoScreenshotService } from './IVideoScreenshotService';

export class VideoScreenshotService implements IVideoScreenshotService {
  private logger = getLogger('VideoScreenshotService');

  /**
   * 获取视频时长（秒）
   */
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
          if (!isNaN(duration)) {
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

  /**
   * 生成视频截图
   */
  async generateScreenshots(videoPath: string): Promise<string | null> {
    try {
      this.logger.info(`开始生成视频截图: ${path.basename(videoPath)}`);

      // 检查视频文件是否存在
      if (!fs.existsSync(videoPath)) {
        this.logger.error(`视频文件不存在: ${videoPath}`);
        return null;
      }

      // 获取视频时长
      const duration = await this.getVideoDuration(videoPath);
      if (!duration) {
        this.logger.error(`无法获取视频时长: ${videoPath}`);
        return null;
      }

      this.logger.info(`视频时长: ${duration.toFixed(2)}秒`);

      // 计算截图时间点（1/5、2/5、3/5、4/5）
      const timestamps = [
        duration * 0.2,  // 1/5
        duration * 0.4,  // 2/5
        duration * 0.6,  // 3/5
        duration * 0.8   // 4/5
      ];

      this.logger.info(`截图时间点: ${timestamps.map(t => t.toFixed(2)).join(', ')}秒`);

      // 生成输出文件路径
      const dir = path.dirname(videoPath);
      const baseName = path.basename(videoPath, path.extname(videoPath));
      const outputPath = path.join(dir, `${baseName}_SCREENSHOTS.jpg`);

      // 使用ffmpeg的select和tile滤镜生成2x2拼图
      // select='eq(n,T1)+eq(n,T2)+eq(n,T3)+eq(n,T4)' 选择特定帧
      // tile=2x2 将4帧拼接成2x2网格
      const args = [
        '-i', videoPath,
        '-vf', `select='eq(n\\,${Math.floor(timestamps[0] * 25)})+eq(n\\,${Math.floor(timestamps[1] * 25)})+eq(n\\,${Math.floor(timestamps[2] * 25)})+eq(n\\,${Math.floor(timestamps[3] * 25)})',tile=2x2`,
        '-frames:v', '1',
        '-q:v', '2',  // 高质量JPEG
        '-y',  // 覆盖已存在的文件
        outputPath
      ];

      this.logger.info(`执行ffmpeg命令: ffmpeg ${args.join(' ')}`);

      await this.runFFmpeg(args);

      // 检查输出文件是否生成
      if (fs.existsSync(outputPath)) {
        const fileSize = fs.statSync(outputPath).size;
        this.logger.info(`截图生成成功: ${path.basename(outputPath)} (${(fileSize / 1024).toFixed(2)} KB)`);
        return outputPath;
      } else {
        this.logger.error(`截图文件未生成: ${outputPath}`);
        return null;
      }
    } catch (error: any) {
      this.logger.error(`生成视频截图失败: ${error.message}`, { error });
      return null;
    }
  }

  /**
   * 运行ffmpeg命令
   */
  private async runFFmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args, { windowsHide: true });

      let errorMsg = '';
      ffmpeg.stderr?.on('data', (data: Buffer) => {
        errorMsg += data.toString();
      });

      ffmpeg.on('close', (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          this.logger.error(`ffmpeg执行失败`, {
            code,
            args: args.join(' '),
            error: errorMsg.substring(0, 500)
          });
          reject(new Error(`ffmpeg exited with code ${code}: ${errorMsg.substring(0, 200)}`));
        }
      });

      ffmpeg.on('error', (error) => {
        this.logger.error(`ffmpeg进程错误`, { error: error.message });
        reject(error);
      });
    });
  }
}
