import { getLogger } from '../../core/logging/LogManager';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * 漫画生成服务接口
 */
export interface IComicGeneratorService {
  /**
   * 从AI_HIGHLIGHT文件生成漫画
   * @param highlightPath AI_HIGHLIGHT.txt文件路径
   * @param roomId 房间ID（可选）
   * @returns 生成的漫画文件路径
   */
  generateComicFromHighlight(highlightPath: string, roomId?: string): Promise<string | null>;

  /**
   * 批量生成漫画
   * @param directory 包含AI_HIGHLIGHT文件的目录
   * @returns 成功生成的文件数量
   */
  generateComicsInBatch(directory: string): Promise<number>;
}

/**
 * 漫画生成服务实现
 * 使用Python脚本进行漫画生成
 */
export class ComicGeneratorService implements IComicGeneratorService {
  private logger = getLogger('ComicGeneratorService');
  private pythonScriptPath: string;
  private nodeScriptPath: string;

  constructor() {
    // 获取脚本路径
    const scriptsDir = path.join(__dirname, '../../../scripts');
    this.pythonScriptPath = path.join(scriptsDir, 'ai_comic_generator.py');
    this.nodeScriptPath = path.join(scriptsDir, 'ai_text_generator.js');
  }

  /**
   * 检查Python脚本是否存在
   */
  private async checkPythonScript(): Promise<boolean> {
    try {
      await fs.access(this.pythonScriptPath);
      return true;
    } catch {
      this.logger.error(`Python脚本不存在: ${this.pythonScriptPath}`);
      return false;
    }
  }

  /**
   * 检查Node脚本是否存在
   */
  private async checkNodeScript(): Promise<boolean> {
    try {
      await fs.access(this.nodeScriptPath);
      return true;
    } catch {
      this.logger.warn(`Node脚本不存在: ${this.nodeScriptPath}`);
      return false;
    }
  }

  /**
   * 从AI_HIGHLIGHT文件生成漫画
   */
  async generateComicFromHighlight(highlightPath: string, roomId?: string): Promise<string | null> {
    try {
      // 检查输入文件
      await fs.access(highlightPath);
      
      // 检查Python脚本
      if (!(await this.checkPythonScript())) {
        return null;
      }

      this.logger.info(`开始生成漫画: ${path.basename(highlightPath)}`, { roomId });
 
      // 构建命令行参数
      const args = [this.pythonScriptPath, highlightPath];
      if (roomId) {
        args.push('--room-id', roomId);
      }
 
      // 调用Python脚本
      return new Promise((resolve, reject) => {
        const pythonProcess = spawn('python', args, {
          env: process.env,
          cwd: path.dirname(this.pythonScriptPath),
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '';
        let errorOutput = '';

        pythonProcess.stdout.on('data', (data) => {
          output += data.toString();
          this.logger.debug(`Python输出: ${data.toString().trim()}`);
        });

        pythonProcess.stderr.on('data', (data) => {
          errorOutput += data.toString();
          this.logger.warn(`Python错误: ${data.toString().trim()}`);
        });

        pythonProcess.on('close', (code) => {
          if (code === 0) {
            // 从输出中提取生成的漫画文件路径
            const comicPath = this.extractComicPathFromOutput(output, highlightPath);
            if (comicPath) {
              this.logger.info(`漫画生成成功: ${path.basename(comicPath)}`);
              resolve(comicPath);
            } else {
              this.logger.error('无法从输出中提取漫画文件路径');
              resolve(null);
            }
          } else {
            this.logger.error(`Python脚本执行失败，退出码: ${code}`, { errorOutput });
            reject(new Error(`漫画生成失败: ${errorOutput}`));
          }
        });

        pythonProcess.on('error', (error) => {
          this.logger.error(`启动Python进程失败: ${error.message}`);
          reject(error);
        });
      });
    } catch (error: any) {
      this.logger.error(`生成漫画失败: ${error.message}`, { error, highlightPath });
      return null;
    }
  }

  /**
   * 从Python脚本输出中提取生成的漫画文件路径
   */
  private extractComicPathFromOutput(output: string, highlightPath: string): string | null {
    try {
      // 方法1：从输出中查找路径模式
      const pathPatterns = [
        /输出文件:\s*(.+\.png)/i,
        /图像已保存:\s*(.+\.png)/i,
        /漫画图片已保存:\s*(.+\.png)/i,
        /COMIC_FACTORY\.png/i
      ];

      for (const pattern of pathPatterns) {
        const match = output.match(pattern);
        if (match) {
          let foundPath = match[1] || match[0];
          
          // 如果是相对路径，转换为绝对路径
          if (!path.isAbsolute(foundPath)) {
            const highlightDir = path.dirname(highlightPath);
            foundPath = path.join(highlightDir, foundPath);
          }
          
          return foundPath;
        }
      }

      // 方法2：基于输入文件路径推断输出路径
      const highlightName = path.basename(highlightPath);
      const baseName = highlightName.replace('_AI_HIGHLIGHT.txt', '');
      const highlightDir = path.dirname(highlightPath);
      const inferredPath = path.join(highlightDir, `${baseName}_COMIC_FACTORY.png`);

      // 检查文件是否存在
      try {
        fs.access(inferredPath);
        return inferredPath;
      } catch {
        // 文件不存在
        return null;
      }
    } catch (error) {
      this.logger.error(`提取漫画文件路径失败: ${error}`);
      return null;
    }
  }

  /**
   * 批量生成漫画
   */
  async generateComicsInBatch(directory: string): Promise<number> {
    try {
      // 检查目录
      await fs.access(directory);

      // 检查Python脚本
      if (!(await this.checkPythonScript())) {
        return 0;
      }

      this.logger.info(`开始批量生成漫画: ${directory}`);

      // 调用Python脚本的批量模式
      return new Promise((resolve, reject) => {
        const pythonProcess = spawn('python', [this.pythonScriptPath, '--batch', directory], {
          cwd: path.dirname(this.pythonScriptPath),
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '';
        let errorOutput = '';

        pythonProcess.stdout.on('data', (data) => {
          output += data.toString();
          this.logger.debug(`Python批量输出: ${data.toString().trim()}`);
        });

        pythonProcess.stderr.on('data', (data) => {
          errorOutput += data.toString();
          this.logger.warn(`Python批量错误: ${data.toString().trim()}`);
        });

        pythonProcess.on('close', (code) => {
          if (code === 0) {
            // 从输出中提取成功数量
            const successCount = this.extractSuccessCountFromOutput(output);
            this.logger.info(`批量生成完成，成功: ${successCount} 个`);
            resolve(successCount);
          } else {
            this.logger.error(`Python批量脚本执行失败，退出码: ${code}`, { errorOutput });
            reject(new Error(`批量生成失败: ${errorOutput}`));
          }
        });

        pythonProcess.on('error', (error) => {
          this.logger.error(`启动Python批量进程失败: ${error.message}`);
          reject(error);
        });
      });
    } catch (error: any) {
      this.logger.error(`批量生成漫画失败: ${error.message}`, { error, directory });
      return 0;
    }
  }

  /**
   * 从批量输出中提取成功数量
   */
  private extractSuccessCountFromOutput(output: string): number {
    try {
      const successPatterns = [
        /成功:\s*(\d+)\s*个/i,
        /成功:\s*(\d+)/i,
        /\[OK\]\s*成功:\s*(\d+)/i
      ];

      for (const pattern of successPatterns) {
        const match = output.match(pattern);
        if (match) {
          return parseInt(match[1], 10);
        }
      }

      // 如果没有找到明确的数量，尝试统计生成的COMIC_FACTORY文件
      const comicCount = (output.match(/COMIC_FACTORY\.png/g) || []).length;
      return comicCount;
    } catch (error) {
      this.logger.error(`提取成功数量失败: ${error}`);
      return 0;
    }
  }

  /**
   * 使用Node脚本生成文本（备用方案）
   */
  async generateTextWithNode(highlightContent: string): Promise<string | null> {
    try {
      if (!(await this.checkNodeScript())) {
        return null;
      }

      return new Promise((resolve, reject) => {
        const nodeProcess = spawn('node', [this.nodeScriptPath, '--generate-text'], {
          cwd: path.dirname(this.nodeScriptPath),
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '';
        let errorOutput = '';

        nodeProcess.stdin.write(highlightContent);
        nodeProcess.stdin.end();

        nodeProcess.stdout.on('data', (data) => {
          output += data.toString();
        });

        nodeProcess.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });

        nodeProcess.on('close', (code) => {
          if (code === 0 && output.trim()) {
            resolve(output.trim());
          } else {
            this.logger.warn(`Node文本生成失败，退出码: ${code}`, { errorOutput });
            resolve(null);
          }
        });

        nodeProcess.on('error', (error) => {
          this.logger.error(`启动Node进程失败: ${error.message}`);
          resolve(null);
        });
      });
    } catch (error: any) {
      this.logger.error(`Node文本生成失败: ${error.message}`);
      return null;
    }
  }
}