import { shanghaiDay, unsafeComment } from './CommentPolicy';
export interface CommentVisualTarget { cid: string; duration: number }

export interface VideoCue { at: number; text: string }
export interface CommentVideo { title: string; description: string; publishedAt: number; ownerUid?: string;
  transcript?: { language: string; cues: VideoCue[]; partial: boolean }; pages?: number; visualTarget?: CommentVisualTarget }
export interface CommentClue { room: string; date: string; time: string; quote: string; kind?: string }
export interface CommentPostText { author: string; publishedAt: number; publishedDay?: string; text: string; mentionedUsers?: number }
export interface CommentPost extends CommentPostText { original?: CommentPostText; partial?: boolean }
export interface CommentProject { source: string; label: string; kind: 'code' | 'skill' | 'guide'; revision: string; text: string }
export interface CommentContext {
  videoOwnerUid?: string;
  visualTarget?: CommentVisualTarget;
  anchorDay: string; targetDay?: string; anchorBasis?: 'broadcast' | 'video-published' | 'comment' | 'unknown';
  video?: { title: string; description: string; content?: 'subtitles' | 'unavailable';
    scope?: 'first-page'; language?: string; sampled?: boolean; excerpts?: VideoCue[] };
  coverage: 'partial' | 'available' | 'unavailable'; clues: CommentClue[];
  projects?: CommentProject[];
}
export interface CommentSocialContext {
  speaker: { name: string; identity: 'configured' | 'unverified'; fanTier?: string; wearingMedal?: string; medalStatus?: string };
  hotComments?: Array<{ text: string; likes: number }>;
  post?: CommentPost;
}
export const videoContentQuestion = (text: string) => /总结|评价|点评|分析|概括|讲解|解读|观后感|讲了啥|说了啥|怎么看|讲的啥|说的啥|视频|这段|这期/u.test(text);
export const visualCommentQuestion = (text: string) => /画面|屏幕|镜头|出镜|穿着|穿的|衣服|长什么样|什么颜色|什么动作|做了什么动作|图中|图里|字幕.{0,8}(?:写|错|挡|看不清)|(?:开头|结尾|最后).{0,8}(?:显示|出现|看到)|(?:上面|里面).{0,4}写.{0,4}(?:什么|啥)/u.test(text);
// A deictic tool-cost question refers to the mentioned video's tool, not the bot's own usage.
const videoToolCostQuestion = (text: string) => /这(?:个|套|种)?\s*(?:插件|技能|skill)/iu.test(text) &&
  /tokens?|费用|成本|花费|收费|耗|省|贵|便宜|多少钱/iu.test(text);
export const projectComparisonQuestion = (text: string) => /我们[^。！？!?]{0,12}(?:能用|用得上|适合|支持)|这(?:套|种|个)(?:方式|方法|方案|流程|技术)|(?:对比|比较)[^。！？!?]{0,20}(?:代码|skill|流程|项目)|(?:代码|skill|工作流)[^。！？!?]{0,20}(?:支持|对比)/iu.test(text);
export const commentHelpQuestion = (text: string) => /你(?:能|会|可以)(?:做|干)(?:些|点)?(?:什么|啥)|你(?:能|会|可以)帮(?:我|我们)?(?:做)?(?:什么|啥)|怎么(?:用|叫|问)你|(?:你|鹿饼)(?:有|的)(?:什么功能|使用方法|使用说明)/u.test(text);
export function implicitVideoRequest(text: string): boolean {
  const request = text.replace(/@[^\s，,:：。！？!?]+/gu, '').replace(/^回复\s*[:：]?/u, '').trim();
  return /@/u.test(text) && !request ||
    /^(?:(?:你虽然不是[^,，]{1,12}[,，]\s*)?你也过来|(?:你也?|鹿饼)?(?:过来|来)(?:看看|点评)(?:一下|下)?)[~～!！。.?？]*$/u.test(request);
}
export const needsCommentEvidence = (text: string, type?: number) => !commentHelpQuestion(text) && (type === 1 && (implicitVideoRequest(text) || videoToolCostQuestion(text)) ||
  visualCommentQuestion(text) || videoContentQuestion(text) || projectComparisonQuestion(text) || /谁|哪些|什么|哪位|几点|何时|多少|哪天|哪场|哪次|联动|鸡马|舰礼|礼物|计划|安排|为什么|为啥|怎么|找出|记得|之前|上次|出处|原话|台词|时间点|时间戳|几分|黑料|(?:小岁|岁己|栞栞).{0,6}(?:是吧|对吧|吗)/u.test(text));
export const collaborationQuestion = (text: string) => /联动|鸡马|连麦/u.test(text);
export const historicalCollaborationQuestion = (text: string) => collaborationQuestion(text) &&
  /之前|以前|以往|过去|历史|历次|上次|回顾|盘点|几次|几场|多次|多场|(?:前|最近)[一二三四五六七八九十\d]+[次场]/u.test(text);
export const videoOverviewQuestion = (text: string) => /总结|评价|点评|分析|概括|讲解|解读|观后感|讲了啥|说了啥|怎么看|讲的啥|说的啥/u.test(text);
export const videoOnlyQuestion = (text: string) => (
  visualCommentQuestion(text) ||
  implicitVideoRequest(text) || videoToolCostQuestion(text) || projectComparisonQuestion(text) || /(?:小岁|岁己|栞栞).{0,6}(?:是吧|对吧|吗)/u.test(text) ||
  /回复(?:一下|下)?[^。！？!?]{0,6}(?:视频|这段|这期)/u.test(text) ||
  /(?:视频|这段|这期|该片)(?:里|中)?(?:说|讲|提到|提及)/u.test(text) ||
  /(?:视频|这段|这期|该片)(?:里|中).{0,20}(?:原话|台词|时间点|时间戳|几分)/u.test(text) ||
  /(?:根据|结合|依据|针对|按照|看完|看下|看看|看一下)[^。！？!?]{0,12}(?:视频|这段|这期|该片)/u.test(text) ||
  videoOverviewQuestion(text) && (/视频|这段|这期|这条|这个|该片|内容/u.test(text) ||
    /^(?:总结|评价|点评|分析|概括|讲解|解读)(?:一下|下)?[\s。？！!?]*$/u.test(text.replace(/@\S+/gu, '').trim())));
const clean = (text: string, max: number) => Array.from(text.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')).slice(0, max).join('');
export function safeEvidenceText(text: string, max = 180): string {
  const value = clean(text, max);
  return unsafeComment(value) ? '' : value;
}
export function commentDates(text: string, at: number, video?: CommentVideo, isVideo = false): Pick<CommentContext, 'anchorDay' | 'targetDay' | 'anchorBasis'> {
  // Relative dates in a clip refer to the source broadcast, never the worker's execution date.
  const source = /直播开始时间[：:]\s*(20\d\d-\d{2}-\d{2})/u.exec(video?.description || '')?.[1];
  const valid = (day: string) => Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
  const knownSource = source && valid(source) ? source : undefined;
  const anchorDay = knownSource || shanghaiDay(video?.publishedAt || at);
  const anchorBasis = knownSource ? 'broadcast' : video ? 'video-published' : isVideo ? 'unknown' : 'comment';
  const absolute = /(20\d\d)[年\-/](\d{1,2})[月\-/](\d{1,2})/u.exec(text);
  const monthDay = /(\d{1,2})月(\d{1,2})[日号]?/u.exec(text);
  const offset = /大后天/u.test(text) ? 3 : /后天/u.test(text) ? 2 : /明天|明晚|明早/u.test(text) ? 1 : /今天|今晚/u.test(text) ? 0 : undefined;
  const target = absolute ? `${absolute[1]}-${absolute[2].padStart(2, '0')}-${absolute[3].padStart(2, '0')}` :
    monthDay ? `${anchorDay.slice(0, 4)}-${monthDay[1].padStart(2, '0')}-${monthDay[2].padStart(2, '0')}` :
      offset !== undefined && (!isVideo || knownSource) ? new Date(Date.parse(anchorDay) + offset * 86400000).toISOString().slice(0, 10) : undefined;
  return { anchorDay, anchorBasis, ...(target && valid(target) ? { targetDay: target } : {}) };
}

export function quotedCommentTerms(text: string): string[] {
  return [...new Set([...text.matchAll(/[“「『"‘']([^”」』"’'\n]{2,40})[”」』"’']/gu)]
    .map(match => safeEvidenceText(match[1], 40)).filter(Boolean))].slice(0, 3);
}

export function commentSearchTerms(text: string): string[] {
  const quoted = quotedCommentTerms(text);
  if (quoted.length && /时间点|时间戳|几分|原话|出处|定位|哪句/u.test(text)) return quoted;
  if (collaborationQuestion(text)) return [...new Set([...quoted,
    ...(/鸡马|机嘛|复仇/u.test(text) ? ['联动', '连麦', '鸡马', '机嘛', '复仇'] : ['联动', '连麦'])])].slice(0, 5);
  if (/舰礼|上舰|礼物|提督|总督/u.test(text)) return ['舰礼', '舰长', '提督', '总督', '礼物'];
  const topic = text.replace(/@[^\s，,：:]+/gu, ' ').replace(/请|帮我|鹿饼|岁己|小岁|总结|评价|点评|分析|概括|讲解|解读|这个|该视频|视频|一下|是否|为什么|怎么|找出|的十大|什么|哪些/gu, ' ');
  const words = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(topic)]
    .filter(word => word.isWordLike && Array.from(word.segment).length >= 2 &&
      !/^(?:我们|你们|他们|那个|时候|之前|上次|是不是|记得|为什么|可以|还是|就是|不是|这样|现在|真的|一直|一下|有点)$/u.test(word.segment))
    .map(word => word.segment);
  return words.length || quoted.length ? [...new Set([...quoted, ...words])].slice(0, 5) : ['直播'];
}

/** Relevant answers and neighbours precede broad coverage when the byte/character budget is tight. */
function videoCuePriority(cues: VideoCue[], question: string, includeRest = false): number[] {
  const support = /夸|安慰|鼓励|打气|撑腰|说两句/u.test(question);
  const terms = commentSearchTerms(question).filter(term => term !== '直播');
  const quoted = quotedCommentTerms(question);
  const pairs = new Set(question.match(/[\p{Script=Han}]{2,}/gu)?.flatMap(word =>
    Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))) || []);
  const indices = new Set<number>();
  const ranked = cues.map((cue, index) => ({ index, score: terms.filter(term => cue.text.includes(term)).length * 3 +
    quoted.filter(term => cue.text.includes(term)).length * 40 +
    [...pairs].filter(term => cue.text.includes(term)).length +
    (support && /心情|委屈|失望|微妙|难过|担心|开心|害怕|不舒服|不容易/u.test(cue.text) ? 12 : 0) }))
    .filter(cue => cue.score).sort((a, b) => b.score - a.score).slice(0, 4);
  for (const { index } of ranked) for (const i of [index, index - 1, index + 1]) if (i >= 0 && i < cues.length) indices.add(i);
  if (support) for (let i = Math.max(0, cues.length - 4); i < cues.length; i++) indices.add(i);
  for (let i = 0; i < Math.min(6, cues.length); i++) indices.add(Math.round(i * (cues.length - 1) / Math.max(1, Math.min(6, cues.length) - 1)));
  // Keep neighbouring original lines so a sampled lyric or reaction is not presented in isolation.
  for (const i of [...indices]) if (i + 1 < cues.length) indices.add(i + 1);
  return [...indices, ...(includeRest ? cues.map((_, index) => index).filter(index => !indices.has(index)) : [])];
}

/** Choose by relevance first, then restore source order. Never truncate an original cue. */
export function videoExcerpts(cues: VideoCue[], question: string): VideoCue[] {
  let size = 0;
  const chosen = new Map<number, VideoCue>();
  for (const i of videoCuePriority(cues, question)) {
    if (Array.from(cues[i].text).length > 180) continue;
    const text = safeEvidenceText(cues[i].text, 180);
    if (!text || size + text.length > 700) continue;
    size += text.length; chosen.set(i, { at: cues[i].at, text });
  }
  return [...chosen.entries()].sort(([a], [b]) => a - b).map(([, cue]) => cue);
}

/** Keep complete evidence records under the existing reservation; never split a quote into invented fragments. */
export function fitCommentContext(text: string, system: string, context?: CommentContext, social?: CommentSocialContext, maxBytes = 3456): Array<{ role: string; content: string }> {
  const socialValue = social && structuredClone(social);
  const messages = (value?: CommentContext) => [{ role: 'system', content: system },
    { role: 'user', content: JSON.stringify({ untrustedComment: text, ...(value ? { untrustedEvidence: value } : {}),
      ...(socialValue ? { currentSpeaker: socialValue.speaker, untrustedHotComments: socialValue.hotComments || [],
        ...(socialValue.post ? { untrustedPost: socialValue.post } : {}) } : {}) }) }];
  const value = context ? structuredClone(context) : undefined;
  if (value) delete value.videoOwnerUid; // Trusted routing metadata, never model input.
  if (value) delete value.visualTarget;
  const bytes = () => Buffer.byteLength(JSON.stringify(messages(value)), 'utf8');
  while (bytes() > maxBytes && socialValue?.hotComments?.length) socialValue.hotComments.pop();
  // 4096 reservation minus 384 output and 256 protocol margin.
  if (bytes() > maxBytes && value?.video) { value.video.description = ''; value.coverage = 'partial'; }
  const excerpts = value?.video?.excerpts || [];
  const discard = videoCuePriority(excerpts, text, true).reverse().map(index => excerpts[index]);
  const trimVideo = () => {
    const cue = discard.shift()!;
    value!.video!.excerpts!.splice(value!.video!.excerpts!.indexOf(cue), 1);
    value!.video!.sampled = true; value!.coverage = 'partial';
  };
  // A recording question asked under a video must not lose its answer to unrelated target captions.
  if (needsCommentEvidence(text) && !videoOnlyQuestion(text) && value?.clues.length) {
    while (bytes() > maxBytes && (value.video?.excerpts?.length || 0) > 1) trimVideo();
    while (bytes() > maxBytes && value.clues.length > 1) { value.clues.pop(); value.coverage = 'partial'; }
    while (bytes() > maxBytes && value.video?.excerpts?.length) trimVideo();
  }
  while (bytes() > maxBytes && value?.clues.length) { value.clues.pop(); value.coverage = 'partial'; }
  while (bytes() > maxBytes && (value?.projects?.length || 0) > 1) { value!.projects!.pop(); value!.coverage = 'partial'; }
  while (bytes() > maxBytes && value?.video?.excerpts?.length) trimVideo();
  if (value?.video?.content === 'subtitles' && !value.video.excerpts?.length) value.video.content = 'unavailable';
  if (bytes() > maxBytes && value?.projects?.length) { delete value.projects; value.coverage = 'partial'; }
  if (bytes() > maxBytes && value) { delete value.video; value.coverage = 'partial'; }
  if (bytes() > maxBytes && socialValue?.post?.original) { delete socialValue.post.original; socialValue.post.partial = true; }
  if (bytes() > maxBytes && socialValue?.post) { socialValue.post.text = ''; socialValue.post.partial = true; }
  if (bytes() > maxBytes && socialValue) delete socialValue.post;
  if (bytes() > maxBytes && socialValue) delete socialValue.speaker.wearingMedal;
  return bytes() <= maxBytes ? messages(value) : messages();
}
