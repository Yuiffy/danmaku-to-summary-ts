import type { QQImageToolSession } from './QQImageTools';

export interface QQImageTaskStatus {
  status: 'none' | 'queued' | 'running' | 'ready' | 'failed' | 'unknown' | 'delivering' | 'delivered' | 'collected' | 'reported';
  message: string;
}

export function withQQImageTaskTools(session: QQImageToolSession | undefined, actions?: QQImageTaskActions): QQImageToolSession | undefined {
  if (!actions) return session;
  const tasks = createQQImageTaskTools(actions);
  return { ...session, instructions: (session?.instructions || '') + tasks.instructions, tools: [...session?.tools || [], ...tasks.tools] };
}
export interface QQImageTaskActions {
  read(position?: number): Promise<QQImageTaskStatus>;
  collect(position?: number): Promise<QQImageTaskStatus>;
}

/** Semantic tool choice stays with the agent; the worker binds identity, files and delivery intent. */
export function createQQImageTaskTools(actions: QQImageTaskActions): QQImageToolSession {
  const parameters = (defaultDescription: string) => ({ type: 'object' as const, properties: {
    position: { type: ['integer', 'null'], minimum: 1,
      description: `null 表示${defaultDescription}。指定位置时按任务创建时间倒序，1 是最新一张，2 是再上一张，所有任务状态都计入顺序。` }
  }, required: ['position'], additionalProperties: false as const });
  const select = (action: QQImageTaskActions['read'], args: unknown): Promise<QQImageTaskStatus> => {
    const position = typeof args === 'object' && args && 'position' in args ? args.position : undefined;
    if (position === null) return action();
    if (typeof position === 'number' && Number.isSafeInteger(position) && position > 0) return action(position);
    return Promise.resolve({ status: 'none', message: '请传 null 使用默认方式，或指定有效的倒数位置。' });
  };
  return {
    instructions: '可以查询和领取本人本群的图片任务，由当前用户意图决定是否调用，不需要固定口令。' +
      '普通索图、催图或要求领取没发过的图时，collect_image传position:null，服务端按提交顺序交付所有当前窗口能发的待领成图。' +
      '明确指定“刚才那张”或要求补发最新一张用1，“再上一张”或“倒数第二张”用2。问还有哪些在生成、排队或没指定哪张的进度时，read_image_job传null列出全部进行中任务。' +
      '询问刚才图片的进度、是否完成或失败原因用read_image_job；索取已有生成结果、催图、说“图来”或表示刚才没收到图用collect_image。' +
      '领取已有结果不等于修改原图，不要为此read_recent_images、select_recent_image或generate_image，也不继承旧聊天里的绘图要求。' +
      '普通新问题直接回答，不因有旧图片任务而查询或领取。任务失败要如实说明工具message，不能称还在生成。' +
      'collect_image由服务端按真实状态交付图片或说明原因，不再次生成、不扣图片额度；每条消息最多领取一次，已有发送记录最多人工补发一次。工具不接受用户、群或任务ID，不能领取别人的图。',
    tools: [
      { name: 'read_image_job', description: '查询本人本群的生图进度。默认列出全部生成中和排队中的任务，也可查询指定任务。',
        parameters: parameters('查询全部进行中任务'), execute: args => select(actions.read, args) },
      { name: 'collect_image', description: '领取本人本群待发成图，默认批量领取，也可指定一张。明确补发时每个任务最多补发一次。',
        parameters: parameters('批量领取未发送的图'), execute: args => select(actions.collect, args) }
    ]
  };
}
