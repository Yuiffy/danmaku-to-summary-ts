/**
 * 应用错误基类
 */
export declare class AppError extends Error {
    readonly code: string;
    readonly statusCode: number;
    readonly isOperational: boolean;
    readonly details?: Record<string, any>;
    readonly cause?: Error;
    constructor(message: string, code?: string, statusCode?: number, isOperational?: boolean, details?: Record<string, any>, cause?: Error);
    /**
     * 转换为JSON对象
     */
    toJSON(): Record<string, any>;
    /**
     * 转换为字符串
     */
    toString(): string;
}
/**
 * 验证错误
 */
export declare class ValidationError extends AppError {
    constructor(message: string, details?: Record<string, any>, cause?: Error);
}
/**
 * 配置错误
 */
export declare class ConfigurationError extends AppError {
    constructor(message: string, details?: Record<string, any>, cause?: Error);
}
/**
 * 认证错误
 */
export declare class AuthenticationError extends AppError {
    constructor(message?: string, details?: Record<string, any>, cause?: Error);
}
/**
 * 授权错误
 */
export declare class AuthorizationError extends AppError {
    constructor(message?: string, details?: Record<string, any>, cause?: Error);
}
/**
 * 资源未找到错误
 */
export declare class NotFoundError extends AppError {
    constructor(message?: string, details?: Record<string, any>, cause?: Error);
}
/**
 * 冲突错误
 */
export declare class ConflictError extends AppError {
    constructor(message?: string, details?: Record<string, any>, cause?: Error);
}
/**
 * 请求错误
 */
export declare class BadRequestError extends AppError {
    constructor(message?: string, details?: Record<string, any>, cause?: Error);
}
/**
 * 服务不可用错误
 */
export declare class ServiceUnavailableError extends AppError {
    constructor(message?: string, details?: Record<string, any>, cause?: Error);
}
/**
 * 超时错误
 */
export declare class TimeoutError extends AppError {
    constructor(message?: string, details?: Record<string, any>, cause?: Error);
}
/**
 * 网络错误
 */
export declare class NetworkError extends AppError {
    constructor(message?: string, details?: Record<string, any>, cause?: Error);
}
/**
 * 文件系统错误
 */
export declare class FileSystemError extends AppError {
    constructor(message: string, details?: Record<string, any>, cause?: Error);
}
/**
 * AI服务错误
 */
export declare class AIError extends AppError {
    constructor(message: string, details?: Record<string, any>, cause?: Error);
}
/**
 * Webhook错误
 */
export declare class WebhookError extends AppError {
    constructor(message: string, details?: Record<string, any>, cause?: Error);
}
/**
 * 音频处理错误
 */
export declare class AudioProcessingError extends AppError {
    constructor(message: string, details?: Record<string, any>, cause?: Error);
}
/**
 * 字幕融合错误
 */
export declare class FusionError extends AppError {
    constructor(message: string, details?: Record<string, any>, cause?: Error);
}
