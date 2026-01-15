import { LogEntry, LogTransport as ILogTransport, LogFormatter } from './LoggerInterface';
/**
 * 控制台传输器
 */
export declare class ConsoleTransport implements ILogTransport {
    private formatter;
    constructor(formatter?: LogFormatter);
    write(entry: LogEntry): void;
    flush(): Promise<void>;
    close(): Promise<void>;
}
/**
 * 文件传输器
 */
export declare class FileTransport implements ILogTransport {
    private readonly _filePath;
    private formatter;
    private stream;
    private buffer;
    private bufferSize;
    private flushInterval;
    constructor(filePath: string, formatter?: LogFormatter);
    write(entry: LogEntry): void;
    flush(): Promise<void>;
    close(): Promise<void>;
}
/**
 * 轮转文件传输器
 */
export declare class RotatingFileTransport implements ILogTransport {
    private basePath;
    private maxSize;
    private maxFiles;
    private currentSize;
    private currentFileIndex;
    private currentStream;
    private formatter;
    constructor(basePath: string, maxSize?: number, maxFiles?: number, formatter?: LogFormatter);
    private initializeCurrentFile;
    private openCurrentFile;
    private getCurrentFilePath;
    private rotateIfNeeded;
    private cleanupOldFiles;
    write(entry: LogEntry): void;
    flush(): Promise<void>;
    close(): Promise<void>;
}
