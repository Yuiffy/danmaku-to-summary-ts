import { ConfigProvider } from '../config/ConfigProvider';
import { initializeLogging, getLogger, logInfo, logError, logWarn } from '../logging/LogManager';
import { ErrorHandler } from '../errors/ErrorHandler';
import {
  AppError as AppErrorClass,
  ValidationError,
  NotFoundError
} from '../errors/AppError';

/**
 * 基础设施测试
 */
export class InfrastructureTest {
  private logger: any;

  constructor() {
    // 延迟初始化logger
    this.logger = null;
  }

  private getLogger() {
    if (!this.logger) {
      this.logger = getLogger('InfrastructureTest');
    }
    return this.logger;
  }

  /**
   * 运行所有测试
   */
  async runAllTests(): Promise<boolean> {
    console.log('🚀 开始基础设施测试...\n');

    const tests = [
      this.testConfigSystem.bind(this),
      this.testLoggingSystem.bind(this),
      this.testErrorHandlingSystem.bind(this),
      this.testIntegration.bind(this)
    ];

    let allPassed = true;
    
    for (let i = 0; i < tests.length; i++) {
      const testName = tests[i].name.replace('bound ', '').replace('test', '');
      console.log(`📋 测试 ${i + 1}: ${testName}`);
      
      try {
        const passed = await tests[i]();
        if (passed) {
          console.log(`✅ ${testName} 通过\n`);
        } else {
          console.log(`❌ ${testName} 失败\n`);
          allPassed = false;
        }
      } catch (error) {
        console.log(`💥 ${testName} 异常:`, error instanceof Error ? error.message : error);
        console.log(`❌ ${testName} 失败\n`);
        allPassed = false;
      }
    }

    console.log(allPassed ? '🎉 所有基础设施测试通过！' : '⚠️  部分测试失败');
    return allPassed;
  }

  /**
   * 测试配置系统
   */
  private async testConfigSystem(): Promise<boolean> {
    try {
      // 初始化配置
      await ConfigProvider.initialize();
      
      // 获取配置
      const config = ConfigProvider.getConfig();
      
      // 验证基本配置
      if (!config.app.name) {
        throw new Error('应用名称未配置');
      }
      
      if (!config.app.version) {
        throw new Error('应用版本未配置');
      }
      
      if (!config.webhook.port) {
        throw new Error('Webhook端口未配置');
      }
      
      // 测试环境变量
      const env = ConfigProvider.getEnvironment();
      console.log(`   环境: ${env}`);
      
      // 测试配置方法
      const port = ConfigProvider.getWebhookPort();
      console.log(`   Webhook端口: ${port}`);
      
      const logLevel = ConfigProvider.getLogLevel();
      console.log(`   日志级别: ${logLevel}`);
      
      return true;
    } catch (error) {
      console.error('配置系统测试失败:', error);
      return false;
    }
  }

  /**
   * 测试日志系统
   */
  private async testLoggingSystem(): Promise<boolean> {
    try {
      // 初始化日志
      await initializeLogging();
      
      // 测试不同级别的日志
      logInfo('测试信息级别日志', { test: 'info' });
      logWarn('测试警告级别日志', { test: 'warn' });
      logError('测试错误级别日志', new Error('测试错误'), { test: 'error' });
      
      // 测试带源的日志器
      const sourceLogger = getLogger('TestSource');
      sourceLogger.info('测试带源的日志');
      
      // 测试子日志器
      const childLogger = sourceLogger.child({ userId: '123', requestId: 'abc' });
      childLogger.debug('测试子日志器');
      
      console.log('   日志系统测试完成 - 请检查控制台输出');
      return true;
    } catch (error) {
      console.error('日志系统测试失败:', error);
      return false;
    }
  }

  /**
   * 测试错误处理系统
   */
  private async testErrorHandlingSystem(): Promise<boolean> {
    try {
      // 测试AppError
      const appError = new AppErrorClass('测试应用错误', 'TEST_ERROR', 400, true, { test: true });
      if (appError.code !== 'TEST_ERROR') {
        throw new Error('AppError代码不正确');
      }
      
      // 测试错误规范化
      const stringError = '字符串错误';
      const normalizedError = ErrorHandler.normalizeError(stringError);
      if (!(normalizedError instanceof AppErrorClass)) {
        throw new Error('字符串错误规范化失败');
      }
      
      const nativeError = new Error('原生错误');
      const normalizedNativeError = ErrorHandler.normalizeError(nativeError);
      if (!(normalizedNativeError instanceof AppErrorClass)) {
        throw new Error('原生错误规范化失败');
      }
      
      // 测试特定错误类型
      const validationError = new ValidationError('验证失败', { field: 'email' });
      if (validationError.statusCode !== 400) {
        throw new Error('验证错误状态码不正确');
      }
      
      const notFoundError = new NotFoundError('资源未找到');
      if (notFoundError.statusCode !== 404) {
        throw new Error('未找到错误状态码不正确');
      }
      
      // 测试错误处理器
      const testError = new Error('测试错误');
      const handledError = ErrorHandler.handle(testError, { logError: false, rethrow: false });
      if (!(handledError instanceof AppErrorClass)) {
        throw new Error('错误处理失败');
      }
      
      // 测试错误响应创建
      const errorResponse = ErrorHandler.createErrorResponse(handledError);
      if (!errorResponse.error || !errorResponse.error.message) {
        throw new Error('错误响应创建失败');
      }
      
      console.log('   错误处理系统测试完成');
      return true;
    } catch (error) {
      console.error('错误处理系统测试失败:', error);
      return false;
    }
  }

  /**
   * 测试集成
   */
  private async testIntegration(): Promise<boolean> {
    try {
      // 测试配置和日志集成
      await ConfigProvider.initialize();
      await initializeLogging();
      
      const logger = getLogger('IntegrationTest');
      
      // 使用配置
      const config = ConfigProvider.getConfig();
      logger.info('配置加载成功', { 
        appName: config.app.name,
        version: config.app.version,
        environment: config.app.environment
      });
      
      // 测试错误处理和日志集成
      try {
        throw new ValidationError('集成测试验证错误', { test: 'integration' });
      } catch (error) {
        const handledError = ErrorHandler.handle(error, { logError: false });
        logger.warn('捕获并处理错误', { 
          errorCode: handledError.code,
          statusCode: handledError.statusCode
        });
      }
      
      // 测试包装函数
      const riskyFunction = async () => {
        throw new Error('危险操作失败');
      };
      
      const safeFunction = ErrorHandler.wrapAsync(riskyFunction, { logError: false });
      
      try {
        await safeFunction();
        throw new Error('应该抛出错误');
      } catch (error) {
        if (!(error instanceof AppErrorClass)) {
          throw new Error('包装函数应该返回AppError');
        }
      }
      
      console.log('   集成测试完成');
      return true;
    } catch (error) {
      console.error('集成测试失败:', error);
      return false;
    }
  }

  /**
   * 运行性能测试
   */
  async runPerformanceTests(): Promise<void> {
    console.log('\n⚡ 开始性能测试...');
    
    const startTime = Date.now();
    const iterations = 100;
    
    // 测试配置加载性能
    const configStart = Date.now();
    for (let i = 0; i < iterations; i++) {
      await ConfigProvider.initialize();
    }
    const configTime = Date.now() - configStart;
    
    // 测试日志性能
    const logStart = Date.now();
    const logger = getLogger('PerformanceTest');
    for (let i = 0; i < iterations; i++) {
      logger.info(`性能测试日志 ${i}`, { iteration: i });
    }
    const logTime = Date.now() - logStart;
    
    // 测试错误处理性能
    const errorStart = Date.now();
    for (let i = 0; i < iterations; i++) {
      const error = new Error(`性能测试错误 ${i}`);
      ErrorHandler.handle(error, { logError: false });
    }
    const errorTime = Date.now() - errorStart;
    
    const totalTime = Date.now() - startTime;
    
    console.log(`   配置加载: ${configTime}ms (${iterations}次)`);
    console.log(`   日志记录: ${logTime}ms (${iterations}次)`);
    console.log(`   错误处理: ${errorTime}ms (${iterations}次)`);
    console.log(`   总时间: ${totalTime}ms`);
    console.log(`   平均每次操作: ${(totalTime / (iterations * 3)).toFixed(2)}ms`);
  }
}

/**
 * 运行测试
 */
async function main() {
  const test = new InfrastructureTest();
  
  try {
    const passed = await test.runAllTests();
    
    if (passed) {
      // 运行性能测试
      await test.runPerformanceTests();
      
      console.log('\n🎊 基础设施验证完成！');
      process.exit(0);
    } else {
      console.log('\n⚠️  基础设施验证失败');
      process.exit(1);
    }
  } catch (error) {
    console.error('测试运行失败:', error);
    process.exit(1);
  }
}

// 如果直接运行此文件
if (require.main === module) {
  main();
}

export default InfrastructureTest;