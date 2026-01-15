import { AppError } from './AppError';
import { getLogger } from '../logging/LogManager';

/**
 * 错误处理选项
 */
export interface ErrorHandlerOptions {
  logError?: boolean;
  rethrow?: boolean;
  defaultStatusCode?: number;
  includeStack?: boolean;
}

/**
 * 错误处理器
 */
export class ErrorHandler {
  private static defaultOptions: ErrorHandlerOptions = {
    logError: true,
    rethrow: false,
    defaultStatusCode: 500,
    includeStack: process.env.NODE_ENV !== 'production'
  };

  /**
   * 处理错误
   */
  static handle(error: Error | AppError | any, options: ErrorHandlerOptions = {}): AppError {
    const mergedOptions = { ...this.defaultOptions, ...options };
    const logger = getLogger('ErrorHandler');

    // 转换为AppError
    const appError = this.normalizeError(error);

    // 记录错误
    if (mergedOptions.logError) {
      this.logError(appError, logger);
    }

    // 重新抛出
    if (mergedOptions.rethrow) {
      throw appError;
    }

    return appError;
  }

  /**
   * 规范化错误为AppError
   */
  static normalizeError(error: Error | AppError | any): AppError {
    // 如果已经是AppError，直接返回
    if (error instanceof AppError) {
      return error;
    }

    // 处理原生Error
    if (error instanceof Error) {
      return new AppError(
        error.message,
        'INTERNAL_ERROR',
        500,
        false,
        { originalError: error.name },
        error
      );
    }

    // 处理字符串错误
    if (typeof error === 'string') {
      return new AppError(error, 'INTERNAL_ERROR', 500, false);
    }

    // 处理对象错误
    if (error && typeof error === 'object') {
      const message = error.message || error.error || 'Unknown error';
      const code = error.code || 'INTERNAL_ERROR';
      const statusCode = error.statusCode || error.status || 500;
      
      return new AppError(
        String(message),
        String(code),
        Number(statusCode),
        false,
        error
      );
    }

    // 未知错误类型
    return new AppError('Unknown error occurred', 'UNKNOWN_ERROR', 500, false);
  }

  /**
   * 记录错误
   */
  private static logError(error: AppError, logger: any): void {
    const logContext = {
      code: error.code,
      statusCode: error.statusCode,
      isOperational: error.isOperational,
      details: error.details,
      stack: error.stack
    };

    if (error.statusCode >= 500) {
      // 服务器错误
      logger.error(`Server Error: ${error.message}`, logContext, error.cause);
    } else if (error.statusCode >= 400) {
      // 客户端错误
      logger.warn(`Client Error: ${error.message}`, logContext);
    } else {
      // 其他错误
      logger.error(`Error: ${error.message}`, logContext, error.cause);
    }
  }

  /**
   * 创建错误响应
   */
  static createErrorResponse(error: AppError, options: ErrorHandlerOptions = {}): {
    error: {
      message: string;
      code: string;
      statusCode: number;
      details?: Record<string, any>;
      stack?: string;
    };
  } {
    const mergedOptions = { ...this.defaultOptions, ...options };
    
    const response: any = {
      error: {
        message: error.message,
        code: error.code,
        statusCode: error.statusCode
      }
    };

    // 添加详情
    if (error.details && Object.keys(error.details).length > 0) {
      response.error.details = error.details;
    }

    // 添加堆栈跟踪（仅在开发环境）
    if (mergedOptions.includeStack && error.stack) {
      response.error.stack = error.stack;
    }

    return response;
  }

  /**
   * 包装异步函数，自动处理错误
   */
  static wrapAsync<T>(
    fn: (...args: any[]) => Promise<T>,
    options: ErrorHandlerOptions = {}
  ): (...args: any[]) => Promise<T> {
    return async (...args: any[]): Promise<T> => {
      try {
        return await fn(...args);
      } catch (error) {
        const appError = this.handle(error, options);
        throw appError;
      }
    };
  }

  /**
   * 包装同步函数，自动处理错误
   */
  static wrapSync<T>(
    fn: (...args: any[]) => T,
    options: ErrorHandlerOptions = {}
  ): (...args: any[]) => T {
    return (...args: any[]): T => {
      try {
        return fn(...args);
      } catch (error) {
        const appError = this.handle(error, options);
        throw appError;
      }
    };
  }

  /**
   * 检查是否为操作错误
   */
  static isOperationalError(error: Error): boolean {
    if (error instanceof AppError) {
      return error.isOperational;
    }
    return false;
  }

  /**
   * 检查是否为客户端错误
   */
  static isClientError(error: Error): boolean {
    const statusCode = this.getStatusCode(error);
    return statusCode >= 400 && statusCode < 500;
  }

  /**
   * 检查是否为服务器错误
   */
  static isServerError(error: Error): boolean {
    const statusCode = this.getStatusCode(error);
    return statusCode >= 500;
  }

  /**
   * 获取错误状态码
   */
  static getStatusCode(error: Error): number {
    if (error instanceof AppError) {
      return error.statusCode;
    }
    return 500;
  }

  /**
   * 获取错误代码
   */
  static getErrorCode(error: Error): string {
    if (error instanceof AppError) {
      return error.code;
    }
    return 'INTERNAL_ERROR';
  }

  /**
   * 创建验证错误
   */
  static createValidationError(message: string, details?: Record<string, any>): AppError {
    return new AppError(message, 'VALIDATION_ERROR', 400, true, details);
  }

  /**
   * 创建未找到错误
   */
  static createNotFoundError(message: string = 'Resource not found', details?: Record<string, any>): AppError {
    return new AppError(message, 'NOT_FOUND_ERROR', 404, true, details);
  }

  /**
   * 创建认证错误
   */
  static createAuthenticationError(message: string = 'Authentication required', details?: Record<string, any>): AppError {
    return new AppError(message, 'AUTHENTICATION_ERROR', 401, true, details);
  }

  /**
   * 创建授权错误
   */
  static createAuthorizationError(message: string = 'Permission denied', details?: Record<string, any>): AppError {
    return new AppError(message, 'AUTHORIZATION_ERROR', 403, true, details);
  }
}