import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { getLogger } from '../../core/logging/LogManager';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { AppError, TimeoutError } from '../../core/errors/AppError';
import {
  IAudioProcessor,
  AudioProcessingConfig,
  FfmpegResult
} from './IAudioProcessor';

const stat = promisify(fs.stat);
const unlink = promisify(fs.unlink);
const readFile = promisify(fs.readFile);
const exists = promisify(fs.exists);

/**
 * 音频处理服务实现
 */
export class AudioProcessor implements IAudioProcessor {
  private logger = getLogger('AudioProcessor');
  private config: AudioProcessingConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  /**
   * 加载音频处理配置
   */
  private loadConfig(): AudioProcessingConfig {
    const defaultConfig: AudioProcessingConfig = {
      enabled: true,
      audioOnlyRooms: [],
      keepOriginalVideo: false,
      ffmpegPath: 'ffmpeg',
      defaultFormat: '.m4a',
      timeouts: {
        ffmpegTimeout: 300000 // 5分钟
      }
    };

    try {
      const appConfig = ConfigProvider.getConfig();
      const audioConfig = appConfig.audio;
      
      // 合并配置
      const mergedConfig: AudioProcessingConfig = {
        ...defaultConfig,
        enabled: audioConfig.enabled ?? defaultConfig.enabled,
        audioOnlyRooms: audioConfig.audioOnlyRooms ?? defaultConfig.audioOnlyRooms,
        keepOriginalVideo: audioConfig.storage?.keepOriginalVideo ?? defaultConfig.keepOriginalVideo,
        ffmpegPath: audioConfig.ffmpeg?.path ?? defaultConfig.ffmpegPath,
        defaultFormat: audioConfig.defaultFormat ?? defaultConfig.defaultFormat,
        timeouts: {
          ffmpegTimeout: audioConfig.ffmpeg?.timeout ?? defaultConfig.timeouts.ffmpegTimeout
        }
      };

      this.logger.debug('音频处理配置加载完成', { config: mergedConfig });
      return mergedConfig;
    } catch (error) {
      this.logger.warn('加载音频处理配置失败，使用默认配置', { error });
      return defaultConfig;
    }
  }

  /**
   * 检查是否为音频专用房间
   */
  isAudioOnlyRoom(roomId: number): boolean {
    const isAudioRoom = this.config.enabled && 
                       this.config.audioOnlyRooms.includes(roomId);
    
    this.logger.debug('检查音频专用房间', { roomId, isAudioRoom });
    return isAudioRoom;
  }

  /**
   * 从文件名中提取房间ID
   */
  extractRoomIdFromFilename(filename: string): number | null {
    // DDTV文件名格式通常包含房间ID，例如：26966466_20240101_120000.mp4
    const match = filename.match(/^(\d+)_/);
    const roomId = match ? parseInt(match[1]) : null;
    
    this.logger.debug('从文件名提取房间ID', { filename, roomId });
    return roomId;
  }

  /**
   * 执行FFmpeg命令
   */
  private async runFfmpegCommand(args: string[], timeout?: number): Promise<FfmpegResult> {
    const ffmpegPath = this.config.ffmpegPath || 'ffmpeg';
    const timeoutMs = timeout || this.config.timeouts.ffmpegTimeout;
    
    this.logger.info('执行FFmpeg命令', { 
      command: `${ffmpegPath} ${args.join(' ')}`,
      timeout: timeoutMs 
    });

    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let timeoutId: NodeJS.Timeout | null = null;

      // 设置超时
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new TimeoutError(
            `FFmpeg命令超时 (${timeoutMs}ms)`
          ));
        }, timeoutMs);
      }

      // 收集标准输出
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      // 收集标准错误（包含进度信息）
      child.stderr.on('data', (data) => {
        const dataStr = data.toString();
        stderr += dataStr;
        
        // 输出进度信息
        if (dataStr.includes('time=')) {
          process.stdout.write('.');
        }
      });

      // 处理命令完成
      child.on('close', (code) => {
        if (timeoutId) clearTimeout(timeoutId);
        
        if (code === 0) {
          this.logger.info('FFmpeg命令执行成功');
          resolve({ stdout, stderr, exitCode: code });
        } else {
          this.logger.error('FFmpeg命令执行失败', {
            exitCode: code,
            stderr: stderr.substring(0, 500) // 只记录前500字符
          });
          reject(new AppError(
            `FFmpeg命令失败，退出码: ${code}`,
            'EXTERNAL_SERVICE_ERROR',
            500,
            true,
            { stderr: stderr.substring(0, 500) }
          ));
        }
      });

      // 处理命令错误
      child.on('error', (err) => {
        if (timeoutId) clearTimeout(timeoutId);
        this.logger.error('FFmpeg命令执行错误', { error: err.message });
        reject(new AppError(
          `FFmpeg命令执行错误: ${err.message}`,
          'EXTERNAL_SERVICE_ERROR',
          500
        ));
      });
    });
  }

  /**
   * 检查FFmpeg是否可用
   */
  async checkFfmpegAvailability(): Promise<boolean> {
    try {
      await this.runFfmpegCommand(['-version'], 10000);
      this.logger.info('FFmpeg可用');
      return true;
    } catch (error) {
      this.logger.error('FFmpeg不可用', { error: error instanceof Error ? error.message : error });
      return false;
    }
  }

  /**
   * 转换视频为音频
   */
  async convertVideoToAudio(videoPath: string, audioFormat: string = '.m4a'): Promise<string> {
    const videoDir = path.dirname(videoPath);
    const videoName = path.basename(videoPath, path.extname(videoPath));
    const audioPath = path.join(videoDir, `${videoName}${audioFormat}`);
    
    this.logger.info('开始转换视频为音频', {
      input: path.basename(videoPath),
      output: path.basename(audioPath),
      format: audioFormat
    });

    try {
      // 检查输入文件是否存在
      await stat(videoPath);

      // 构建FFmpeg参数
      const args = [
        '-i', videoPath,          // 输入文件
        '-vn',                    // 禁用视频流
        '-c:a', 'copy',           // 复制音频流，不重新编码
        '-y',                     // 覆盖输出文件
        audioPath
      ];

      await this.runFfmpegCommand(args);

      // 检查输出文件
      const audioStats = await stat(audioPath);
      const fileSizeMB = (audioStats.size / 1024 / 1024).toFixed(2);
      
      this.logger.info('音频文件生成成功', {
        file: path.basename(audioPath),
        size: `${fileSizeMB} MB`
      });

      return audioPath;
    } catch (error) {
      this.logger.error('音频转换失败', { 
        videoPath, 
        error: error instanceof Error ? error.message : error 
      });
      throw error;
    }
  }

  /**
   * 处理音频专用房间的视频
   */
  async processAudioOnlyRoom(videoPath: string, roomId?: number): Promise<string | null> {
    const filename = path.basename(videoPath);
    
    // 如果没有提供roomId，从文件名提取
    let actualRoomId: number | undefined = roomId;
    if (!actualRoomId) {
      const extractedRoomId = this.extractRoomIdFromFilename(filename);
      if (extractedRoomId !== null) {
        actualRoomId = extractedRoomId;
      }
    }

    if (!actualRoomId) {
      this.logger.warn('无法从文件名提取房间ID', { filename });
      return null;
    }

    if (!this.isAudioOnlyRoom(actualRoomId)) {
      this.logger.debug('房间不是音频专用房间', { roomId: actualRoomId });
      return null;
    }

    this.logger.info('检测到音频专用房间，开始处理', { roomId: actualRoomId, videoPath });

    try {
      // 获取音频格式配置
      const audioFormat = this.config.defaultFormat || '.m4a';
      
      // 转换视频为音频
      const audioPath = await this.convertVideoToAudio(videoPath, audioFormat);

      // 是否删除原始视频
      if (!this.config.keepOriginalVideo) {
        this.logger.info('删除原始视频文件', { file: path.basename(videoPath) });
        try {
          await unlink(videoPath);
          this.logger.info('原始视频已删除');
        } catch (deleteError) {
          this.logger.warn('删除原始视频失败', {
            error: deleteError instanceof Error ? deleteError.message : deleteError
          });
        }
      } else {
        this.logger.info('保留原始视频文件');
      }

      return audioPath;
    } catch (error) {
      this.logger.error('音频专用房间处理失败', {
        roomId: actualRoomId,
        error: error instanceof Error ? error.message : error
      });
      return null;
    }
  }

  /**
   * 主处理函数（供外部调用）
   */
  async processVideoForAudio(videoPath: string, roomId?: number): Promise<string | null> {
    if (!this.config.enabled) {
      this.logger.info('音频处理功能已禁用');
      return null;
    }

    // 检查FFmpeg是否可用
    const ffmpegAvailable = await this.checkFfmpegAvailability();
    if (!ffmpegAvailable) {
      this.logger.warn('FFmpeg不可用，跳过音频处理');
      return null;
    }

    // 检查文件是否存在
    try {
      await stat(videoPath);
    } catch (error) {
      this.logger.error('视频文件不存在', { videoPath });
      return null;
    }

    // 处理音频专用房间
    return await this.processAudioOnlyRoom(videoPath, roomId);
  }

  /**
   * 批量处理视频文件
   * @param videoPaths 视频文件路径数组
   * @returns 处理结果数组
   */
  async batchProcessVideos(videoPaths: string[]): Promise<Array<{ videoPath: string; audioPath: string | null; success: boolean }>> {
    const results = [];
    
    for (const videoPath of videoPaths) {
      try {
        const audioPath = await this.processVideoForAudio(videoPath);
        results.push({
          videoPath,
          audioPath,
          success: audioPath !== null
        });
      } catch (error) {
        this.logger.error('批量处理视频失败', { 
          videoPath, 
          error: error instanceof Error ? error.message : error 
        });
        results.push({
          videoPath,
          audioPath: null,
          success: false
        });
      }
    }
    
    return results;
  }

  /**
   * 获取音频处理统计信息
   */
  getStats(): {
    enabled: boolean;
    audioOnlyRoomsCount: number;
    ffmpegPath: string;
    defaultFormat: string;
  } {
    return {
      enabled: this.config.enabled,
      audioOnlyRoomsCount: this.config.audioOnlyRooms.length,
      ffmpegPath: this.config.ffmpegPath,
      defaultFormat: this.config.defaultFormat
    };
  }
}

/**
 * 创建音频处理服务实例
 */
export function createAudioProcessor(): IAudioProcessor {
  return new AudioProcessor();
}