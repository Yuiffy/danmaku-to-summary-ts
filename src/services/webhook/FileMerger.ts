/**
 * 文件合并器
 * 用于合并音视频文件和XML弹幕文件
 */
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getLogger } from '../../core/logging/LogManager';
import { LiveSegment } from './LiveSessionManager';

/**
 * 文件合并器
 */
export class FileMerger {
  private logger = getLogger('FileMerger');

  /**
   * 合并视频文件
   */
  async mergeVideos(segments: LiveSegment[], outputPath: string, fillGaps: boolean = true): Promise<void> {
    try {
      this.logger.info(`开始合并视频文件: ${segments.length} 个片段`);

      const dir = path.dirname(outputPath);
      const fileListPath = path.join(dir, 'filelist.txt');

      // 创建文件列表
      const fileList: string[] = [];

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        fileList.push(`file '${segment.videoPath}'`);

        // 计算空白时间
        if (fillGaps && i < segments.length - 1) {
          const nextSegment = segments[i + 1];
          const gapTime = this.calculateGapTime(segment, nextSegment);

          if (gapTime > 0) {
            // 创建空白片段
            const blankPath = await this.createBlankVideo(dir, gapTime);
            fileList.push(`file '${blankPath}'`);
            this.logger.info(`创建空白片段: ${gapTime}ms`);
          }
        }
      }

      // 写入文件列表
      fs.writeFileSync(fileListPath, fileList.join('\n'), 'utf8');

      // 使用ffmpeg合并视频
      await this.runFfmpeg([
        '-f', 'concat',
        '-safe', '0',
        '-i', fileListPath,
        '-c', 'copy',
        outputPath
      ]);

      // 删除临时文件列表
      fs.unlinkSync(fileListPath);

      this.logger.info(`视频合并完成: ${path.basename(outputPath)}`);
    } catch (error) {
      this.logger.error('合并视频文件失败', { error });
      throw error;
    }
  }

  /**
   * 合并XML弹幕文件
   */
  async mergeXmlFiles(segments: LiveSegment[], outputXmlPath: string): Promise<void> {
    try {
      this.logger.info(`开始合并XML文件: ${segments.length} 个片段`);

      let currentTimeOffset = 0; // 当前时间偏移量（毫秒）
      const mergedDanmakus: any[] = [];

      for (const segment of segments) {
        // 解析XML文件
        const danmakus = await this.parseXml(segment.xmlPath);

        // 调整弹幕时间戳
        const adjustedDanmakus = danmakus.map(d => ({
          ...d,
          time: d.time + currentTimeOffset
        }));

        // 添加到合并列表
        mergedDanmakus.push(...adjustedDanmakus);

        // 更新时间偏移量（加上当前片段时长）
        currentTimeOffset += await this.getSegmentDuration(segment);

        this.logger.info(`处理片段: ${path.basename(segment.xmlPath)}, 偏移量: ${currentTimeOffset}ms`);
      }

      // 生成合并后的XML文件
      await this.generateXml(mergedDanmakus, outputXmlPath);

      this.logger.info(`XML合并完成: ${path.basename(outputXmlPath)}`);
    } catch (error) {
      this.logger.error('合并XML文件失败', { error });
      throw error;
    }
  }

  /**
   * 计算片段之间的空白时间
   */
  calculateGapTime(prevSegment: LiveSegment, nextSegment: LiveSegment): number {
    const prevEndTime = prevSegment.fileCloseTime.getTime();
    const nextStartTime = nextSegment.fileOpenTime.getTime();

    // 空白时间（毫秒）
    return nextStartTime - prevEndTime;
  }

  /**
   * 创建空白视频片段
   */
  async createBlankVideo(dir: string, durationMs: number): Promise<string> {
    const durationSec = durationMs / 1000;
    const blankPath = path.join(dir, `blank_${durationMs}.mp4`);

    // 使用ffmpeg创建空白视频（黑屏，静音）
    await this.runFfmpeg([
      '-f', 'lavfi',
      '-i', `color=c=black:s=1920x1080:d=${durationSec}`,
      '-f', 'lavfi',
      '-i', `anullsrc=r=44100:cl=mono`,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-t', String(durationSec),
      '-y',
      blankPath
    ]);

    return blankPath;
  }

  /**
   * 获取视频时长（秒）
   */
  async getVideoDuration(videoPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoPath
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

      let output = '';
      let error = '';

      ffprobe.stdout.on('data', (data: Buffer) => {
        output += data.toString();
      });

      ffprobe.stderr.on('data', (data: Buffer) => {
        error += data.toString();
      });

      ffprobe.on('close', (code: number | null) => {
        if (code === 0 && output.trim()) {
          const duration = parseFloat(output.trim());
          if (!isNaN(duration)) {
            resolve(duration);
          } else {
            reject(new Error(`Invalid duration: ${output}`));
          }
        } else {
          reject(new Error(`ffprobe failed: ${error || 'unknown error'}`));
        }
      });

      ffprobe.on('error', reject);
    });
  }

  /**
   * 获取片段时长（秒）
   */
  async getSegmentDuration(segment: LiveSegment): Promise<number> {
    return await this.getVideoDuration(segment.videoPath);
  }

  /**
   * 解析XML文件
   */
  private async parseXml(xmlPath: string): Promise<any[]> {
    try {
      const content = fs.readFileSync(xmlPath, 'utf8');
      // 简单的XML解析，实际实现可能需要更复杂的解析逻辑
      // 这里假设XML格式为 <d><p>...</p><p>...</p></d>
      const danmakus: any[] = [];

      // 提取弹幕内容
      const pMatches = content.match(/<p[^>]*>([^<]*)<\/p>/g);
      if (pMatches) {
        pMatches.forEach((match, index) => {
          const contentMatch = match.match(/>([^<]*)</);
          if (contentMatch) {
            danmakus.push({
              time: index * 1000, // 简化处理，实际需要解析真实时间戳
              content: contentMatch[1]
            });
          }
        });
      }

      return danmakus;
    } catch (error) {
      this.logger.error('解析XML文件失败', { xmlPath, error });
      return [];
    }
  }

  /**
   * 生成XML文件
   */
  private async generateXml(danmakus: any[], outputXmlPath: string): Promise<void> {
    try {
      let xmlContent = '<?xml version="1.0" encoding="UTF-8"?>\n<i>\n';

      danmakus.forEach(d => {
        xmlContent += `  <p>${d.time}</p>\n`;
      });

      xmlContent += '</i>';

      fs.writeFileSync(outputXmlPath, xmlContent, 'utf8');
    } catch (error) {
      this.logger.error('生成XML文件失败', { outputXmlPath, error });
      throw error;
    }
  }

  /**
   * 运行ffmpeg命令
   */
  private async runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args, { windowsHide: true });

      ffmpeg.on('close', (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on('error', reject);
    });
  }

  /**
   * 备份原始片段到bak文件夹
   */
  async backupSegments(segments: LiveSegment[], outputDir: string): Promise<void> {
    const bakDir = path.join(outputDir, 'bak');

    // 创建bak文件夹
    if (!fs.existsSync(bakDir)) {
      fs.mkdirSync(bakDir, { recursive: true });
    }

    // 移动文件到bak文件夹
    for (const segment of segments) {
      const videoBasename = path.basename(segment.videoPath);
      const xmlBasename = path.basename(segment.xmlPath);

      const videoDest = path.join(bakDir, videoBasename);
      const xmlDest = path.join(bakDir, xmlBasename);

      // 移动视频文件
      if (fs.existsSync(segment.videoPath)) {
        fs.renameSync(segment.videoPath, videoDest);
        this.logger.info(`备份视频文件: ${videoBasename}`);
      }

      // 移动XML文件
      if (fs.existsSync(segment.xmlPath)) {
        fs.renameSync(segment.xmlPath, xmlDest);
        this.logger.info(`备份XML文件: ${xmlBasename}`);
      }
    }
  }

  /**
   * 复制封面图
   */
  async copyCover(segments: LiveSegment[], outputDir: string): Promise<void> {
    if (segments.length === 0) {
      return;
    }

    // 从第一个片段查找封面图
    const firstSegment = segments[0];
    const videoDir = path.dirname(firstSegment.videoPath);
    const videoBasename = path.basename(firstSegment.videoPath, path.extname(firstSegment.videoPath));

    // 查找可能的封面图文件
    const coverExtensions = ['.jpg', '.png', '.webp'];
    let coverPath: string | null = null;

    for (const ext of coverExtensions) {
      const possibleCover = path.join(videoDir, `${videoBasename}${ext}`);
      if (fs.existsSync(possibleCover)) {
        coverPath = possibleCover;
        break;
      }
    }

    // 如果找到封面图，复制到输出目录
    if (coverPath) {
      const coverBasename = path.basename(coverPath);
      const coverDest = path.join(outputDir, coverBasename);

      fs.copyFileSync(coverPath, coverDest);
      this.logger.info(`复制封面图: ${coverBasename}`);
    }
  }
}
