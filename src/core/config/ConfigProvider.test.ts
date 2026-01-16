import { ConfigProvider } from './ConfigProvider';
import { ConfigLoader } from './ConfigLoader';

// Mock dependencies
jest.mock('./ConfigLoader');

describe('ConfigProvider', () => {
  let mockConfig: any;
  let mockLoader: any;

  beforeEach(() => {
    // Reset module state
    jest.resetModules();
    
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
          mikufans: { enabled: true, endpoint: '/mikufans', basePath: '/test/path' }
        },
        timeouts: {
          fixVideoWait: 60000,
          fileStableCheck: 30000,
          processTimeout: 1800000
        }
      },
      audio: {
        enabled: true,
        audioOnlyRooms: [123456, 789012],
        formats: ['.m4a', '.mp3'],
        defaultFormat: '.m4a',
        ffmpeg: { path: 'ffmpeg', timeout: 30000 },
        storage: { keepOriginalVideo: true, maxFileAgeDays: 30 }
      },
      ai: {
        text: {
          enabled: true,
          provider: 'gemini',
          gemini: { apiKey: 'test-key', model: 'gemini-pro', temperature: 0.7, maxTokens: 1000 }
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
            referenceImage: '/path/to/image.png',
            anchorName: '测试主播',
            fanName: '测试粉丝'
          }
        }
      },
      fusion: {
        timeWindowSec: 60,
        densityPercentile: 90,
        lowEnergySampleRate: 5,
        myUserId: '12345',
        stopWords: ['的', '了', '在'],
        fillerRegex: '^[\\s\\W]*$'
      },
      storage: {
        basePath: '/test/base',
        tempPath: '/test/temp',
        outputPath: '/test/output',
        cleanup: { enabled: true, intervalHours: 24, maxAgeDays: 7 }
      },
      monitoring: {
        enabled: true,
        metrics: { enabled: true, port: 9090 },
        health: { enabled: true, endpoint: '/health' }
      }
    };

    // Setup mock loader
    mockLoader = {
      getInstance: jest.fn().mockReturnThis(),
      load: jest.fn().mockResolvedValue(mockConfig),
      reload: jest.fn().mockResolvedValue(mockConfig)
    };

    (ConfigLoader.getInstance as jest.Mock).mockReturnValue(mockLoader);
  });

  afterEach(() => {
    // Clear any cached config
    jest.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize config successfully', async () => {
      const config = await ConfigProvider.initialize();
      
      expect(config).toEqual(mockConfig);
      expect(ConfigLoader.getInstance).toHaveBeenCalled();
      expect(mockLoader.load).toHaveBeenCalled();
    });

    it('should return cached config on subsequent calls', async () => {
      await ConfigProvider.initialize();
      await ConfigProvider.initialize();
      
      // Loader should only be called once
      expect(mockLoader.load).toHaveBeenCalledTimes(1);
    });
  });

  describe('getConfig', () => {
    it('should throw error if not initialized', () => {
      expect(() => ConfigProvider.getConfig()).toThrow('Configuration not initialized');
    });

    it('should return config after initialization', async () => {
      await ConfigProvider.initialize();
      const config = ConfigProvider.getConfig();
      
      expect(config).toEqual(mockConfig);
    });
  });

  describe('reload', () => {
    it('should reload config successfully', async () => {
      await ConfigProvider.initialize();
      const newConfig = { ...mockConfig, app: { ...mockConfig.app, name: 'reloaded-app' } };
      mockLoader.reload.mockResolvedValue(newConfig);
      
      const reloaded = await ConfigProvider.reload();
      
      expect(reloaded).toEqual(newConfig);
      expect(mockLoader.reload).toHaveBeenCalled();
    });
  });

  describe('getAppConfig', () => {
    it('should return app config', async () => {
      await ConfigProvider.initialize();
      const appConfig = ConfigProvider.getAppConfig();
      
      expect(appConfig).toEqual(mockConfig.app);
    });
  });

  describe('getWebhookConfig', () => {
    it('should return webhook config', async () => {
      await ConfigProvider.initialize();
      const webhookConfig = ConfigProvider.getWebhookConfig();
      
      expect(webhookConfig).toEqual(mockConfig.webhook);
    });
  });

  describe('getAudioConfig', () => {
    it('should return audio config', async () => {
      await ConfigProvider.initialize();
      const audioConfig = ConfigProvider.getAudioConfig();
      
      expect(audioConfig).toEqual(mockConfig.audio);
    });
  });

  describe('getAIConfig', () => {
    it('should return AI config', async () => {
      await ConfigProvider.initialize();
      const aiConfig = ConfigProvider.getAIConfig();
      
      expect(aiConfig).toEqual(mockConfig.ai);
    });
  });

  describe('getFusionConfig', () => {
    it('should return fusion config', async () => {
      await ConfigProvider.initialize();
      const fusionConfig = ConfigProvider.getFusionConfig();
      
      expect(fusionConfig).toEqual(mockConfig.fusion);
    });
  });

  describe('getStorageConfig', () => {
    it('should return storage config', async () => {
      await ConfigProvider.initialize();
      const storageConfig = ConfigProvider.getStorageConfig();
      
      expect(storageConfig).toEqual(mockConfig.storage);
    });
  });

  describe('getMonitoringConfig', () => {
    it('should return monitoring config', async () => {
      await ConfigProvider.initialize();
      const monitoringConfig = ConfigProvider.getMonitoringConfig();
      
      expect(monitoringConfig).toEqual(mockConfig.monitoring);
    });
  });

  describe('getRoomAIConfig', () => {
    it('should return room-specific AI config', async () => {
      await ConfigProvider.initialize();
      const roomConfig = ConfigProvider.getRoomAIConfig('123456');
      
      expect(roomConfig).toEqual({
        audioOnly: true,
        referenceImage: '/path/to/image.png',
        characterDescription: undefined,
        anchorName: '测试主播',
        fanName: '测试粉丝',
        enableTextGeneration: undefined,
        enableComicGeneration: undefined
      });
    });

    it('should return default config for unknown room', async () => {
      await ConfigProvider.initialize();
      const roomConfig = ConfigProvider.getRoomAIConfig('unknown');
      
      expect(roomConfig).toEqual({
        audioOnly: false,
        referenceImage: undefined,
        characterDescription: undefined,
        anchorName: '主播',
        fanName: '粉丝',
        enableTextGeneration: true,
        enableComicGeneration: false
      });
    });
  });

  describe('isAudioOnlyRoom', () => {
    it('should return true for audio-only room', async () => {
      await ConfigProvider.initialize();
      const result = ConfigProvider.isAudioOnlyRoom('123456');
      
      expect(result).toBe(true);
    });

    it('should return false for non-audio-only room', async () => {
      await ConfigProvider.initialize();
      const result = ConfigProvider.isAudioOnlyRoom('999999');
      
      expect(result).toBe(false);
    });
  });

  describe('getEnvironment', () => {
    it('should return environment', async () => {
      await ConfigProvider.initialize();
      const env = ConfigProvider.getEnvironment();
      
      expect(env).toBe('test');
    });
  });

  describe('isDevelopment', () => {
    it('should return false for test environment', async () => {
      await ConfigProvider.initialize();
      const result = ConfigProvider.isDevelopment();
      
      expect(result).toBe(false);
    });
  });

  describe('isProduction', () => {
    it('should return false for test environment', async () => {
      await ConfigProvider.initialize();
      const result = ConfigProvider.isProduction();
      
      expect(result).toBe(false);
    });
  });

  describe('getLogLevel', () => {
    it('should return log level', async () => {
      await ConfigProvider.initialize();
      const logLevel = ConfigProvider.getLogLevel();
      
      expect(logLevel).toBe('info');
    });
  });

  describe('getWebhookPort', () => {
    it('should return webhook port', async () => {
      await ConfigProvider.initialize();
      const port = ConfigProvider.getWebhookPort();
      
      expect(port).toBe(15121);
    });
  });

  describe('getWebhookHost', () => {
    it('should return webhook host', async () => {
      await ConfigProvider.initialize();
      const host = ConfigProvider.getWebhookHost();
      
      expect(host).toBe('0.0.0.0');
    });
  });

  describe('getStorageBasePath', () => {
    it('should return storage base path', async () => {
      await ConfigProvider.initialize();
      const basePath = ConfigProvider.getStorageBasePath();
      
      expect(basePath).toBe('/test/base');
    });
  });

  describe('getTempPath', () => {
    it('should return temp path', async () => {
      await ConfigProvider.initialize();
      const tempPath = ConfigProvider.getTempPath();
      
      expect(tempPath).toBe('/test/temp');
    });
  });

  describe('getOutputPath', () => {
    it('should return output path', async () => {
      await ConfigProvider.initialize();
      const outputPath = ConfigProvider.getOutputPath();
      
      expect(outputPath).toBe('/test/output');
    });
  });

  describe('getGeminiApiKey', () => {
    it('should return Gemini API key', async () => {
      await ConfigProvider.initialize();
      const apiKey = ConfigProvider.getGeminiApiKey();
      
      expect(apiKey).toBe('test-key');
    });
  });

  describe('getOpenAIApiKey', () => {
    it('should return undefined when not configured', async () => {
      await ConfigProvider.initialize();
      const apiKey = ConfigProvider.getOpenAIApiKey();
      
      expect(apiKey).toBeUndefined();
    });
  });

  describe('getTextAIProvider', () => {
    it('should return text AI provider', async () => {
      await ConfigProvider.initialize();
      const provider = ConfigProvider.getTextAIProvider();
      
      expect(provider).toBe('gemini');
    });
  });

  describe('getComicAIProvider', () => {
    it('should return comic AI provider', async () => {
      await ConfigProvider.initialize();
      const provider = ConfigProvider.getComicAIProvider();
      
      expect(provider).toBe('python');
    });
  });
});