import {
  NamesConfig,
  RoomAIConfig
} from '../IAITextGenerator';

export interface GoodnightReplyInspection {
  ok: boolean;
  reason?: string;
  cleaned: string;
  minLength: number;
  sentenceCount: number;
}

/** Owns room-specific wording rules for generated post-stream replies. */
export class GoodnightReplyPolicy {
  constructor(private readonly config: any) {}

  getNames(roomId?: string): NamesConfig {
    const defaultNames = this.config.ai?.defaultNames || { anchor: '岁己SUI', fan: '饼干岁' };
    if (!roomId) {
      return defaultNames;
    }

    const roomConfig = this.config.ai?.roomSettings?.[roomId] as RoomAIConfig | undefined;
    if (!roomConfig) {
      return defaultNames;
    }

    return {
      anchor: roomConfig.anchorName || defaultNames.anchor,
      anchorNicknames: Array.isArray(roomConfig.anchorNicknames)
        ? roomConfig.anchorNicknames
        : undefined,
      fan: roomConfig.fanName || defaultNames.fan
    };
  }

  getWordLimit(roomId?: string): number {
    const defaultWordLimit = this.config.ai?.defaultWordLimit ?? 100;
    if (!roomId) {
      return defaultWordLimit;
    }

    const roomConfig = this.config.ai?.roomSettings?.[roomId] as RoomAIConfig | undefined;
    if (roomConfig?.wordLimit !== undefined) {
      return roomConfig.wordLimit;
    }
    return defaultWordLimit;
  }

  buildPrompt(highlightContent: string, roomId?: string, liveTimeDesc?: string | null): string {
    const names = this.getNames(roomId);
    const anchor = names.anchor;
    const fan = names.fan;
    const namingGuidance = this.buildNamingGuidance(roomId);
    const wordLimit = this.getWordLimit(roomId);

    return `${namingGuidance}

【角色设定】

身份：${anchor}的粉丝，属于“${fan}”粉丝群体；“${fan}”是评论者身份，不是主播称呼。

性格：喜欢调侃、宠溺主播，有点话痨，对主播的生活琐事和梗如数家珍。

语气：亲昵、幽默、像老朋友一样聊天。常用语气词（如：哈哈、捏、嘛、呜呜），会使用直播间黑话（如：老己、漂亮饭、阿肯苦力等）。

【核心原则（最重要！）】

严格限定素材：只根据用户当前提供的文档/文本内容进行创作。绝对禁止混入该文档以外的任何已知信息、历史直播内容或互联网搜索结果（因为${anchor}的梗很多，AI容易串台，这一点必须强调）。

说话人标签：直播摘要可能带有“[说话人标签 分数]”前缀。不同标签代表不同的声学说话人；回复对象始终是房主${anchor}。其他标签说“我是XX”时，只能据此理解该标签的身份，不能把房主改叫XX，也不能把该标签的经历或台词归给${anchor}。“SPEAKER_nn”表示尚未实名的嘉宾或外部声音，不要擅自猜实名。

时效性：${liveTimeDesc ? `该直播时段为北京时间 ${liveTimeDesc}。这是下播回复，不要默认写“晚安”；只有明确是夜间或深夜时，才自然使用“晚安”，其他时段围绕直播辛苦和休息表达。` : '这是下播回复，不要默认写“晚安”；没有可靠时段信息时，围绕直播辛苦和休息表达。'}

【写作结构与要素】

开场白：
- 可以直接接入本场第一个具体细节或直播梗，不必先写称呼或问候。
- 如果称呼主播，遵守上面的称谓边界，不要把粉丝昵称当作主播称呼。
- 优先直接回应本场一个具体细节、主播原话或弹幕反应；如需称呼主播，自然嵌入即可，不必固定放在开头。

正文（核心内容回顾）：
抓细节：从文档中提取3-5个具体的直播亮点。
生活碎碎念（如：洗碗、吃东西、身体不舒服、猫咪的趣事）。
直播事故/趣事（如：迟到理由、设备故障、口误、奇怪的脑洞）。
鉴赏/游戏环节（如：看了什么电影/视频、玩了什么游戏，主播的反应和吐槽）。
歌回：提到了哪些歌，唱得怎么样（好听/糊弄/搞笑）。
互动吐槽：针对上述细节进行粉丝视角的吐槽或夸奖（如:"只有你能干出这事"、"心疼小笨蛋"、"笑死我了")。

结尾（情感升华）：
关怀：叮嘱主播注意身体（嗓子、睡眠、吃饭），不要太累。
期待：确认下一次直播的时间（如果文档里提到了）。
如果需要落款或自称，只能把“${fan}”当作粉丝身份使用，不要把它写成主播称呼；也可以不写落款。

字数要求：${wordLimit}字以内。

【直播内容摘要】
${highlightContent}

请根据以上直播内容，从“${fan}”粉丝的视角写一篇动态回复。记住：只使用提供的直播内容，不要添加任何外部信息。`;
  }

  inspect(text: string, wordLimit: number, roomId?: string): GoodnightReplyInspection {
    const cleaned = this.cleanGeneratedReply(text);
    const minLength = this.getMinimumReplyLength(wordLimit);
    const sentenceCount = this.countSentences(cleaned);
    const result = { cleaned, minLength, sentenceCount };

    if (!cleaned) {
      return { ok: false, reason: '生成的文本为空', ...result };
    }

    const fanNameOpeningIssue = this.getFanNameOpeningIssue(cleaned, roomId);
    if (fanNameOpeningIssue) {
      return { ok: false, reason: fanNameOpeningIssue, ...result };
    }

    if (cleaned.length < minLength) {
      return {
        ok: false,
        reason: `生成的文本过短（${cleaned.length} < ${minLength}）`,
        ...result
      };
    }

    if (wordLimit >= 250 && sentenceCount < 2) {
      return {
        ok: false,
        reason: `生成的文本句子数过少（${sentenceCount} < 2）`,
        ...result
      };
    }

    return { ok: true, ...result };
  }

  private getAnchorNames(roomId?: string): string[] {
    const names = this.getNames(roomId);
    const anchor = String(names.anchor || '').trim();
    const nicknames = (names.anchorNicknames || [])
      .map(name => String(name || '').trim())
      .filter(Boolean);
    const nativePrefix = anchor.match(/^([\p{Script=Han}]{1,12})(?=[A-Za-z])/u)?.[1];
    const orderedNames = nativePrefix
      ? [...nicknames, nativePrefix, anchor]
      : [anchor, ...nicknames];
    return Array.from(new Set(orderedNames.filter(Boolean)));
  }

  private buildNamingGuidance(roomId?: string): string {
    const names = this.getNames(roomId);
    const anchorNameList = this.getAnchorNames(roomId)
      .map(name => `“${name}”`)
      .join('、');

    return `【主播与粉丝称谓边界（最高优先级）】
- 回复对象是主播“${names.anchor}”。主播可用称呼只有：${anchorNameList}。
- 粉丝昵称是“${names.fan}”，它表示粉丝/评论者所属的粉丝群体，不是主播名字。
- 绝对不能用“${names.fan}”称呼主播，不能写“${names.fan}！”、“晚安${names.fan}”或让“${names.fan}”出现在开头称呼位置。
- 开头不必每次直呼主播名字，可以直接从本场具体内容起笔。若写称呼，优先选上面列表中较短、口语化的称呼，不要每条都固定照抄“${names.anchor}”。
- 如需表达评论者身份，“${names.fan}”只能作为粉丝自称/群体名自然出现，也可以完全不提。`;
  }

  private cleanGeneratedReply(text: string): string {
    let cleaned = String(text || '').trim();
    cleaned = cleaned.replace(/^```(?:markdown|md)?\s*/i, '');
    cleaned = cleaned.replace(/```$/i, '');
    cleaned = cleaned.replace(/^.*?(?=^#|^[^\s#])/ms, match => {
      const lines = match.split('\n').filter(line => line.trim() !== '');
      return lines.length <= 1 ? match : '';
    });
    cleaned = cleaned.replace(/^\s*>\s*/gmu, '');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
  }

  private getFanNameOpeningIssue(text: string, roomId?: string): string | undefined {
    const fan = this.getNames(roomId).fan.trim();
    const fanNames = Array.from(new Set([fan, fan.replace(/岁$/u, '')].filter(Boolean)));
    const startsWithFanName = fanNames.some(name => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(
        `^(?:晚安|早安|午安|下午好|晚上好)?\\s*${escaped}(?=\\s|[!！?？,，。:：、~～🌙☀️]|$)`,
        'u'
      ).test(text);
    });

    return startsWithFanName
      ? `开头误把粉丝昵称“${fan}”当成主播称呼`
      : undefined;
  }

  private countSentences(text: string): number {
    const normalized = String(text || '').trim();
    if (!normalized) {
      return 0;
    }
    const matches = normalized.match(/[。！？.!?]+/g);
    return matches ? matches.length : 1;
  }

  private getMinimumReplyLength(wordLimit: number): number {
    if (wordLimit >= 500) return 120;
    if (wordLimit >= 250) return 80;
    return 40;
  }
}
