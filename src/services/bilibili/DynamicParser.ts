/**
 * B站动态数据解析器
 * 负责将API返回的原始数据解析为统一的BilibiliDynamic格式
 */

import { BilibiliDynamic, DynamicType } from './interfaces/types';
import { getLogger } from '../../core/logging/LogManager';

const logger = getLogger('DynamicParser');

/**
 * 新版API动态数据结构
 */
interface DynamicItemV2 {
  id_str: string;
  type: string;
  basic: {
    rid_str?: string;
    comment_type?: number;
    comment_id_str?: string;
    jump_url?: string;
  };
  visible?: boolean;
  modules: {
    module_author: {
      mid: number;
      pub_ts: string;
      name?: string;
    };
    module_dynamic: {
      major: {
        type: string;
        opus?: {
          jump_url?: string;
          title?: string;
          summary?: {
            text?: string;
          };
          pics?: Array<{
            url: string;
            width?: number;
            height?: number;
          }>;
        };
        draw?: {
          text?: string;
          description?: string;
          items?: Array<{
            src?: string;
            url?: string;
          }>;
          jump_url?: string;
        };
        archive?: {
          desc?: string;
          title?: string;
          jump_url?: string;
        };
        article?: {
          title?: string;
          desc?: string;
          jump_url?: string;
        };
        common?: {
          text?: string;
          emoji?: {
            text?: string;
          };
        };
      };
    };
  };
}

/**
 * 旧版API动态数据结构
 */
interface DynamicItemV1 {
  card: string | {
    item?: {
      uri?: string;
      description?: string;
      pictures?: Array<{
        img_src: string;
      }>;
      content?: string;
      title?: string;
    };
  };
  desc: {
    dynamic_id_str: string;
    user_profile: {
      info: {
        uid: string;
      };
    };
    timestamp: number;
  };
}

/**
 * 动态类型映射
 */
const DYNAMIC_TYPE_MAP: Record<string, DynamicType> = {
  'DYNAMIC_TYPE_AV': DynamicType.AV,
  'DYNAMIC_TYPE_WORD': DynamicType.WORD,
  'DYNAMIC_TYPE_DRAW': DynamicType.DRAW,
  'DYNAMIC_TYPE_ARTICLE': DynamicType.ARTICLE,
  'MAJOR_TYPE_OPUS': DynamicType.WORD, // OPUS类型根据内容判断
  'MAJOR_TYPE_DRAW': DynamicType.DRAW,
  'MAJOR_TYPE_ARCHIVE': DynamicType.AV,
  'MAJOR_TYPE_ARTICLE': DynamicType.ARTICLE,
  'MAJOR_TYPE_COMMON': DynamicType.WORD,
};

/**
 * 解析动态项
 */
export function parseDynamicItem(item: any): BilibiliDynamic | null {
  if (!item) {
    return null;
  }

  // 新版API使用modules字段
  if (item.modules) {
    return parseDynamicItemV2(item as DynamicItemV2);
  }

  // 旧版API使用card和desc字段
  if (item.card && item.desc) {
    return parseDynamicItemV1(item as DynamicItemV1);
  }

  logger.debug('动态项没有可识别的字段', { itemKeys: Object.keys(item) });
  return null;
}

/**
 * 解析新版API动态项
 */
function parseDynamicItemV2(item: DynamicItemV2): BilibiliDynamic | null {
  try {
    const { id_str, type, basic, modules } = item;

    if (!id_str || !modules) {
      logger.debug('动态项缺少必要字段', { id_str, hasModules: !!modules });
      return null;
    }

    const { module_author, module_dynamic } = modules;
    if (!module_author || !module_dynamic) {
      logger.debug('动态项缺少module_author或module_dynamic');
      return null;
    }

    const { mid, pub_ts } = module_author;
    const { major } = module_dynamic;

    if (!major) {
      logger.debug('动态项缺少major字段');
      return null;
    }

    // 解析动态内容
    const { type: dynamicType, content, images } = parseMajorContent(major);

    if (!dynamicType) {
      logger.debug('无法解析动态类型', { majorType: major.type });
      return null;
    }

    // 获取发布时间
    const publishTime = pub_ts ? new Date(Number(pub_ts) * 1000) : new Date();

    // 获取动态URL
    const jumpUrl = basic.jump_url || major.opus?.jump_url || major.draw?.jump_url || major.archive?.jump_url || major.article?.jump_url || '';
    const url = jumpUrl.startsWith('//') ? `https:${jumpUrl}` : jumpUrl;

    return {
      id: id_str,
      uid: String(mid),
      type: dynamicType,
      content,
      images: images.length > 0 ? images : undefined,
      publishTime,
      url: url || `https://www.bilibili.com/opus/${id_str}`,
      rawData: item
    };
  } catch (error) {
    logger.warn('解析新版动态项失败', { error });
    return null;
  }
}

/**
 * 解析major内容
 */
function parseMajorContent(major: DynamicItemV2['modules']['module_dynamic']['major']): {
  type: DynamicType | null;
  content: string;
  images: string[];
} {
  const { type: majorType, opus, draw, archive, article, common } = major;

  // LIVE_RCMD类型（直播推荐）- 跳过，不回复此类动态
  if (majorType === 'MAJOR_TYPE_LIVE_RCMD') {
    logger.debug('跳过直播推荐类型动态', { majorType });
    return {
      type: null,
      content: '',
      images: []
    };
  }

  // OPUS类型（图文混合）
  if (majorType === 'MAJOR_TYPE_OPUS' && opus) {
    const content = opus.summary?.text || opus.title || '';
    const images = opus.pics?.map(pic => pic.url) || [];
    return {
      type: images.length > 0 ? DynamicType.DRAW : DynamicType.WORD,
      content,
      images
    };
  }

  // DRAW类型（图片动态）
  if (majorType === 'MAJOR_TYPE_DRAW' && draw) {
    const content = draw.text || draw.description || '';
    const images = draw.items?.map(item => item.src || item.url).filter((url): url is string => Boolean(url)) || [];
    return {
      type: DynamicType.DRAW,
      content,
      images
    };
  }

  // ARCHIVE类型（视频动态）
  if (majorType === 'MAJOR_TYPE_ARCHIVE' && archive) {
    return {
      type: DynamicType.AV,
      content: archive.desc || archive.title || '',
      images: []
    };
  }

  // ARTICLE类型（文章动态）
  if (majorType === 'MAJOR_TYPE_ARTICLE' && article) {
    return {
      type: DynamicType.ARTICLE,
      content: article.title || article.desc || '',
      images: []
    };
  }

  // COMMON类型（纯文本动态）
  if (majorType === 'MAJOR_TYPE_COMMON' && common) {
    return {
      type: DynamicType.WORD,
      content: common.emoji?.text || common.text || '',
      images: []
    };
  }

  return {
    type: null,
    content: '',
    images: []
  };
}

/**
 * 解析旧版API动态项
 */
function parseDynamicItemV1(item: DynamicItemV1): BilibiliDynamic | null {
  try {
    const { card, desc } = item;

    if (!card || !desc) {
      logger.debug('动态项缺少card或desc字段');
      return null;
    }

    const cardData = typeof card === 'string' ? JSON.parse(card) : card;
    const cardItem = cardData.item;

    if (!cardItem) {
      logger.debug('动态项cardData没有item字段');
      return null;
    }

    // 解析动态类型
    let type: DynamicType;
    let content = '';
    let images: string[] = [];

    if (cardItem.uri) {
      type = DynamicType.AV;
      content = cardItem.description || '';
    } else if (cardItem.pictures) {
      type = DynamicType.DRAW;
      content = cardItem.description || '';
      images = cardItem.pictures.map((pic: any) => pic.img_src);
    } else if (cardItem.content) {
      type = DynamicType.WORD;
      content = cardItem.content;
    } else if (cardItem.title) {
      type = DynamicType.ARTICLE;
      content = cardItem.title;
    } else {
      logger.debug('动态项cardData.item没有匹配的类型');
      return null;
    }

    return {
      id: desc.dynamic_id_str,
      uid: desc.user_profile.info.uid,
      type,
      content,
      images: images.length > 0 ? images : undefined,
      publishTime: new Date(desc.timestamp * 1000),
      url: `https://www.bilibili.com/opus/${desc.dynamic_id_str}`,
      rawData: item
    };
  } catch (error) {
    logger.warn('解析旧版动态项失败', { error });
    return null;
  }
}

/**
 * 批量解析动态项
 */
export function parseDynamicItems(items: any[]): BilibiliDynamic[] {
  const dynamics: BilibiliDynamic[] = [];

  for (const item of items) {
    const dynamic = parseDynamicItem(item);
    if (dynamic) {
      // 过滤掉视频类型的动态，只保留非视频动态
      if (dynamic.type !== DynamicType.AV) {
        dynamics.push(dynamic);
      } else {
        logger.debug('跳过视频类型动态', { dynamicId: dynamic.id, type: dynamic.type });
      }
    }
  }

  return dynamics;
}
