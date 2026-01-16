import * as fs from 'fs';
import * as path from 'path';
import { LogEntry, LogTransport as ILogTransport, LogFormatter } from './LoggerInterface';
import { DefaultLogFormatter } from './LogFormatter';

/**
 * 控制台传输器
 */
export class ConsoleTransport implements ILogTransport {
  private formatter: LogFormatter;

  constructor(formatter?: LogFormatter) {
    this.formatter = formatter || new DefaultLogFormatter();
  }

  write(entry: LogEntry): void {
    const formatted = this.formatter.format(entry);
    const level = entry.level;
    
    switch (level) {
      case 'error':
        console.error(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'info':
        console.info(formatted);
        break;
      case 'debug':
      case 'verbose':
        console.debug(formatted);
        break;
      default:
        console.log(formatted);
    }
  }

  async flush(): Promise<void> {
    // 控制台不需要刷新
  }

  async close(): Promise<void> {
    // 控制台不需要关闭
  }
}

/**
 * 文件传输器
 */
export class FileTransport implements ILogTransport {
  // 文件路径属性，虽然当前未直接使用，但保留供未来扩展
  private readonly _filePath: string;
  private formatter: LogFormatter;
  private stream: fs.WriteStream | null = null;
  private buffer: string[] = [];
  private bufferSize = 100;
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(filePath: string, formatter?: LogFormatter) {
    this._filePath = filePath;
    this.formatter = formatter || new DefaultLogFormatter();
    
    // 确保目录存在
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // 创建写入流
    this.stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    
    // 设置定时刷新
    this.flushInterval = setInterval(() => this.flush(), 5000);
  }

  write(entry: LogEntry): void {
    const formatted = this.formatter.format(entry);
    this.buffer.push(formatted + '\n');
    
    // 如果缓冲区满了，立即刷新
    if (this.buffer.length >= this.bufferSize) {
      this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.stream) {
      return;
    }
    
    const toWrite = this.buffer.join('');
    this.buffer = [];
    
    return new Promise((resolve, reject) => {
      if (!this.stream) {
        reject(new Error('Stream is closed'));
        return;
      }
      
      this.stream.write(toWrite, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async close(): Promise<void> {
    // 清除定时器
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    
    // 刷新剩余缓冲区
    await this.flush();
    
    // 关闭流
    if (this.stream) {
      return new Promise((resolve, reject) => {
        this.stream!.end((error: Error | null | undefined) => {
          if (error) {
            reject(error);
          } else {
            this.stream = null;
            resolve();
          }
        });
      });
    }
  }
}

/**
 * 轮转文件传输器
 */
export class RotatingFileTransport implements ILogTransport {
  private basePath: string;
  private maxSize: number;
  private maxFiles: number;
  private currentSize = 0;
  private currentFileIndex = 0;
  private currentStream: fs.WriteStream | null = null;
  private formatter: LogFormatter;

  constructor(basePath: string, maxSize: number = 10 * 1024 * 1024, maxFiles: number = 5, formatter?: LogFormatter) {
    this.basePath = basePath;
    this.maxSize = maxSize;
    this.maxFiles = maxFiles;
    this.formatter = formatter || new DefaultLogFormatter();
    
    // 确保目录存在
    const dir = path.dirname(basePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // 初始化当前文件
    this.initializeCurrentFile();
  }

  private initializeCurrentFile(): void {
    // 查找最新的日志文件
    const dir = path.dirname(this.basePath);
    const baseName = path.basename(this.basePath, '.log');
    
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir)
        .filter(file => file.startsWith(baseName) && file.endsWith('.log'))
        .sort();
      
      if (files.length > 0) {
        const lastFile = files[files.length - 1];
        const match = lastFile.match(new RegExp(`${baseName}\\.(\\d+)\\.log`));
        if (match) {
          this.currentFileIndex = parseInt(match[1], 10);
        } else {
          this.currentFileIndex = 0;
        }
        
        // 检查文件大小
        const lastFilePath = path.join(dir, lastFile);
        try {
          const stats = fs.statSync(lastFilePath);
          this.currentSize = stats.size;
          
          if (this.currentSize >= this.maxSize) {
            this.currentFileIndex++;
            this.currentSize = 0;
          }
        } catch (error) {
          this.currentSize = 0;
        }
      }
    }
    
    this.openCurrentFile();
  }

  private openCurrentFile(): void {
    const filePath = this.getCurrentFilePath();
    
    if (this.currentStream) {
      this.currentStream.end();
    }
    
    this.currentStream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    
    // 获取文件大小
    try {
      const stats = fs.statSync(filePath);
      this.currentSize = stats.size;
    } catch (error) {
      this.currentSize = 0;
    }
  }

  private getCurrentFilePath(): string {
    const dir = path.dirname(this.basePath);
    const baseName = path.basename(this.basePath, '.log');
    
    if (this.currentFileIndex === 0) {
      return this.basePath;
    } else {
      return path.join(dir, `${baseName}.${this.currentFileIndex}.log`);
    }
  }

  private rotateIfNeeded(): void {
    if (this.currentSize >= this.maxSize) {
      this.currentFileIndex++;
      this.currentSize = 0;
      this.openCurrentFile();
      this.cleanupOldFiles();
    }
  }

  private cleanupOldFiles(): void {
    const dir = path.dirname(this.basePath);
    const baseName = path.basename(this.basePath, '.log');
    
    const files = fs.readdirSync(dir)
      .filter(file => file.startsWith(baseName) && file.endsWith('.log'))
      .sort((a, b) => {
        const aMatch = a.match(new RegExp(`${baseName}\\.(\\d+)\\.log`));
        const bMatch = b.match(new RegExp(`${baseName}\\.(\\d+)\\.log`));
        const aIndex = aMatch ? parseInt(aMatch[1], 10) : 0;
        const bIndex = bMatch ? parseInt(bMatch[1], 10) : 0;
        return bIndex - aIndex; // 降序排序
      });
    
    // 删除超出数量的文件
    for (let i = this.maxFiles; i < files.length; i++) {
      const filePath = path.join(dir, files[i]);
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        console.warn(`Failed to delete old log file: ${filePath}`, error);
      }
    }
  }

  write(entry: LogEntry): void {
    const formatted = this.formatter.format(entry);
    const line = formatted + '\n';
    const lineSize = Buffer.byteLength(line, 'utf8');
    
    this.rotateIfNeeded();
    
    if (this.currentStream) {
      this.currentStream.write(line, 'utf8', () => {
        // 确保数据立即写入，避免缓冲延迟
        if (this.currentStream && this.currentStream.writable) {
          // 不强制 sync，避免性能问题，但确保写入队列
        }
      });
      this.currentSize += lineSize;
    }
  }

  async flush(): Promise<void> {
    if (this.currentStream) {
      return new Promise((resolve) => {
        this.currentStream!.write('', () => resolve());
      });
    }
  }

  async close(): Promise<void> {
    if (this.currentStream) {
      return new Promise((resolve, reject) => {
        this.currentStream!.end((error: Error | null | undefined) => {
          if (error) {
            reject(error);
          } else {
            this.currentStream = null;
            resolve();
          }
        });
      });
    }
  }
}