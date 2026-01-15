"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RotatingFileTransport = exports.FileTransport = exports.ConsoleTransport = void 0;
const fs = require("fs");
const path = require("path");
const LogFormatter_1 = require("./LogFormatter");
/**
 * 控制台传输器
 */
class ConsoleTransport {
    formatter;
    constructor(formatter) {
        this.formatter = formatter || new LogFormatter_1.DefaultLogFormatter();
    }
    write(entry) {
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
    async flush() {
        // 控制台不需要刷新
    }
    async close() {
        // 控制台不需要关闭
    }
}
exports.ConsoleTransport = ConsoleTransport;
/**
 * 文件传输器
 */
class FileTransport {
    // 文件路径属性，虽然当前未直接使用，但保留供未来扩展
    _filePath;
    formatter;
    stream = null;
    buffer = [];
    bufferSize = 100;
    flushInterval = null;
    constructor(filePath, formatter) {
        this._filePath = filePath;
        this.formatter = formatter || new LogFormatter_1.DefaultLogFormatter();
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
    write(entry) {
        const formatted = this.formatter.format(entry);
        this.buffer.push(formatted + '\n');
        // 如果缓冲区满了，立即刷新
        if (this.buffer.length >= this.bufferSize) {
            this.flush();
        }
    }
    async flush() {
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
                }
                else {
                    resolve();
                }
            });
        });
    }
    async close() {
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
                this.stream.end((error) => {
                    if (error) {
                        reject(error);
                    }
                    else {
                        this.stream = null;
                        resolve();
                    }
                });
            });
        }
    }
}
exports.FileTransport = FileTransport;
/**
 * 轮转文件传输器
 */
class RotatingFileTransport {
    basePath;
    maxSize;
    maxFiles;
    currentSize = 0;
    currentFileIndex = 0;
    currentStream = null;
    formatter;
    constructor(basePath, maxSize = 10 * 1024 * 1024, maxFiles = 5, formatter) {
        this.basePath = basePath;
        this.maxSize = maxSize;
        this.maxFiles = maxFiles;
        this.formatter = formatter || new LogFormatter_1.DefaultLogFormatter();
        // 确保目录存在
        const dir = path.dirname(basePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        // 初始化当前文件
        this.initializeCurrentFile();
    }
    initializeCurrentFile() {
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
                }
                else {
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
                }
                catch (error) {
                    this.currentSize = 0;
                }
            }
        }
        this.openCurrentFile();
    }
    openCurrentFile() {
        const filePath = this.getCurrentFilePath();
        if (this.currentStream) {
            this.currentStream.end();
        }
        this.currentStream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
        // 获取文件大小
        try {
            const stats = fs.statSync(filePath);
            this.currentSize = stats.size;
        }
        catch (error) {
            this.currentSize = 0;
        }
    }
    getCurrentFilePath() {
        const dir = path.dirname(this.basePath);
        const baseName = path.basename(this.basePath, '.log');
        if (this.currentFileIndex === 0) {
            return this.basePath;
        }
        else {
            return path.join(dir, `${baseName}.${this.currentFileIndex}.log`);
        }
    }
    rotateIfNeeded() {
        if (this.currentSize >= this.maxSize) {
            this.currentFileIndex++;
            this.currentSize = 0;
            this.openCurrentFile();
            this.cleanupOldFiles();
        }
    }
    cleanupOldFiles() {
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
            }
            catch (error) {
                console.warn(`Failed to delete old log file: ${filePath}`, error);
            }
        }
    }
    write(entry) {
        const formatted = this.formatter.format(entry);
        const line = formatted + '\n';
        const lineSize = Buffer.byteLength(line, 'utf8');
        this.rotateIfNeeded();
        if (this.currentStream) {
            this.currentStream.write(line);
            this.currentSize += lineSize;
        }
    }
    async flush() {
        if (this.currentStream) {
            return new Promise((resolve) => {
                this.currentStream.write('', () => resolve());
            });
        }
    }
    async close() {
        if (this.currentStream) {
            return new Promise((resolve, reject) => {
                this.currentStream.end((error) => {
                    if (error) {
                        reject(error);
                    }
                    else {
                        this.currentStream = null;
                        resolve();
                    }
                });
            });
        }
    }
}
exports.RotatingFileTransport = RotatingFileTransport;
//# sourceMappingURL=LogTransport.js.map