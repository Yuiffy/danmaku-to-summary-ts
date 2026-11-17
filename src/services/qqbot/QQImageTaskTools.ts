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
  read(): Promise<QQImageTaskStatus>;
  collect(): Promise<QQImageTaskStatus>;
}

/** Semantic tool choice stays with the agent; the worker binds identity, files and delivery intent. */
export function createQQImageTaskTools(actions: QQImageTaskActions): QQImageToolSession {
  const parameters = { type: 'object' as const, properties: {}, required: [] as string[], additionalProperties: false as const };
  return {
    instructions: '可以查询和领取本人本群最新图片任务，由当前用户意图决定是否调用，不需要固定口令。' +
      '询问刚才图片的进度、是否完成或失败原因用read_image_job；索取已有生成结果、催图、说“图来”或表示刚才没收到图用collect_image。' +
      '领取已有结果不等于修改原图，不要为此read_recent_images、select_recent_image或generate_image，也不继承旧聊天里的绘图要求。' +
      '普通新问题直接回答，不因有旧图片任务而查询或领取。任务失败要如实说明工具message，不能称还在生成。' +
      'collect_image由服务端按真实状态交付图片或说明原因，不再次生成、不扣图片额度；每条消息最多领取一次，已有发送记录最多人工补发一次。工具不接受用户、群或任务ID，不能领取别人的图。',
    tools: [
      { name: 'read_image_job', description: '只读查询当前用户在当前群最新图片任务的真实状态、进度或失败原因；不领取、不修改发送状态、不生成图片。',
        parameters, execute: () => actions.read() },
      { name: 'collect_image', description: '领取当前用户在当前群最新图片任务的已有结果；完成则由服务端发送图片，未完成或失败则返回真实状态。表示没收到时最多补发一次，不重新生成、不读取原图。',
        parameters, execute: () => actions.collect() }
    ]
  };
}
