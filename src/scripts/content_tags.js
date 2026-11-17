'use strict';

/**
 * Content-based automatic Bilibili tag derivation for AI clips.
 *
 * Bilibili tags only carry search weight when the tag already exists on the
 * platform, so every mood/game tag below is a deliberately small whitelist of
 * tags that were verified to exist before being added here. Game names are
 * extracted from 《...》 in the stream title plus an alias table; mood and
 * discovery tags only fire when the clip's own transcript/keywords contain
 * explicit cues.
 */

const GAME_ALIASES = [
    { pattern: /影之刃\s*[:：]?\s*零/u, tags: ['影之刃零', '影之刃'] },
    { pattern: /艾尔登法环|老头环/u, tags: ['艾尔登法环', '老头环'] },
    { pattern: /只狼/u, tags: ['只狼', '只狼：影逝二度'] },
    { pattern: /黑神话\s*[:：]?\s*悟空/u, tags: ['黑神话悟空'] },
    { pattern: /空洞骑士/u, tags: ['空洞骑士'] },
    { pattern: /塞尔达/u, tags: ['塞尔达传说'] },
    { pattern: /马里奥|马力欧/u, tags: ['马里奥'] },
    { pattern: /原神/u, tags: ['原神'] },
    { pattern: /星穹铁道/u, tags: ['崩坏：星穹铁道'] },
    { pattern: /绝区零/u, tags: ['绝区零'] },
    { pattern: /鸣潮/u, tags: ['鸣潮'] },
    { pattern: /\bapex\b/u, tags: ['Apex英雄'] },
    { pattern: /英雄联盟|LoL\b/u, tags: ['英雄联盟'] },
    { pattern: /王者荣耀/u, tags: ['王者荣耀'] },
    { pattern: /我的世界|minecraft/u, tags: ['我的世界', 'Minecraft'] },
    { pattern: /糖豆人/u, tags: ['糖豆人'] },
    { pattern: /双人成行/u, tags: ['双人成行'] },
    { pattern: /胡闹厨房/u, tags: ['胡闹厨房'] },
    { pattern: /吸血鬼幸存者/u, tags: ['吸血鬼幸存者'] },
    { pattern: /恐怖游戏|港诡实录|纸嫁衣|生化危机|寂静岭|面容|探灵直播/u, tags: ['恐怖游戏'] }
];

// Mood cues must appear in the clip's own transcript or matched keywords.
// Danmaku reactions are intentionally NOT scanned here: they are noisy and
// would tag almost every clip as 搞笑.
const MOOD_RULES = [
    { tag: '搞笑', pattern: /(笑死|笑不活|乐死|太逗了|绷不住|哈哈哈哈|整活|搞笑|沙雕)/u },
    { tag: '可爱', pattern: /(可爱|好萌|萌死|萌萌|好乖|好软|好甜|卡哇伊|萌)/u },
    { tag: '萌宠', pattern: /(猫猫|小猫|猫咪|喵|狗狗|小狗|汪|兔兔|小兔|宠物|萌宠|毛茸茸|獭獭)/u },
    { tag: '高能', pattern: /(高能|名场面|天秀|封神|神仙操作)/u },
    { tag: '温情', pattern: /(温情|温馨|感动|泪目|治愈|暖心|破防)/u },
    { tag: '翻唱', pattern: /(翻唱|唱歌|歌回|清唱)/u }
];

// Topic-specific nouns are kept in a small controlled list so a single ASR
// mistake or an arbitrary phrase cannot become a public Bilibili tag.  The
// aliases "割追追" and "假锥锥" are confirmed ASR spellings of "假追追".
const CONTENT_TAG_RULES = [
    { tags: ['4i', '四爱'], pattern: /4i|四爱/iu },
    { tags: ['假追追'], pattern: /假追追|割追追|假锥锥/u },
    { tags: ['饼干岁'], pattern: /饼干岁|\bbgs\b/iu }
];

function normalizeAiContentTags(value) {
    return Array.from(new Set((Array.isArray(value) ? value : [])
        .filter(tag => typeof tag === 'string')
        .map(tag => tag.trim().replace(/^#+|#+$/gu, ''))
        .filter(tag => tag && tag.length <= 30 && !/[,，;；\r\n]/u.test(tag)
            && !/^VirtuaReal$/iu.test(tag)))).slice(0, 6);
}

function contentTagsPromptLines(recordingContext = null) {
    return [
        '每段同时输出tags字符串数组：按本片实际内容选择3–6个可检索标签，优先具体游戏名、话题中提到的事物，以及有依据的搞笑、可爱、萌宠等引流标签；主播小名和直播切片等默认标签由系统添加，不占本数组名额。没有依据时允许[]。',
        '游戏不必在本片反复念出名字，但必须结合本片玩法、角色、道具和已验证整场背景确认；整场玩过某游戏不等于所有杂谈都带该游戏标签。不能只凭直播标题或其他候选的内容补标签。',
        '若本片明确是战斗、探索、操作或游戏BUG反应，已验证actualGames只有一项且无切换到其他游戏的证据，tags必须包含该游戏名，排在游戏实况/游戏BUG等泛标签前；不能因为片内没复读游戏名而漏掉。独立生活杂谈仍不套用。',
        '人物标签用小岁、小栞等安全昵称，禁止岁己、栞栞等正式名；不要生成机构标签，VirtuaReal只由主播归属配置添加。',
        ...(recordingContext ? [`已验证录播游戏背景（只供消歧，不是本片发生过的证明）：${JSON.stringify(recordingContext)}`] : [])
    ];
}

function normalizeTagList(value) {
    return Array.from(new Set(String(value || '')
        .split(/[,，、;；\s]+/u)
        .map(tag => String(tag || '').trim())
        .filter(Boolean)));
}

function extractGameTags(streamTitle = '', extraText = '') {
    const title = String(streamTitle || '');
    const tags = new Set();

    // 1. Explicit 《...》 book title marks: trust them as-is (strip inner
    //    punctuation variants like 影之刃：零 -> 影之刃零 handled by aliases).
    for (const match of title.matchAll(/《([^《》]{1,30})》/gu)) {
        const name = String(match[1] || '').trim().replace(/\s+/g, '');
        if (name) tags.add(name);
    }

    // 2. Alias table against title (and optionally other context text).
    const haystacks = [title, ...(extraText ? [String(extraText)] : [])];
    for (const alias of GAME_ALIASES) {
        if (haystacks.some(text => alias.pattern.test(text))) {
            alias.tags.forEach(tag => tags.add(tag));
        }
    }
    return Array.from(tags);
}

function deriveMoodTags(text = '') {
    const haystack = String(text || '');
    if (!haystack) return [];
    return MOOD_RULES
        .filter(rule => rule.pattern.test(haystack))
        .map(rule => rule.tag);
}

function deriveContentTopicTags(text = '') {
    const haystack = String(text || '');
    if (!haystack) return [];
    return CONTENT_TAG_RULES.flatMap(rule => rule.pattern.test(haystack) ? rule.tags : []);
}

/**
 * Derive content tags for one clip.
 * @param {object} input
 * @param {string} input.streamTitle - stream/live title (game name source)
 * @param {string[]} [input.matchedKeywords] - keywords that triggered this clip
 * @param {string} [input.text] - clip transcript text (window-scoped)
 * @returns {string[]}
 */
function deriveContentTags({ streamTitle = '', matchedKeywords = [], text = '', aiTags = [] } = {}) {
    const keywords = (Array.isArray(matchedKeywords) ? matchedKeywords : [])
        .map(keyword => String(keyword || '')).join('\n');
    const evidenceText = [keywords, text].filter(Boolean).join('\n');
    return Array.from(new Set([
        ...normalizeAiContentTags(aiTags),
        // A game mentioned in the clip is useful discovery evidence too, but
        // only aliases from the maintained whitelist may become a tag.
        ...extractGameTags(streamTitle, evidenceText),
        ...deriveMoodTags(evidenceText),
        ...deriveContentTopicTags(evidenceText)
    ]));
}

module.exports = {
    normalizeAiContentTags,
    contentTagsPromptLines,
    normalizeTagList,
    extractGameTags,
    deriveMoodTags,
    deriveContentTopicTags,
    deriveContentTags,
    GAME_ALIASES,
    MOOD_RULES,
    CONTENT_TAG_RULES
};
