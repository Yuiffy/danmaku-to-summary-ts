// 临时解决express类型问题
type Request = any;
type Response = any;
type NextFunction = any;

import { AppError } from './AppError';
import { ErrorHandler } from './ErrorHandler';
import { getLogger } from '../logging/LogManager';

/**
 * Express错误处理中间件
 */
export class ErrorMiddleware {
  /**
   * 错误处理中间件
   */
  static errorHandler() {
    return (error: Error, req: Request, res: Response, _next: NextFunction) => {
      const logger = getLogger('ErrorMiddleware');
      
      // 规范化错误
      const appError = ErrorHandler.normalizeError(error);
      
      // 记录错误
      const logContext = {
        method: req.method,
        url: req.url,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        errorCode: appError.code,
        statusCode: appError.statusCode,
        isOperational: appError.isOperational
      };
      
      if (appError.statusCode >= 500) {
        logger.error(`Server Error: ${appError.message}`, logContext, appError.cause);
      } else {
        logger.warn(`Client Error: ${appError.message}`, logContext);
      }
      
      // 发送错误响应
      const includeStack = process.env.NODE_ENV !== 'production';
      const errorResponse = ErrorHandler.createErrorResponse(appError, { includeStack });
      
      res.status(appError.statusCode).json(errorResponse);
    };
  }

  /**
   * 404处理中间件
   */
  static notFoundHandler() {
    return (req: Request, res: Response, next: NextFunction) => {
      const error = new AppError(
        `Route ${req.method} ${req.url} not found`,
        'NOT_FOUND_ERROR',
        404,
        true
      );
      
      next(error);
    };
  }

  /**
   * 异步错误包装器
   */
  static wrapAsync(fn: Function) {
    return (req: Request, _res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, _res, next)).catch(next);
    };
  }

  /**
   * 请求验证中间件
   */
  static validateRequest(schema: any) {
    return (req: Request, _res: Response, next: NextFunction) => {
      try {
        // 这里可以集成Joi或其他验证库
        // 暂时使用简单验证
        const { error } = schema.validate(req.body, { abortEarly: false });
        
        if (error) {
          const validationError = ErrorHandler.createValidationError(
            'Validation failed',
            { details: error.details }
          );
          return next(validationError);
        }
        
        next();
      } catch (error) {
        next(error);
      }
    };
  }

  /**
   * 全局错误处理器
   */
  static setupGlobalErrorHandlers(app: any) {
    // 404处理
    app.use(this.notFoundHandler());
    
    // 全局错误处理
    app.use(this.errorHandler());
    
    // 未捕获的Promise拒绝处理
    process.on('unhandledRejection', (reason, promise) => {
      const logger = getLogger('UnhandledRejection');
      logger.error('Unhandled Promise Rejection', { reason, promise });
      
      // 在开发环境中，可能希望退出进程
      if (process.env.NODE_ENV === 'production') {
        // 在生产环境中，记录错误但继续运行
        console.error('Unhandled Promise Rejection:', reason);
      }
    });
    
    // 未捕获的异常处理
    process.on('uncaughtException', (error) => {
      const logger = getLogger('UncaughtException');
      logger.error('Uncaught Exception', {}, error);
      
      // 对于未捕获的异常，通常应该退出进程
      console.error('Uncaught Exception:', error);
      process.exit(1);
    });
  }

  /**
   * 创建健康检查中间件
   */
  static healthCheck() {
    return (_req: Request, res: Response) => {
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        environment: process.env.NODE_ENV
      };
      
      res.status(200).json(health);
    };
  }

  /**
   * 创建请求日志中间件
   */
  static requestLogger() {
    return (req: Request, res: Response, next: NextFunction) => {
      const logger = getLogger('RequestLogger');
      const startTime = Date.now();
      
      // 记录请求开始
      logger.debug(`Request started: ${req.method} ${req.url}`, {
        method: req.method,
        url: req.url,
        ip: req.ip,
        userAgent: req.get('user-agent')
      });
      
      // 响应完成时记录
      res.on('finish', () => {
        const duration = Date.now() - startTime;
        const logLevel = res.statusCode >= 400 ? 'warn' : 'info';
        
        logger[logLevel](`Request completed: ${req.method} ${req.url}`, {
          method: req.method,
          url: req.url,
          statusCode: res.statusCode,
          duration: `${duration}ms`,
          contentLength: res.get('content-length') || '0'
        });
      });
      
      next();
    };
  }
}