"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FusionError = exports.AudioProcessingError = exports.WebhookError = exports.AIError = exports.FileSystemError = exports.NetworkError = exports.TimeoutError = exports.ServiceUnavailableError = exports.BadRequestError = exports.ConflictError = exports.NotFoundError = exports.AuthorizationError = exports.AuthenticationError = exports.ConfigurationError = exports.ValidationError = exports.AppError = void 0;
/**
 * 应用错误基类
 */
class AppError extends Error {
    code;
    statusCode;
    isOperational;
    details;
    cause;
    constructor(message, code = 'INTERNAL_ERROR', statusCode = 500, isOperational = true, details, cause) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        this.details = details;
        this.cause = cause;
        // 保持正确的堆栈跟踪
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
        // 如果有原因错误，合并堆栈
        if (cause && cause.stack) {
            this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
        }
    }
    /**
     * 转换为JSON对象
     */
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            code: this.code,
            statusCode: this.statusCode,
            isOperational: this.isOperational,
            details: this.details,
            stack: this.stack,
            cause: this.cause ? {
                name: this.cause.name,
                message: this.cause.message,
                stack: this.cause.stack
            } : undefined
        };
    }
    /**
     * 转换为字符串
     */
    toString() {
        return `${this.name} [${this.code}]: ${this.message}`;
    }
}
exports.AppError = AppError;
/**
 * 验证错误
 */
class ValidationError extends AppError {
    constructor(message, details, cause) {
        super(message, 'VALIDATION_ERROR', 400, true, details, cause);
    }
}
exports.ValidationError = ValidationError;
/**
 * 配置错误
 */
class ConfigurationError extends AppError {
    constructor(message, details, cause) {
        super(message, 'CONFIGURATION_ERROR', 500, true, details, cause);
    }
}
exports.ConfigurationError = ConfigurationError;
/**
 * 认证错误
 */
class AuthenticationError extends AppError {
    constructor(message = 'Authentication required', details, cause) {
        super(message, 'AUTHENTICATION_ERROR', 401, true, details, cause);
    }
}
exports.AuthenticationError = AuthenticationError;
/**
 * 授权错误
 */
class AuthorizationError extends AppError {
    constructor(message = 'Permission denied', details, cause) {
        super(message, 'AUTHORIZATION_ERROR', 403, true, details, cause);
    }
}
exports.AuthorizationError = AuthorizationError;
/**
 * 资源未找到错误
 */
class NotFoundError extends AppError {
    constructor(message = 'Resource not found', details, cause) {
        super(message, 'NOT_FOUND_ERROR', 404, true, details, cause);
    }
}
exports.NotFoundError = NotFoundError;
/**
 * 冲突错误
 */
class ConflictError extends AppError {
    constructor(message = 'Resource conflict', details, cause) {
        super(message, 'CONFLICT_ERROR', 409, true, details, cause);
    }
}
exports.ConflictError = ConflictError;
/**
 * 请求错误
 */
class BadRequestError extends AppError {
    constructor(message = 'Bad request', details, cause) {
        super(message, 'BAD_REQUEST_ERROR', 400, true, details, cause);
    }
}
exports.BadRequestError = BadRequestError;
/**
 * 服务不可用错误
 */
class ServiceUnavailableError extends AppError {
    constructor(message = 'Service unavailable', details, cause) {
        super(message, 'SERVICE_UNAVAILABLE_ERROR', 503, true, details, cause);
    }
}
exports.ServiceUnavailableError = ServiceUnavailableError;
/**
 * 超时错误
 */
class TimeoutError extends AppError {
    constructor(message = 'Operation timeout', details, cause) {
        super(message, 'TIMEOUT_ERROR', 408, true, details, cause);
    }
}
exports.TimeoutError = TimeoutError;
/**
 * 网络错误
 */
class NetworkError extends AppError {
    constructor(message = 'Network error', details, cause) {
        super(message, 'NETWORK_ERROR', 502, true, details, cause);
    }
}
exports.NetworkError = NetworkError;
/**
 * 文件系统错误
 */
class FileSystemError extends AppError {
    constructor(message, details, cause) {
        super(message, 'FILE_SYSTEM_ERROR', 500, true, details, cause);
    }
}
exports.FileSystemError = FileSystemError;
/**
 * AI服务错误
 */
class AIError extends AppError {
    constructor(message, details, cause) {
        super(message, 'AI_SERVICE_ERROR', 500, true, details, cause);
    }
}
exports.AIError = AIError;
/**
 * Webhook错误
 */
class WebhookError extends AppError {
    constructor(message, details, cause) {
        super(message, 'WEBHOOK_ERROR', 500, true, details, cause);
    }
}
exports.WebhookError = WebhookError;
/**
 * 音频处理错误
 */
class AudioProcessingError extends AppError {
    constructor(message, details, cause) {
        super(message, 'AUDIO_PROCESSING_ERROR', 500, true, details, cause);
    }
}
exports.AudioProcessingError = AudioProcessingError;
/**
 * 字幕融合错误
 */
class FusionError extends AppError {
    constructor(message, details, cause) {
        super(message, 'FUSION_ERROR', 500, true, details, cause);
    }
}
exports.FusionError = FusionError;
//# sourceMappingURL=AppError.js.map