import { ServiceManager, ServiceStatus } from './ServiceManager';
import { ConfigProvider } from '../core/config/ConfigProvider';
import { WebhookService } from './webhook/WebhookService';
import { IAudioProcessor } from './audio/IAudioProcessor';
import { IAITextGenerator } from './ai/IAITextGenerator';

// Mock dependencies
jest.mock('../core/logging/LogManager');
jest.mock('../core/config/ConfigProvider');
jest.mock('./webhook/WebhookService');
jest.mock('./audio/AudioProcessor');
jest.mock('./ai/AITextGenerator');

describe('ServiceManager', () => {
  let serviceManager: ServiceManager;
  let mockConfig: any;
  let mockWebhookService: any;
  let mockAudioProcessor: any;
  let mockAITextGenerator: any;

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
          ddtv: { enabled: true, endpoint: '/ddtv' },
          mikufans: { enabled: true, endpoint: '/mikufans' }
        },
        timeouts: {
          fixVideoWait: 60000,
          fileStableCheck: 30000,
          processTimeout: 1800000
        }
      },
      audio: {
        enabled: true,
        audioOnlyRooms: [123456],
        formats: ['.m4a', '.mp3'],
        defaultFormat: '.m4a',
        ffmpeg: { path: 'ffmpeg', timeout: 30000 },
        storage: { keepOriginalVideo: true, maxFileAgeDays: 30 }
      },
      ai: {
        text: {
          enabled: true,
          provider: 'gemini',
          gemini: { apiKey: 'test-key', model: 'gemini-pro' }
        },
        comic: {
          enabled: false,
          provider: 'python'
        },
        defaultNames: {
          anchor: '主播',
          fan: '粉丝'
        },
        roomSettings: {
          '123456': {
            audioOnly: true,
            anchorName: '测试主播',
            fanName: '测试粉丝'
          }
        }
      }
    };

    // Setup mock services
    mockWebhookService = {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined)
    };

    mockAudioProcessor = {
      processVideoForAudio: jest.fn().mockResolvedValue('/test/output/audio.m4a'),
      isAudioOnlyRoom: jest.fn().mockReturnValue(true),
      extractRoomIdFromFilename: jest.fn().mockReturnValue(123456),
      checkFfmpegAvailability: jest.fn().mockResolvedValue(true),
      convertVideoToAudio: jest.fn().mockResolvedValue('/test/output/audio.m4a')
    };

    mockAITextGenerator = {
      isConfigured: jest.fn().mockReturnValue(true),
      isAvailable: jest.fn().mockResolvedValue(true),
      generateGoodnightReply: jest.fn().mockResolvedValue('/test/output/goodnight.md'),
      generateText: jest.fn().mockResolvedValue('Generated text'),
      batchGenerateGoodnightReplies: jest.fn().mockResolvedValue([]),
      getStats: jest.fn().mockReturnValue({
        enabled: true,
        provider: 'gemini',
        model: 'gemini-pro',
        apiKeyConfigured: true,
        proxyConfigured: false
      })
    };

    // Mock constructors
    (WebhookService as jest.Mock).mockImplementation(() => mockWebhookService);
    (require('./audio/AudioProcessor').AudioProcessor as jest.Mock).mockImplementation(() => mockAudioProcessor);
    (require('./ai/AITextGenerator').AITextGenerator as jest.Mock).mockImplementation(() => mockAITextGenerator);

    // Mock config provider
    (ConfigProvider.getConfig as jest.Mock).mockReturnValue(mockConfig);
    (ConfigProvider.initialize as jest.Mock).mockResolvedValue(mockConfig);
    (ConfigProvider.isAudioOnlyRoom as jest.Mock).mockImplementation((roomId: string) => {
      return roomId === '123456';
    });
    (ConfigProvider.getRoomAIConfig as jest.Mock).mockImplementation((roomId: string) => {
      if (roomId === '123456') {
        return {
          audioOnly: true,
          anchorName: '测试主播',
          fanName: '测试粉丝',
          enableTextGeneration: true,
          enableComicGeneration: false
        };
      }
      return {
        audioOnly: false,
        anchorName: '主播',
        fanName: '粉丝',
        enableTextGeneration: true,
        enableComicGeneration: false
      };
    });

    serviceManager = new ServiceManager();
  });

  describe('initialize', () => {
    it('should initialize all services successfully', async () => {
      await serviceManager.initialize();
      
      expect(ConfigProvider.initialize).toHaveBeenCalled();
      
      const services = serviceManager.getAllServiceStatus();
      expect(services.has('webhook')).toBe(true);
      expect(services.has('audio')).toBe(true);
      expect(services.has('ai-text')).toBe(true);
      
      expect(services.get('webhook')?.status).toBe(ServiceStatus.STOPPED);
      expect(services.get('audio')?.status).toBe(ServiceStatus.STOPPED);
      expect(services.get('ai-text')?.status).toBe(ServiceStatus.STOPPED);
    });
  });

  describe('startAll and stopAll', () => {
    it('should start and stop all services', async () => {
      await serviceManager.initialize();
      await serviceManager.startAll();
      
      expect(mockWebhookService.start).toHaveBeenCalled();
      
      const services = serviceManager.getAllServiceStatus();
      expect(services.get('webhook')?.status).toBe(ServiceStatus.RUNNING);
      
      await serviceManager.stopAll();
      expect(mockWebhookService.stop).toHaveBeenCalled();
      expect(services.get('webhook')?.status).toBe(ServiceStatus.STOPPED);
    });
  });

  describe('getServiceStatus', () => {
    it('should return service status', async () => {
      await serviceManager.initialize();
      
      const webhookStatus = serviceManager.getServiceStatus('webhook');
      expect(webhookStatus).toBeDefined();
      expect(webhookStatus?.name).toBe('webhook');
      expect(webhookStatus?.status).toBe(ServiceStatus.STOPPED);
      
      const unknownStatus = serviceManager.getServiceStatus('unknown');
      expect(unknownStatus).toBeUndefined();
    });
  });

  describe('isServiceRunning', () => {
    it('should check if service is running', async () => {
      await serviceManager.initialize();
      
      expect(serviceManager.isServiceRunning('webhook')).toBe(false);
      
      await serviceManager.startAll();
      expect(serviceManager.isServiceRunning('webhook')).toBe(true);
    });
  });

  describe('getHealthStatus', () => {
    it('should return health status', async () => {
      await serviceManager.initialize();
      
      const healthStatus = serviceManager.getHealthStatus();
      expect(healthStatus).toHaveProperty('healthy');
      expect(healthStatus).toHaveProperty('services');
      expect(healthStatus).toHaveProperty('timestamp');
      
      // Initially not healthy because services are stopped
      expect(healthStatus.healthy).toBe(false);
    });
  });

  describe('processVideoFile', () => {
    beforeEach(async () => {
      await serviceManager.initialize();
      
      // Mock file system
      const fs = require('fs');
      jest.spyOn(fs, 'existsSync').mockImplementation((path: string) => {
        return path.includes('test') || path.includes('video.mp4');
      });
    });

    it('should process video file successfully', async () => {
      const result = await serviceManager.processVideoFile(
        '/test/video.mp4',
        '/test/danmaku.xml',
        '123456'
      );
      
      expect(result.success).toBe(true);
      expect(result.videoPath).toBe('/test/video.mp4');
      expect(result.roomId).toBe('123456');
      expect(result.steps.fileCheck.success).toBe(true);
      expect(result.steps.audioProcessing.success).toBe(true);
      expect(result.processingTime).toBeDefined();
    });

    it('should handle missing file', async () => {
      const fs = require('fs');
      jest.spyOn(fs, 'existsSync').mockImplementation(() => false);
      
      const result = await serviceManager.processVideoFile(
        '/nonexistent/video.mp4'
      );
      
      expect(result.success).toBe(false);
      expect(result.steps.overall?.error).toContain('视频文件不存在');
    });

    it('should handle non-audio-only room', async () => {
      (ConfigProvider.isAudioOnlyRoom as jest.Mock).mockReturnValue(false);
      
      const result = await serviceManager.processVideoFile(
        '/test/video.mp4',
        undefined,
        '999999'
      );
      
      expect(result.success).toBe(true);
      expect(result.steps.audioProcessing).toBeUndefined();
    });

    it('should handle AI service errors', async () => {
      mockAITextGenerator.isAvailable.mockResolvedValue(false);
      
      const result = await serviceManager.processVideoFile(
        '/test/video.mp4',
        '/test/danmaku.xml',
        '123456'
      );
      
      expect(result.success).toBe(true); // Other steps may succeed
      expect(result.steps.aiGeneration?.success).toBe(false);
    });
  });

  describe('getServiceStatistics', () => {
    it('should return service statistics', async () => {
      await serviceManager.initialize();
      
      const stats = serviceManager.getServiceStatistics();
      expect(stats.totalServices).toBe(3); // webhook, audio, ai-text
      expect(stats.stoppedServices).toBe(3);
      expect(stats.runningServices).toBe(0);
      expect(stats.errorServices).toBe(0);
    });
  });

  describe('getWebhookService', () => {
    it('should return webhook service instance', async () => {
      await serviceManager.initialize();
      
      const webhookService = serviceManager.getWebhookService();
      expect(webhookService).toBe(mockWebhookService);
    });
  });

  describe('getAudioProcessor', () => {
    it('should return audio processor instance', async () => {
      await serviceManager.initialize();
      
      const audioProcessor = serviceManager.getAudioProcessor();
      expect(audioProcessor).toBe(mockAudioProcessor);
    });
  });

  describe('getAITextGenerator', () => {
    it('should return AI text generator instance', async () => {
      await serviceManager.initialize();
      
      const aiTextGenerator = serviceManager.getAITextGenerator();
      expect(aiTextGenerator).toBe(mockAITextGenerator);
    });
  });

  describe('restartService', () => {
    it('should restart a service', async () => {
      await serviceManager.initialize();
      await serviceManager.startAll();
      
      const restartResult = await serviceManager.restartService('webhook');
      expect(restartResult).toBe(true);
      
      expect(mockWebhookService.stop).toHaveBeenCalled();
      expect(mockWebhookService.start).toHaveBeenCalledTimes(2); // Once in startAll, once in restart
    });

    it('should handle restart failure', async () => {
      await serviceManager.initialize();
      
      mockWebhookService.start.mockRejectedValue(new Error('Start failed'));
      
      const restartResult = await serviceManager.restartService('webhook');
      expect(restartResult).toBe(false);
    });
  });

  describe('batchProcessFiles', () => {
    it('should batch process files', async () => {
      await serviceManager.initialize();
      
      const files = [
        { videoPath: '/test/video1.mp4', xmlPath: '/test/danmaku1.xml', roomId: '123456' },
        { videoPath: '/test/video2.mp4', xmlPath: '/test/danmaku2.xml', roomId: '789012' }
      ];
      
      const results = await serviceManager.batchProcessFiles(files);
      
      expect(results).toHaveLength(2);
      expect(results[0].file).toBe('/test/video1.mp4');
      expect(results[1].file).toBe('/test/video2.mp4');
    });
  });
});