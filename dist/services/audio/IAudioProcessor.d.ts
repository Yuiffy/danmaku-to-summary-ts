/**
 * 音频处理服务接口
 * 定义音频处理的核心功能
 */
export interface IAudioProcessor {
    /**
     * 检查是否为音频专用房间
     * @param roomId 房间ID
     * @returns 是否为音频专用房间
     */
    isAudioOnlyRoom(roomId: number): boolean;
    /**
     * 从文件名中提取房间ID
     * @param filename 文件名
     * @returns 房间ID或null
     */
    extractRoomIdFromFilename(filename: string): number | null;
    /**
     * 检查FFmpeg是否可用
     * @returns FFmpeg是否可用
     */
    checkFfmpegAvailability(): Promise<boolean>;
    /**
     * 转换视频为音频
     * @param videoPath 视频文件路径
     * @param audioFormat 音频格式（默认：'.m4a'）
     * @returns 生成的音频文件路径
     */
    convertVideoToAudio(videoPath: string, audioFormat?: string): Promise<string>;
    /**
     * 处理音频专用房间的视频
     * @param videoPath 视频文件路径
     * @param roomId 房间ID（可选，可从文件名提取）
     * @returns 生成的音频文件路径或null
     */
    processAudioOnlyRoom(videoPath: string, roomId?: number): Promise<string | null>;
    /**
     * 主处理函数（供外部调用）
     * @param videoPath 视频文件路径
     * @param roomId 房间ID（可选）
     * @returns 生成的音频文件路径或null
     */
    processVideoForAudio(videoPath: string, roomId?: number): Promise<string | null>;
}
/**
 * 音频处理配置接口
 */
export interface AudioProcessingConfig {
    enabled: boolean;
    audioOnlyRooms: number[];
    keepOriginalVideo: boolean;
    ffmpegPath: string;
    defaultFormat: string;
    timeouts: {
        ffmpegTimeout: number;
    };
}
/**
 * FFmpeg命令执行结果
 */
export interface FfmpegResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
/**
 * 音频处理选项
 */
export interface AudioProcessingOptions {
    /** 是否删除原始视频文件 */
    deleteOriginal?: boolean;
    /** 音频格式 */
    audioFormat?: string;
    /** 超时时间（毫秒） */
    timeout?: number;
}
