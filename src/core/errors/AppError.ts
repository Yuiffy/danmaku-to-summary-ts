/**
 * 应用错误基类
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly details?: Record<string, any>;
  public readonly cause?: Error;

  constructor(
    message: string,
    code: string = 'INTERNAL_ERROR',
    statusCode: number = 500,
    isOperational: boolean = true,
    details?: Record<string, any>,
    cause?: Error
  ) {
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
  toJSON(): Record<string, any> {
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
  toString(): string {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

/**
 * 验证错误
 */
export class ValidationError extends AppError {
  constructor(
    message: string,
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message, 'VALIDATION_ERROR', 400, true, details, cause);
  }
}

/**
 * 配置错误
 */
export class ConfigurationError extends AppError {
  constructor(
    message: string,
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message, 'CONFIGURATION_ERROR', 500, true, details, cause);
  }
}

/**
 * 认证错误
 */
export class AuthenticationError extends AppError {
  constructor(
    message: string = 'Authentication required',
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message, 'AUTHENTICATION_ERROR', 401, true, details, cause);
  }
}

/**
 * 授权错误
 */
export class AuthorizationError extends AppError {
  constructor(
    message: string = 'Permission denied',
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message, 'AUTHORIZATION_ERROR', 403, true, details, cause);
  }
}

/**
 * 资源未找到错误
 */
export class NotFoundError extends AppError {
  constructor(
    message: string = 'Resource not found',
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message, 'NOT_FOUND_ERROR', 404, true, details, cause);
  }
}

/**
 * 冲突错误
 */
export class ConflictError extends AppError {
  constructor(
    message: string = 'Resource conflict',
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message, 'CONFLICT_ERROR', 409, true, details, cause);
  }
}

/**
 * 请求错误
 */
export class BadRequestError extends AppError {
  constructor(
    message: string = 'Bad request',
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message, 'BAD_REQUEST_ERROR', 400, true, details, cause);
  }
}

/**
 * 服务不可用错误
 */
export class ServiceUnavailableError extends AppError {
  constructor(
    message: string = 'Service unavailable',
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message, 'SERVICE_UNAVAILABLE_ERROR', 503, true, details, cause);
  }
}

/**
 * 超时错误
 */
export class TimeoutError extends AppError {
  constructor(
    message: string = 'Operation timeout',
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message, 'TIMEOUT_ERROR', 408, true, details, cause);
  }
}

/**
 * 网络错误
 */
export class NetworkError extends AppError {
  constructor(
    message: string = 'Network error',
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message, 'NETWORK_ERROR', 502, true, details, cause);
  }
}

/**
 * 文件系统错误
 */
export class FileSystemError extends AppError {
  constructor(
    message: string,
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message, 'FILE_SYSTEM_ERROR', 500, true, details, cause);
  }
}

/**
 * AI服务错误
 */
export class AIError extends AppError {
  constructor(
    message: string,
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message, 'AI_SERVICE_ERROR', 500, true, details, cause);
  }
}

/**
 * Webhook错误
 */
export class WebhookError extends AppError {
  constructor(
    message: string,
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message, 'WEBHOOK_ERROR', 500, true, details, cause);
  }
}

/**
 * 音频处理错误
 */
export class AudioProcessingError extends AppError {
  constructor(
    message: string,
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message, 'AUDIO_PROCESSING_ERROR', 500, true, details, cause);
  }
}

/**
 * 字幕融合错误
 */
export class FusionError extends AppError {
  constructor(
    message: string,
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message, 'FUSION_ERROR', 500, true, details, cause);
  }
}