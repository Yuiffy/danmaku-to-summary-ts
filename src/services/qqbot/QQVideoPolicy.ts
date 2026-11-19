import type { QQImageCharacter } from './QQImagePolicy';
import { qqMatchedImageCharacters, qqResolveImageCharacter } from './QQImagePolicy';
import { qqVideoCutRequested, qqVideoSelection } from './QQVideoCutPolicy';

export const QQ_VIDEO_MODELS = ['seedance2.0fast_vip', 'seedance2.0mini'] as const;
export const QQ_VIDEO_RATIOS = ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9'] as const;
export interface QQVideoVoice { name: string; aliases: string[]; audio: string }
export interface QQVideoConfig { enabled: boolean; queuePath: string; voices: QQVideoVoice[] }
export interface QQVideoCommand { instruction: string; characters: string[]; voices: string[]; model: string | null; ratio: string | null; duration: number | null }
export interface QQVideoResult { file: string; taskId?: string }
export const QQ_VIDEO_CREDIT_REPLY = '没积分了，暂时不能生视频，等补充积分后再来吧。';
export const QQ_VIDEO_AUTH_REPLY = '视频账号暂时无法验证，请管理员检查即梦登录状态后再试。';
export const QQ_VIDEO_HELP = '艾特我说“生成小花帽岁己散步的视频”，可附图片或引用MP4参考。参考视频总长最多15.4秒，单段长视频默认取前15秒，也可说“截取5到12秒作为参考，再生成……的视频”。只想剪辑时，说“保留00:02-00:06和00:18-00:24，拼起来发我”。生成默认 Fast VIP、720P、9:16、15秒，可写“mini、横屏16:9、10秒”（4—15秒）。回复“确认生成视频”提交草稿。“领取视频”查进度或收片。';

export const qqVideoMentioned = (text: string) => /视频|生视频|seedance/iu.test(text);
export const qqVideoCollectRequested = (text: string) => /(?:领取|收取|取|收|查看|查询|看看).{0,8}视频|视频.{0,8}(?:好了吗|进度|结果|生成好|做好)/u.test(text);
export const qqVideoEditRequested = (text: string) => /^(?:修改|调整|更改)视频/u.test(text.trim());
export const qqVideoConfirmRequested = (text: string) => /^(?:确认生成视频|确认视频生成|直接生成视频)[。！!]?$/u.test(text.trim());
export const qqVideoDirectRequested = (text: string) => /直接(?:生成|制作|做|生)/u.test(text) && qqVideoRequested(text);
const cutAndGenerate = /生成|生视频|仿拍|重拍|重制|seedance|(?:再|然后|用于|拿来|用来)\s*(?:直接)?(?:制作|做|生)/iu;
export const qqVideoStandaloneEdit = (text: string, hasVideo = false) =>
  qqVideoCutRequested(text, hasVideo) && (!cutAndGenerate.test(text) || /(?:不要|不用|别|无需)\s*(?:生成|生视频)/u.test(text));
/** Usage questions, quoted examples and negation cannot authorize queue writes. */
export function qqVideoRequested(text: string): boolean {
  const value = text.normalize('NFKC');
  if (qqVideoConfirmRequested(value) || qqVideoStandaloneEdit(value)) return false;
  if (!qqVideoMentioned(value) || /(?:不要|不用|别|不)\s*(?:生成|制作|生视频|做视频)/u.test(value)) return false;
  if (qqVideoEditRequested(value)) return true;
  if (/怎么|如何|用法|教程|举例|例如|比如|示例|能.{0,5}吗|可以.{0,5}吗/u.test(value)) return false;
  return /(?:生成|制作|做|生|来).{0,100}视频|视频.{0,12}(?:生成|制作)|seedance.{0,30}(?:生成|制作)/iu.test(value);
}
export function validateQQVideoConfig(config: QQVideoConfig): void {
  if (!config || typeof config.enabled !== 'boolean' || typeof config.queuePath !== 'string' || !config.queuePath.trim() ||
    !Array.isArray(config.voices) || config.voices.length > 100 || config.voices.some(voice =>
      !voice || typeof voice.name !== 'string' || !voice.name.trim() || voice.name.length > 80 ||
      typeof voice.audio !== 'string' || !voice.audio.trim() || !Array.isArray(voice.aliases) || !voice.aliases.length ||
      voice.aliases.length > 30 || voice.aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > 80))) throw new Error('Invalid QQ video configuration');
}

export function qqVideoPlan(text: string, command: QQVideoCommand, characters: QQImageCharacter[], hasVideo = false) {
  if (!qqVideoRequested(text)) throw new Error('请明确说明要生成的视频内容；询问用法不会提交任务。');
  if (!command || typeof command.instruction !== 'string' || !command.instruction.trim() || command.instruction.length > 1500 ||
    !Array.isArray(command.characters) || command.characters.length > 8 || !Array.isArray(command.voices) || command.voices.length > 3) throw new Error('视频参数无效，请重新说明要求。');
  const settings = hasVideo || qqVideoCutRequested(text) ? qqVideoSelection(text).generationText : text;
  const namedModel = /seedance[\w.]+/iu.exec(settings)?.[0].toLowerCase();
  const model = namedModel?.replace('fastvip', 'fast_vip') || (/mini/iu.test(text) ? 'seedance2.0mini' : command.model?.replace('fastvip', 'fast_vip')) || 'seedance2.0fast_vip';
  if (!(QQ_VIDEO_MODELS as readonly string[]).includes(model)) throw new Error('视频只开放 seedance2.0fastvip 和 seedance2.0mini。');
  if (/(?:1080\s*p|4\s*k|480\s*p)/iu.test(text)) throw new Error('视频分辨率固定720P，请按720P提交。');
  const explicitDuration = /(\d+(?:\.\d+)?)\s*(?:秒|s\b)/iu.exec(settings);
  const duration = explicitDuration ? Number(explicitDuration[1]) : command.duration ?? 15;
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error('视频时长支持4—15秒，请调整时长。');
  const explicitRatio = /(\d+)\s*[:：]\s*(\d+)/u.exec(settings);
  const ratio = explicitRatio ? `${explicitRatio[1]}:${explicitRatio[2]}` : /横屏/u.test(text) ? '16:9' : /竖屏/u.test(text) ? '9:16' : command.ratio || '9:16';
  if (!(QQ_VIDEO_RATIOS as readonly string[]).includes(ratio)) throw new Error('视频比例支持9:16、16:9、1:1、3:4、4:3、21:9。');
  // Reuse image identity/outfit matching, including references explicitly named but omitted by the model.
  const matched = qqMatchedImageCharacters({ text }, { characters });
  const explicitSkins = new Set(matched.flatMap(character => character.baseCharacter ? [character.baseCharacter] : []));
  const selected = command.characters.map(name => qqResolveImageCharacter(name, characters))
    .filter(character => !character.baseCharacter || !explicitSkins.has(character.baseCharacter) || matched.includes(character));
  const references = [...new Set([...matched, ...selected])];
  const replaced = new Set(references.flatMap(character => character.baseCharacter ? [character.baseCharacter] : []));
  return { model, duration, ratio, references: references.filter(character => !replaced.has(character.name)) };
}
