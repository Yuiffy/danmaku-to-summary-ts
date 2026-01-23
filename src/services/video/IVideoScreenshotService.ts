/**
 * 视频截图服务接口
 */
export interface IVideoScreenshotService {
  /**
   * 生成视频截图（在1/5、2/5、3/5、4/5时间点截取并拼接成2x2图）
   * @param videoPath 视频文件路径
   * @returns 截图文件路径，失败返回null
   */
  generateScreenshots(videoPath: string): Promise<string | null>;
}
