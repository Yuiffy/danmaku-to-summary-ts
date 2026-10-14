import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ConfigObject } from '../../core/config/ConfigLayers';
import { FeedbackCompletion } from './AdminFeedbackAgent';

/** Operator agent uses the configured tool-capable provider; endpoints never enter model context. */
export function createFeedbackCompletion(config: ConfigObject, transport = fetch): FeedbackCompletion {
  const ai = config.ai as any, text = ai?.text?.daiYu || {}, provider = ai?.providers?.daiYu || {};
  const key = text.apiKey || provider.apiKey, base = text.baseUrl || provider.baseURL || provider.baseUrl || 'http://localhost:8080';
  if (text.enabled === false || provider.enabled === false || typeof key !== 'string' || !key.trim()) throw new Error('编辑 agent 的 daiYu 提供方未配置');
  const endpoint = new URL(base);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new Error('编辑 agent 提供方地址无效');
  const responses = text.apiMode === 'responses';
  endpoint.pathname = endpoint.pathname.replace(/\/$/u, '').replace(/\/(?:v1\/)?(?:responses|chat\/completions)$/u, '')
    .replace(/\/v1$/u, '') + (responses ? '/v1/responses' : '/v1/chat/completions');
  const proxy = text.proxy ?? provider.proxy, agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  return async (messages, tools) => {
    try {
      const input = responses ? messages.flatMap(message => message.role === 'tool'
        ? [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content || '' }]
        : message.tool_calls ? message.tool_calls.map(call => ({ type: 'function_call', call_id: call.id,
          name: call.function.name, arguments: call.function.arguments }))
          : [{ role: message.role, content: message.content || '' }] as any[]) : undefined;
      const body = responses ? { model: text.model || 'gpt-6-luna', input, store: false,
        tools: tools.map(tool => ({ type: 'function', ...tool.function, strict: false })),
        tool_choice: 'required', parallel_tool_calls: false, max_output_tokens: 7000 }
        : { model: text.model || 'gpt-6-luna', messages, tools, tool_choice: 'required', parallel_tool_calls: false, max_tokens: 7000 };
      const response = await transport(endpoint.toString(), { method: 'POST', redirect: 'error', timeout: 120000,
        size: 256 * 1024, agent, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
      if (!response.ok) throw new Error('Provider rejected the request');
      const data = await response.json() as any;
      if (responses) {
        if (data.status !== 'completed' || !Array.isArray(data.output)) throw new Error('Incomplete provider response');
        return { content: null, tool_calls: data.output.filter((item: any) => item.type === 'function_call').map((item: any) => ({
          id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } })) };
      }
      const message = data?.choices?.[0]?.message;
      if (!message || !Array.isArray(message.tool_calls)) throw new Error('Provider did not return tool calls');
      return { content: null, tool_calls: message.tool_calls };
    } catch { throw new Error('编辑 agent 请求失败，意见已保存；请查看提供方运行状态'); }
  };
}
