import { Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { IWebhookHandler } from '../IWebhookService';
import { getLogger } from '../../../core/logging/LogManager';
import { ConfigProvider } from '../../../core/config/ConfigProvider';
import { FileStabilityChecker } from '../FileStabilityChecker';
import { DuplicateProcessorGuard } from '../DuplicateProcessorGuard';
import { listRelevantProcesses, terminateProcessTree } from '../../../utils/processCleanup';

/**
 * 音频文件处理器 - 处理m4a/mp3等音频文件
 * 从文件名中提取直播间ID和其他信息，自动查找对应XML并启动处理
 */
export class AudioFileHandler implements IWebhookHandler {
  readonly name = 'Audio File Handler';
  readonly path = '/handle-file';
  readonly enabled = true;

  private logger = getLogger('AudioFileHandler');
  private stabilityChecker = new FileStabilityChecker();
  private duplicateGuard = new DuplicateProcessorGuard();

  /**
   * 注册Express路由
   */
  registerRoutes(app: any): void {
    // POST端点：接收文件路径
    app.post(this.path, this.handleRequest.bind(this));
    
    // GET端点：用于测试
    app.get(`${this.path}/test`, this.handleTestRequest.bind(this));
    
    this.logger.info(`注册${this.name}处理器，路径: ${this.path}`);
  }

  /**
   * 处理测试请求
   */
  private async handleTestRequest(req: Request, res: Response): Promise<void> {
    try {
      res.json({
        name: this.name,
        path: this.path,
        enabled: this.enabled,
        description: '音频文件处理器 - 从文件名中提取信息并自动查找XML',
        example: {
          method: 'POST',
          endpoint: `${this.path}`,
          body: {
            filePath: '录制-1741667419-20260116-192814-176-浣熊咖啡厅正式营业！.m4a'
          }
        }
      });
    } catch (error: any) {
      this.logger.error(`处理测试请求时出错: ${error.message}`, { error });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * 处理请求
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    try {
      const payload = req.body;
      const eventTime = new Date().toLocaleString();

      // 验证请求
      if (!this.validateRequest(req)) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }

      this.logger.info(`\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`);
      this.logger.info(`📅 时间: ${eventTime}`);
      this.logger.info(`📨 事件: 音频/视频文件处理`);

      // 处理音频文件
      const result = await this.processAudioFile(payload);

      this.logger.info(`▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`);

      res.json(result);
    } catch (error: any) {
      this.logger.error(`处理音频文件请求时出错: ${error.message}`, { error });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * 验证请求有效性
   */
  validateRequest(req: Request): boolean {
    if (!req.body || typeof req.body !== 'object') {
      this.logger.warn('无效的请求体');
      return false;
    }

    const payload = req.body;
    if (!payload.filePath && typeof payload.filePath !== 'string') {
      this.logger.warn('缺少filePath字段或类型不正确');
      return false;
    }

    return true;
  }

  /**
   * 处理音频文件
   * 从文件名中提取信息，查找对应的XML，启动处理
   */
  private async processAudioFile(payload: any): Promise<any> {
    const filePath = payload.filePath;
    const forceWithoutDuplicateCheck = payload.forceWithoutDuplicateCheck === true;
    const fileName = path.basename(filePath);
    const fileExtension = fileName.split('.').pop()?.toLowerCase() || '';

    this.logger.info(`开始处理音频文件: ${fileName}`);

    // 验证文件类型
    const audioExtensions = ['m4a', 'mp3', 'wav', 'aac', 'flac', 'mp4', 'flv', 'mkv', 'ts', 'mov'];
    if (!audioExtensions.includes(fileExtension)) {
      const errorMsg = `不支持的文件类型: ${fileExtension}`;
      this.logger.error(errorMsg);
      return {
        success: false,
        error: errorMsg,
        filePath
      };
    }

    try {
      // 1. 从文件名中提取信息
      const extractedInfo = this.extractInfoFromFileName(fileName);
      if (!extractedInfo) {
        return {
          success: false,
          error: '无法从文件名中提取信息，文件名格式应为: 录制-<直播间ID>-<时间>-<标题>.m4a',
          filePath
        };
      }

      this.logger.info(`✓ 从文件名中提取信息成功`, {
        roomId: extractedInfo.roomId,
        timestamp: extractedInfo.timestamp,
        title: extractedInfo.title
      });

      // 2. 检查文件是否存在
      if (!fs.existsSync(filePath)) {
        this.logger.info(`文件不存在: ${filePath}`);
        return {
          success: false,
          error: `文件不存在: ${filePath}`,
          filePath
        };
      }

      this.logger.info(`✓ 文件存在验证成功`);

      // 3. 检查去重
      if (!forceWithoutDuplicateCheck && this.duplicateGuard.isDuplicate(filePath)) {
        this.logger.warn(`文件已在处理队列中: ${fileName}`);
        return {
          success: false,
          error: 'File already being processed',
          filePath,
          roomId: extractedInfo.roomId
        };
      }

      // 标记为处理中
      this.duplicateGuard.markAsProcessing(filePath);

      // 4. 等待文件稳定
      // const isStable = await this.stabilityChecker.waitForFileStability(filePath);
      // if (!isStable) {
      //   this.logger.error(`文件稳定性检查失败: ${fileName}`);
      //   this.duplicateGuard.markAsProcessed(filePath);
      //   return {
      //     success: false,
      //     error: 'File stability check failed',
      //     filePath,
      //     roomId: extractedInfo.roomId
      //   };
      // }

      // this.logger.info(`✓ 文件稳定性验证成功`);

      // 5. 查找对应的XML文件
      const xmlPath = await this.findCorrespondingXML(filePath, extractedInfo);
      
      if (xmlPath) {
        this.logger.info(`✓ 找到对应的XML文件: ${path.basename(xmlPath)}`);
      } else {
        this.logger.warn(`⚠ 未找到对应的XML文件，将继续处理`);
      }

      // 6. 启动处理流程
      await this.startProcessing(filePath, xmlPath, extractedInfo);

      this.logger.info(`✓ 处理流程已启动`, {
        audioFile: fileName,
        roomId: extractedInfo.roomId,
        xmlFile: xmlPath ? path.basename(xmlPath) : 'N/A'
      });

      return {
        success: true,
        message: '处理流程已启动',
        filePath,
        xmlPath: xmlPath || null,
        roomId: extractedInfo.roomId,
        timestamp: extractedInfo.timestamp,
        title: extractedInfo.title
      };

    } catch (error: any) {
      this.logger.error(`处理音频文件时出错: ${error.message}`, { error });
      this.duplicateGuard.markAsProcessed(filePath);
      return {
        success: false,
        error: error.message,
        filePath
      };
    }
  }

  /**
   * 从文件名中提取信息
   * 文件名格式: 录制-<直播间ID>-<日期>-<时间>-<序号>-<标题>.m4a
   * 例如: 录制-1741667419-20260116-192814-176-浣熊咖啡厅正式营业！.m4a
   */
  private extractInfoFromFileName(fileName: string): {
    roomId: string;
    timestamp: string;
    title: string;
  } | null {
    // 移除扩展名
    const nameWithoutExt = fileName.replace(/\.[^.]+$/, '');

    // 分割文件名
    const parts = nameWithoutExt.split('-');
    
    // 格式检查: 录制-<roomId>-<date>-<time>-<seq>-<title>
    // 至少需要6个部分: [录制, roomId, date, time, seq, title]
    if (parts.length < 6 || parts[0] !== '录制') {
      this.logger.warn(`文件名格式不匹配: ${fileName}`);
      return null;
    }

    const roomId = parts[1];
    const date = parts[2];
    const time = parts[3];
    const title = parts.slice(5).join('-'); // 标题可能包含-

    // 验证roomId是否为数字
    if (!/^\d+$/.test(roomId)) {
      this.logger.warn(`直播间ID格式不正确: ${roomId}`);
      return null;
    }

    const timestamp = `${date} ${time}`;

    return {
      roomId,
      timestamp,
      title
    };
  }

  /**
   * 查找对应的XML文件
   * 在相同目录或预配置的目录中查找对应的XML文件
   */
  private async findCorrespondingXML(
    audioFilePath: string,
    extractedInfo: { roomId: string; timestamp: string; title: string }
  ): Promise<string | null> {
    try {
      const audioDir = path.dirname(audioFilePath);
      const fileName = path.basename(audioFilePath, path.extname(audioFilePath));

      // 1. 在同一目录下查找对应的XML
      // 尝试查找相同基础名称的XML
      const possibleXmlNames = [
        `${fileName}.xml`, // 完全相同的名称
        `${extractedInfo.roomId}.xml`, // 直播间ID作为文件名
      ];

      for (const xmlName of possibleXmlNames) {
        const xmlPath = path.join(audioDir, xmlName);
        if (fs.existsSync(xmlPath)) {
          this.logger.info(`在同一目录下找到XML: ${xmlName}`);
          return xmlPath;
        }
      }

      // 2. 在上级目录或预配置目录中查找
      const searchDirs = [
        audioDir,
        path.dirname(audioDir) // 父目录
      ];

      for (const searchDir of searchDirs) {
        if (!fs.existsSync(searchDir)) continue;

        const files = fs.readdirSync(searchDir);
        
        // 查找包含直播间ID或相关标题的XML文件
        const matchingXmls = files.filter(file => {
          if (!file.endsWith('.xml')) return false;
          
          // 匹配条件：包含直播间ID或时间戳
          return file.includes(extractedInfo.roomId) ||
                 file.includes(extractedInfo.title);
        });

        if (matchingXmls.length > 0) {
          const xmlPath = path.join(searchDir, matchingXmls[0]);
          this.logger.info(`在${searchDir}中找到XML: ${matchingXmls[0]}`);
          return xmlPath;
        }
      }

      this.logger.info(`未找到对应的XML文件`);
      return null;

    } catch (error: any) {
      this.logger.error(`查找XML文件时出错: ${error.message}`, { error });
      return null;
    }
  }

  /**
   * 启动处理流程
   */
  private async startProcessing(
    audioPath: string,
    xmlPath: string | null,
    extractedInfo: { roomId: string; timestamp: string; title: string }
  ): Promise<void> {
    try {
      const config = ConfigProvider.getConfig();
      const scriptPath = 'src/scripts/enhanced_auto_summary.js'; // 硬编码路径，后续可从配置读取

      // 构建参数：音频文件作为第一个参数，XML作为第二个参数
      const args = [scriptPath, audioPath];
      
      // 确保XML路径被正确传入
      if (xmlPath) {
        const normalizedXmlPath = path.normalize(xmlPath);
        args.push(normalizedXmlPath);
        this.logger.info(`✓ XML文件路径已添加到处理参数: ${normalizedXmlPath}`);
      } else {
        this.logger.warn(`⚠ 未找到XML文件，仅处理音频`);
      }

      this.logger.info(`启动处理流程: ${path.basename(audioPath)}`);

      // 启动子进程
      const ps: ChildProcess = spawn('node', args, {
        cwd: process.cwd(),
        windowsHide: true,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          ROOM_ID: extractedInfo.roomId
        }
      });
      this.logger.info(`处理子进程已启动: pid=${ps.pid ?? 'unknown'}, file=${path.basename(audioPath)}`);

      // spawn 成功，子进程已启动，立即释放文件锁
      // 这样相同的文件可以再次被处理（用于重试场景）
      this.duplicateGuard.markAsProcessed(audioPath);
      this.logger.info(`✓ 子进程已启动，释放文件锁: ${path.basename(audioPath)}`);

      // 设置超时
      const processTimeout = config.webhook.timeouts.processTimeout || 30 * 60 * 1000; // 30分钟
      const timeoutId = setTimeout(async () => {
        this.logger.warn(`进程超时，强制终止: ${path.basename(audioPath)}`);
        await terminateProcessTree(ps, {
          gracePeriodMs: 5000,
          label: `Audio处理进程(${path.basename(audioPath)})`,
          logger: this.logger
        });
        const processes = await listRelevantProcesses();
        if (processes.length > 0) {
          this.logger.warn(`超时清理后的相关进程快照: ${processes.join(' | ')}`);
        }
      }, processTimeout);

      // 处理输出
      ps.stdout?.on('data', (data: Buffer) => {
        this.logger.info(`[处理进程] ${data.toString().trim()}`);
      });

      ps.stderr?.on('data', (data: Buffer) => {
        this.logger.error(`[处理进程错误] ${data.toString().trim()}`);
      });

      // 处理进程事件
      ps.on('error', (error: Error) => {
        this.logger.error(`处理进程错误: ${error.message}`);
        clearTimeout(timeoutId);
        // 注意：文件锁已在 spawn 成功时释放，这里无需重复调用
      });

      ps.on('close', (code: number | null) => {
        clearTimeout(timeoutId);
        this.logger.info(`处理流程结束 (退出码: ${code}): ${path.basename(audioPath)}`);
      });

    } catch (error: any) {
      this.logger.error(`启动处理流程时出错: ${error.message}`, { error });
      this.duplicateGuard.markAsProcessed(audioPath);
    }
  }

  /**
   * 睡眠函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
