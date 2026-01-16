import { AudioProcessor } from './AudioProcessor';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { getLogger } from '../../core/logging/LogManager';

// 模拟配置
jest.mock('../../core/config/ConfigProvider');
jest.mock('../../core/logging/LogManager');

describe('AudioProcessor', () => {
  let audioProcessor: AudioProcessor;
  let mockConfig: any;

  beforeEach(() => {
    // 重置所有模拟
    jest.clearAllMocks();

    // 模拟配置
    mockConfig = {
      app: {
        name: 'danmaku-to-summary',
        version: '0.2.0',
        environment: 'development',
        logLevel: 'info'
      },
      audio: {
        enabled: true,
        audioOnlyRooms: [12345, 67890],
        formats: ['.m4a', '.mp3'],
        defaultFormat: '.m4a',
        ffmpeg: {
          path: 'ffmpeg',
          timeout: 300000
        },
        storage: {
          keepOriginalVideo: false,
          maxFileAgeDays: 30
        }
      },
      timeouts: {
        ffmpegTimeout: 300000
      }
    };

    // 模拟ConfigProvider
    (ConfigProvider.getConfig as jest.Mock).mockReturnValue(mockConfig);
    
    // 模拟logger
    const mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
    (getLogger as jest.Mock).mockReturnValue(mockLogger);

    audioProcessor = new AudioProcessor();
  });

  describe('构造函数', () => {
    it('应该正确加载配置', () => {
      expect(ConfigProvider.getConfig).toHaveBeenCalled();
    });
  });

  describe('isAudioOnlyRoom', () => {
    it('应该识别音频专用房间', () => {
      expect(audioProcessor.isAudioOnlyRoom(12345)).toBe(true);
      expect(audioProcessor.isAudioOnlyRoom(67890)).toBe(true);
    });

    it('应该识别非音频专用房间', () => {
      expect(audioProcessor.isAudioOnlyRoom(99999)).toBe(false);
    });

    it('当音频处理禁用时应该返回false', () => {
      mockConfig.audio.enabled = false;
      (ConfigProvider.getConfig as jest.Mock).mockReturnValue(mockConfig);
      const newProcessor = new AudioProcessor();
      
      expect(newProcessor.isAudioOnlyRoom(12345)).toBe(false);
    });
  });

  describe('extractRoomIdFromFilename', () => {
    it('应该从DDTV文件名中提取房间ID', () => {
      expect(audioProcessor.extractRoomIdFromFilename('12345_20240101_120000.mp4')).toBe(12345);
      expect(audioProcessor.extractRoomIdFromFilename('67890_20240101_120000.mkv')).toBe(67890);
    });

    it('当文件名格式不正确时应该返回null', () => {
      expect(audioProcessor.extractRoomIdFromFilename('test_video.mp4')).toBe(null);
      expect(audioProcessor.extractRoomIdFromFilename('')).toBe(null);
    });
  });

  describe('checkFfmpegAvailability', () => {
    it('应该检查FFmpeg可用性', async () => {
      // 注意：这是一个集成测试，实际会调用系统命令
      // 在测试环境中，我们跳过实际执行
      const result = await audioProcessor.checkFfmpegAvailability();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('getStats', () => {
    it('应该返回音频处理统计信息', () => {
      const stats = audioProcessor.getStats();
      
      expect(stats).toEqual({
        enabled: true,
        audioOnlyRoomsCount: 2,
        ffmpegPath: 'ffmpeg',
        defaultFormat: '.m4a'
      });
    });
  });

  describe('配置处理', () => {
    it('应该处理缺失的配置', () => {
      // 模拟缺失部分配置
      const incompleteConfig = {
        app: {
          name: 'test',
          version: '1.0.0',
          environment: 'development',
          logLevel: 'info'
        },
        audio: {
          // 只提供部分配置
          enabled: true
        }
      };
      
      (ConfigProvider.getConfig as jest.Mock).mockReturnValue(incompleteConfig);
      const processor = new AudioProcessor();
      
      // 应该使用默认值
      expect(processor.getStats().ffmpegPath).toBe('ffmpeg');
      expect(processor.getStats().defaultFormat).toBe('.m4a');
    });

    it('当配置加载失败时应该使用默认配置', () => {
      (ConfigProvider.getConfig as jest.Mock).mockImplementation(() => {
        throw new Error('配置加载失败');
      });
      
      const processor = new AudioProcessor();
      
      // 应该使用默认配置
      expect(processor.getStats().enabled).toBe(true);
      expect(processor.getStats().audioOnlyRoomsCount).toBe(0);
    });
  });

  describe('错误处理', () => {
    it('应该正确处理无效的视频路径', async () => {
      const result = await audioProcessor.processVideoForAudio('/nonexistent/path/video.mp4');
      expect(result).toBeNull();
    });

    it('当音频处理禁用时应该返回null', async () => {
      mockConfig.audio.enabled = false;
      (ConfigProvider.getConfig as jest.Mock).mockReturnValue(mockConfig);
      const processor = new AudioProcessor();
      
      const result = await processor.processVideoForAudio('/path/to/video.mp4');
      expect(result).toBeNull();
    });
  });
});

// 集成测试（可选）
describe('AudioProcessor 集成测试', () => {
  let audioProcessor: AudioProcessor;

  beforeAll(() => {
    // 确保配置已初始化
    ConfigProvider.initialize();
    audioProcessor = new AudioProcessor();
  });

  it('应该正确加载真实配置', () => {
    const stats = audioProcessor.getStats();
    expect(stats).toBeDefined();
    expect(typeof stats.enabled).toBe('boolean');
    expect(Array.isArray(stats.audioOnlyRoomsCount)).toBe(false); // 应该是数字
  });

  it('应该能够检查FFmpeg可用性', async () => {
    const isAvailable = await audioProcessor.checkFfmpegAvailability();
    expect(typeof isAvailable).toBe('boolean');
  }, 15000); // 增加超时时间
});