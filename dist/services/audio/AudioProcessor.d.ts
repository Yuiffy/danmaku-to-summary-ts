import { IAudioProcessor } from './IAudioProcessor';
/**
 * 音频处理服务实现
 */
export declare class AudioProcessor implements IAudioProcessor {
    private logger;
    private config;
    constructor();
    /**
     * 加载音频处理配置
     */
    private loadConfig;
    /**
     * 检查是否为音频专用房间
     */
    isAudioOnlyRoom(roomId: number): boolean;
    /**
     * 从文件名中提取房间ID
     */
    extractRoomIdFromFilename(filename: string): number | null;
    /**
     * 执行FFmpeg命令
     */
    private runFfmpegCommand;
    /**
     * 检查FFmpeg是否可用
     */
    checkFfmpegAvailability(): Promise<boolean>;
    /**
     * 转换视频为音频
     */
    convertVideoToAudio(videoPath: string, audioFormat?: string): Promise<string>;
    /**
     * 处理音频专用房间的视频
     */
    processAudioOnlyRoom(videoPath: string, roomId?: number): Promise<string | null>;
    /**
     * 主处理函数（供外部调用）
     */
    processVideoForAudio(videoPath: string, roomId?: number): Promise<string | null>;
    /**
     * 批量处理视频文件
     * @param videoPaths 视频文件路径数组
     * @returns 处理结果数组
     */
    batchProcessVideos(videoPaths: string[]): Promise<Array<{
        videoPath: string;
        audioPath: string | null;
        success: boolean;
    }>>;
    /**
     * 获取音频处理统计信息
     */
    getStats(): {
        enabled: boolean;
        audioOnlyRoomsCount: number;
        ffmpegPath: string;
        defaultFormat: string;
    };
}
/**
 * 创建音频处理服务实例
 */
export declare function createAudioProcessor(): IAudioProcessor;
