/**
 * B站API服务接口
 */
import { BilibiliDynamic, PublishCommentRequest, PublishCommentResponse } from './types';

export interface IBilibiliAPIService {
  /**
   * 获取主播动态列表
   * @param uid 主播UID
   * @param offset 偏移量（用于分页）
   * @returns 动态列表
   */
  getDynamics(uid: string, offset?: string): Promise<BilibiliDynamic[]>;

  /**
   * 发布动态评论
   * @param request 评论请求
   * @returns 评论响应
   */
  publishComment(request: PublishCommentRequest): Promise<PublishCommentResponse>;

  /**
   * 上传图片
   * @param imagePath 图片路径
   * @returns 图片URL
   */
  uploadImage(imagePath: string): Promise<string>;

  /**
   * 检查Cookie是否有效
   * @returns 是否有效
   */
  isCookieValid(): Promise<boolean>;

  /**
   * 从Cookie中提取CSRF Token
   * @param cookie Cookie字符串
   * @returns CSRF Token
   */
  extractCSRF(cookie: string): string;
}
