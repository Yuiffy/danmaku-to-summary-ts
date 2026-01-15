import { WebhookService } from './WebhookService';
import { FileStabilityChecker } from './FileStabilityChecker';
import { DuplicateProcessorGuard } from './DuplicateProcessorGuard';
import { ConfigProvider } from '../../core/config/ConfigProvider';

// Mock dependencies
jest.mock('../../core/logging/LogManager');
jest.mock('../../core/config/ConfigProvider');
jest.mock('./FileStabilityChecker');
jest.mock('./DuplicateProcessorGuard');
jest.mock('./handlers/DDTVWebhookHandler');
jest.mock('./handlers/MikufansWebhookHandler');

describe('WebhookService', () => {
  let webhookService: WebhookService;
  let mockConfig: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Setup mock config
    mockConfig = {
      app: {
        name: 'test-app',
        version: '1.0.0',
        environment: 'test',
        logLevel: 'info'
      },
      webhook: {
        enabled: true,
        port: 15121,
        host: '0.0.0.0',
        endpoints: {
          ddtv: {
            enabled: true,
            endpoint: '/ddtv'
          },
          mikufans: {
            enabled: true,
            endpoint: '/mikufans',
            basePath: '/test/path'
          }
        },
        timeouts: {
          fixVideoWait: 60000,
          fileStableCheck: 30000,
          processTimeout: 1800000
        }
      }
    };

    (ConfigProvider.getConfig as jest.Mock).mockReturnValue(mockConfig);
    (ConfigProvider.initialize as jest.Mock).mockResolvedValue(mockConfig);
    
    webhookService = new WebhookService();
  });

  describe('constructor', () => {
    it('should create WebhookService instance', () => {
      expect(webhookService).toBeInstanceOf(WebhookService);
    });

    it('should initialize with default port', () => {
      expect(webhookService.getPort()).toBe(15121);
    });

    it('should initialize with default host', () => {
      expect(webhookService.getServerUrl()).toBe('http://0.0.0.0:15121');
    });
  });

  describe('getPort', () => {
    it('should return the configured port', () => {
      expect(webhookService.getPort()).toBe(15121);
    });
  });

  describe('getServerUrl', () => {
    it('should return the server URL', () => {
      expect(webhookService.getServerUrl()).toBe('http://0.0.0.0:15121');
    });
  });

  describe('isFileProcessing', () => {
    it('should delegate to duplicate guard', () => {
      const mockIsDuplicate = jest.fn().mockReturnValue(false);
      (DuplicateProcessorGuard as jest.Mock).mockImplementation(() => ({
        isDuplicate: mockIsDuplicate
      }));

      const service = new WebhookService();
      const result = service.isFileProcessing('/test/path/file.mp4');
      
      expect(result).toBe(false);
    });
  });

  describe('getProcessingFiles', () => {
    it('should delegate to duplicate guard', () => {
      const mockGetProcessingFiles = jest.fn().mockReturnValue(['/test/path/file.mp4']);
      (DuplicateProcessorGuard as jest.Mock).mockImplementation(() => ({
        getProcessingFiles: mockGetProcessingFiles
      }));

      const service = new WebhookService();
      const result = service.getProcessingFiles();
      
      expect(result).toEqual(['/test/path/file.mp4']);
    });
  });

  describe('getProcessingHistory', () => {
    it('should return empty array initially', () => {
      const history = webhookService.getProcessingHistory();
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBe(0);
    });
  });

  describe('cleanupExpiredRecords', () => {
    it('should delegate to duplicate guard', () => {
      const mockCleanup = jest.fn();
      (DuplicateProcessorGuard as jest.Mock).mockImplementation(() => ({
        cleanup: mockCleanup
      }));

      const service = new WebhookService();
      service.cleanupExpiredRecords();
      
      expect(mockCleanup).toHaveBeenCalled();
    });
  });

  describe('processEvent', () => {
    it('should handle event with file paths', async () => {
      const mockWaitForFileStability = jest.fn().mockResolvedValue(true);
      const mockIsDuplicate = jest.fn().mockReturnValue(false);
      const mockMarkAsProcessing = jest.fn();
      const mockMarkAsProcessed = jest.fn();
      
      (FileStabilityChecker as jest.Mock).mockImplementation(() => ({
        waitForFileStability: mockWaitForFileStability
      }));
      
      (DuplicateProcessorGuard as jest.Mock).mockImplementation(() => ({
        isDuplicate: mockIsDuplicate,
        markAsProcessing: mockMarkAsProcessing,
        markAsProcessed: mockMarkAsProcessed
      }));

      const service = new WebhookService();
      
      const event = {
        type: 'ddtv' as const,
        payload: {},
        timestamp: new Date(),
        source: 'test',
        roomId: '123456',
        roomName: 'Test Room',
        filePaths: ['/test/path/file.mp4']
      };

      const results = await service.processEvent(event);
      
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(1);
      expect(mockIsDuplicate).toHaveBeenCalledWith('/test/path/file.mp4');
      expect(mockMarkAsProcessing).toHaveBeenCalledWith('/test/path/file.mp4');
      expect(mockMarkAsProcessed).toHaveBeenCalledWith('/test/path/file.mp4');
    });

    it('should skip duplicate files', async () => {
      const mockIsDuplicate = jest.fn().mockReturnValue(true);
      
      (DuplicateProcessorGuard as jest.Mock).mockImplementation(() => ({
        isDuplicate: mockIsDuplicate,
        markAsProcessing: jest.fn(),
        markAsProcessed: jest.fn()
      }));

      const service = new WebhookService();
      
      const event = {
        type: 'ddtv' as const,
        payload: {},
        timestamp: new Date(),
        source: 'test',
        filePaths: ['/test/path/file.mp4']
      };

      const results = await service.processEvent(event);
      
      expect(results[0].success).toBe(false);
      expect(results[0].error).toBe('File already being processed');
    });

    it('should handle file stability check failure', async () => {
      const mockWaitForFileStability = jest.fn().mockResolvedValue(false);
      const mockIsDuplicate = jest.fn().mockReturnValue(false);
      
      (FileStabilityChecker as jest.Mock).mockImplementation(() => ({
        waitForFileStability: mockWaitForFileStability
      }));
      
      (DuplicateProcessorGuard as jest.Mock).mockImplementation(() => ({
        isDuplicate: mockIsDuplicate,
        markAsProcessing: jest.fn(),
        markAsProcessed: jest.fn()
      }));

      const service = new WebhookService();
      
      const event = {
        type: 'ddtv' as const,
        payload: {},
        timestamp: new Date(),
        source: 'test',
        filePaths: ['/test/path/file.mp4']
      };

      const results = await service.processEvent(event);
      
      expect(results[0].success).toBe(false);
      expect(results[0].error).toBe('File stability check failed');
    });
  });

  describe('start and stop', () => {
    it('should start and stop without errors', async () => {
      // Mock express app
      const mockListen = jest.fn().mockImplementation((port, host, callback) => {
        callback();
        return {
          close: jest.fn().mockImplementation((callback) => callback())
        };
      });
      
      const mockExpress = jest.fn().mockReturnValue({
        use: jest.fn(),
        get: jest.fn(),
        post: jest.fn(),
        listen: mockListen
      });
      
      jest.doMock('express', () => mockExpress);
      
      // We need to re-import to get the mocked express
      const { WebhookService: WebhookServiceMocked } = require('./WebhookService');
      const service = new WebhookServiceMocked();
      
      await expect(service.start()).resolves.not.toThrow();
      await expect(service.stop()).resolves.not.toThrow();
    });
  });
});