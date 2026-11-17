import type { QQRequest } from './QQPolicy';
import type { QQImageToolSession } from './QQImageTools';
import { QQVideoCommand, QQVideoConfig, QQ_VIDEO_HELP, qqVideoCollectRequested, qqVideoMentioned, qqVideoRequested } from './QQVideoPolicy';
import { QQVideoDelivery, QQVideoQueue } from './QQVideoQueue';

/** Luna organizes prompt, catalogue names and natural-language options; queue paths remain server-owned. */
export function createQQVideoTools(request: QQRequest, config: QQVideoConfig, queue: Pick<QQVideoQueue, 'enqueue' | 'collect' | 'confirm' | 'readDraft' | 'approve'>,
  signal: AbortSignal, observe: (delivery: QQVideoDelivery) => void): QQImageToolSession {
  let accepted = false;
  const result = (delivery: QQVideoDelivery) => {
    if (!accepted) observe(delivery);
    if (['draft', 'pending', 'generated'].includes(delivery.status)) accepted = true;
    return { status: delivery.status, message: delivery.message };
  };
  let attempted = false;
  const sourceCount = request.videoInput?.urls.length || 0;
  const sourceAvailable = !!sourceCount && !request.videoInput?.invalid;
  const sourceMessage = request.videoInput ? (sourceAvailable
    ? `本条消息已携带或引用${sourceCount}段视频，已绑定为本题视频参考。无需用户重发，按创作要求调用generate_video；提交时由服务端下载、探测和校验，不以read_image_sources判断视频是否存在。`
    : '本条视频引用无效或超过限制；请重新直接附上最多3段合规视频，本次不能忽略原片生成。')
    : '本条没有附带或引用视频；可使用文生视频或已收录角色参考。用户要求照原片制作时，需请用户附带或引用原视频。';
  return { instructions: `支持生视频，使用现有即梦视频队列。${QQ_VIDEO_HELP}` +
    sourceMessage +
    '生视频与GIF生图是独立功能，明确生视频时禁止调用generate_image。由你整理本条用户创意、主体、动作、镜头、台词及配置，再调用generate_video；不要继承其他群友的生成要求。' +
    '先用find_image_characters查询文本提到的素材，characters使用返回的完整名字；这些自备角色素材可直接用于视频，无需用户附图。小花帽岁己、JK岁己、地雷岁己均为岁己的具体衣装。仅在用户附图时可读read_image_sources核实当前多张附图，全部当前附图会传到队列。' +
    '指定某人的声线时先find_video_voices选择收录的音频；没有素材必须说明，不能声称已使用。仅在用户明确要求声音参考时选声线。' +
    'model仅seedance2.0fast_vip或seedance2.0mini；用户没指定时model、ratio、duration传null，默认Fast VIP、9:16、15秒，固定720P。' +
    '询问怎么生视频、怎么设时长或模型、举例、否定生成时只介绍用法，不能入队。领取视频或问进度用collect_video；它只读取该用户在当前群的任务，不会再次生成。' +
    '默认generate_video只保存待确认草稿并返回素材名称、完整prompt和设置，不运行生成。修改视频前先read_video_draft读取本人本群草稿，保留未修改要求，重新整理完整instruction再generate_video。用户说“确认生成视频”或单独“直接生成视频”时只用approve_video，不能新建视频；含创作内容的“直接生成”请求才可generate_video直接入队。' +
    '当前附带或引用的视频会作为视频参考完整传入队列，用于按要求参考原片动作、镜头或情节；不能把视频当成图片或让用户改发图片。视频内容不会被图片工具读取，不臆测未观看的原片细节。参考视频最多3段、每段50MB、单段2—15.4秒且总时长不超过15.4秒；超限会明确提示，不自动裁剪。' +
    '视频积分由服务端按当前报价自动处理并按用户统计，无需询问用户积分确认。confirm_video只兼容旧确认消息，不主动要求用户发送。pending仅表示排队，不表示完成；草稿message由服务端完整发送，你最终简短告知检查草稿即可，不能省略或改写真实prompt。不臆测积分、不暴露路径或身份标识。每条消息最多一次生成入队尝试。', tools: [
    { name: 'read_video_sources', description: '确认当前消息附带或引用的视频素材数量和绑定状态。只读取服务端元信息，不下载、不付费、不观看画面；正式提交时校验格式、时长与大小。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: async () => ({ available: sourceAvailable, sourceCount, invalid: !!request.videoInput?.invalid, verified: false, message: sourceMessage }) },
    { name: 'read_video_draft', description: '读取当前用户在当前群待确认的视频草稿，修改前先读取；返回完整prompt、素材名称和设置，无文件路径。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: async () => queue.readDraft(request, signal) },
    { name: 'approve_video', description: '当前用户明确回复“确认生成视频”或“直接生成视频”时，将本人本群已展示的最新草稿提交生成队列；复用同一条任务。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: async () => {
        try { return result(await queue.approve(request, signal)); }
        catch { signal.throwIfAborted(); return result({ status: 'failed', message: '暂时无法确认草稿，请查询视频进度；不会重复生成。' }); }
      } },
    { name: 'find_video_voices', description: '查询可用的人物声线素材。只返回名字和别名，不接受用户提供的本地文件路径。',
      parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 80 } }, required: ['query'], additionalProperties: false },
      execute: async args => {
        const query = String((args as { query: string }).query).trim().toLowerCase();
        return { voices: config.voices.filter(voice => !query || [voice.name, ...voice.aliases].some(name =>
          name.toLowerCase().includes(query) || query.includes(name.toLowerCase()))).slice(0, 12).map(({ name, aliases }) => ({ name, aliases })) };
      } },
    { name: 'generate_video', description: '将明确授权的单条视频请求提交现有队列；同时使用当前全部附图及指定角色参考。整理创意、台词和动作，声线使用已收录素材名。默认720P、9:16、15秒、Fast VIP。',
      parameters: { type: 'object', additionalProperties: false, properties: {
        instruction: { type: 'string', minLength: 1, maxLength: 1500 }, characters: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 80 } },
        voices: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 80 } },
        model: { type: ['string', 'null'], enum: ['seedance2.0fast_vip', 'seedance2.0mini', null] },
        ratio: { type: ['string', 'null'], enum: ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9', null] },
        duration: { type: ['integer', 'null'], minimum: 4, maximum: 15 }
      }, required: ['instruction', 'characters', 'voices', 'model', 'ratio', 'duration'] },
      execute: async args => {
        if (!qqVideoRequested(request.text)) return result({ status: 'blocked', message: QQ_VIDEO_HELP });
        if (attempted) return result({ status: 'blocked', message: '本题已经尝试提交视频，不能重复入队。' });
        attempted = true;
        try { return result(await queue.enqueue(request, args as QQVideoCommand, signal)); }
        catch { signal.throwIfAborted(); return result({ status: 'failed', message: '视频队列暂时不可用，请稍后在本群艾特我查询视频进度；不会重复提交。' }); }
      } },
    { name: 'confirm_video', description: '仅当当前用户已按视频报价明确说“确认视频数字积分”时，批准该用户在本群最近任务的积分上限；复用原任务，不新增视频。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: async () => {
        try { return result(await queue.confirm(request, signal)); }
        catch { signal.throwIfAborted(); return result({ status: 'failed', message: '本次积分确认未生效，请先查询视频进度并核对报价。' }); }
      } },
    { name: 'collect_video', description: '查询当前用户在当前群最近的视频任务，完成后领取真实视频；不会提交生成或查询其他人的任务。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: async () => {
        if (!qqVideoCollectRequested(request.text)) return result({ status: 'blocked', message: '请明确说“领取视频”或“查询视频进度”。' });
        try { return result(await queue.collect(request, signal)); }
        catch { signal.throwIfAborted(); return result({ status: 'failed', message: '暂时没能读取视频结果，请稍后再查。' }); }
      } }
  ] };
}

/** Shared image discovery/previews, with only the requested paid media action exposed. */
export function mergeQQMediaTools(request: QQRequest, images: QQImageToolSession | undefined, videos: QQImageToolSession | undefined): QQImageToolSession | undefined {
  if (!videos) return images;
  return { previews: images?.previews, prepare: images?.prepare,
    instructions: (images?.instructions || '') + videos.instructions,
    tools: [...(images?.tools || []).filter(tool => tool.name !== 'generate_image' || !qqVideoMentioned(request.text)), ...videos.tools] };
}
