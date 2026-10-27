import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ConfigObject } from '../../core/config/ConfigLayers';
import { resolveRetryPolicy, retryDelay, retryReason } from '../../workflows/text/retry';
import { FeedbackCompletion, FeedbackMessage, FEEDBACK_TOOLS } from './AdminFeedbackAgent';

interface CompletionRuntime { now: () => number; sleep: (ms: number) => Promise<void> }
const runtime: CompletionRuntime = { now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
const budgetMs = 120000;

function providerConfig(ai: any, name: 'daiYu' | 'tuZi', overrides: Record<string, unknown> = {}) {
  const text = { ...ai?.text?.[name], ...overrides }, provider = ai?.providers?.[name] || {};
  const key = text.apiKey || provider.apiKey;
  if (text.enabled === false || provider.enabled === false || typeof key !== 'string' || !key.trim()) throw new Error(`编辑 agent 的 ${name} 提供方未配置`);
  let endpoint: URL;
  try { endpoint = new URL(text.baseUrl || provider.baseURL || provider.baseUrl || (name === 'daiYu' ? 'http://localhost:8080' : 'https://api.tu-zi.com')); }
  catch { throw new Error(`编辑 agent 的 ${name} 提供方地址无效`); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new Error(`编辑 agent 的 ${name} 提供方地址无效`);
  const responses = text.apiMode === 'responses';
  endpoint.pathname = endpoint.pathname.replace(/\/$/u, '').replace(/\/(?:v1\/)?(?:responses|chat\/completions)$/u, '')
    .replace(/\/v1$/u, '') + (responses ? '/v1/responses' : '/v1/chat/completions');
  const proxy = text.proxy ?? provider.proxy;
  let agent: HttpsProxyAgent<string> | undefined;
  try { agent = proxy ? new HttpsProxyAgent(proxy) : undefined; }
  catch { throw new Error(`编辑 agent 的 ${name} 代理配置无效`); }
  return { name, key, endpoint: endpoint.toString(), responses, agent, model: text.model || 'gpt-6-luna' };
}

function requestBody(provider: ReturnType<typeof providerConfig>, messages: FeedbackMessage[], tools: typeof FEEDBACK_TOOLS) {
  if (!provider.responses) return { model: provider.model, messages, tools, tool_choice: 'required', parallel_tool_calls: false, max_tokens: 7000 };
  const input = messages.flatMap(message => message.role === 'tool'
    ? [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content || '' }]
    : message.tool_calls ? message.tool_calls.map(call => ({ type: 'function_call', call_id: call.id,
      name: call.function.name, arguments: call.function.arguments }))
      : [{ role: message.role, content: message.content || '' }] as any[]);
  return { model: provider.model, input, store: false,
    tools: tools.map(tool => ({ type: 'function', ...tool.function, strict: false })),
    tool_choice: 'required', parallel_tool_calls: false, max_output_tokens: 7000 };
}

function toolResult(data: any, responses: boolean) {
  if (responses && (data?.status !== 'completed' || !Array.isArray(data.output))) throw new Error('invalid response');
  const calls = responses ? data.output.filter((item: any) => item.type === 'function_call').map((item: any) => ({
    id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments }
  })) : data?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls) || !calls.length || calls.some(call => typeof call?.id !== 'string' || !call.id
    || call.type !== 'function' || typeof call.function?.name !== 'string' || !call.function.name
    || typeof call.function.arguments !== 'string')) throw new Error('invalid tool calls');
  return { content: null, tool_calls: calls };
}

/** Retry only model requests; never restart an agent session or replay an executed CLI tool. */
export function createFeedbackCompletion(config: ConfigObject, transport = fetch, timing: CompletionRuntime = runtime): FeedbackCompletion {
  const ai = config.ai as any, text = ai?.text?.daiYu || {}, primary = providerConfig(ai, 'daiYu');
  const policy = resolveRetryPolicy({ maxAttempts: 2 }, ai?.text?.retry);
  return async (messages, tools) => {
    const deadline = timing.now() + budgetMs, controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const failures: string[] = [];
    const fail = () => new Error(`编辑 agent 请求失败：${failures.join('；')}。意见已保存；请核对提供方运行状态后重试`);
    try {
      for (const name of ['daiYu', ...(text.fallbackProvider === 'tuZi' ? ['tuZi'] : [])] as Array<'daiYu' | 'tuZi'>) {
        let provider: ReturnType<typeof providerConfig>;
        try { provider = name === 'daiYu' ? primary : providerConfig(ai, name, {
          ...(text.fallbackProviderModel ? { model: text.fallbackProviderModel } : {}),
          ...(text.fallbackProviderApiMode ? { apiMode: text.fallbackProviderApiMode } : {})
        }); }
        catch { failures.push(`${name} 配置无效`); throw fail(); }
        const body = JSON.stringify(requestBody(provider, messages, tools));
        for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
          const remaining = deadline - timing.now();
          if (remaining <= 0 || controller.signal.aborted) { failures.push('请求总时限已到'); throw fail(); }
          let stage = 'request', retryAfter: string | null = null;
          try {
            const response = await transport(provider.endpoint, { method: 'POST', redirect: 'error', timeout: remaining,
              signal: controller.signal as unknown as fetch.RequestInit['signal'], size: 256 * 1024, agent: provider.agent,
              headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json' }, body });
            if (!response.ok) {
              retryAfter = response.headers?.get('retry-after') || null;
              (response.body as any)?.destroy?.();
              throw Object.assign(new Error('HTTP error'), { status: response.status });
            }
            stage = 'response';
            return toolResult(await response.json(), provider.responses);
          } catch (error: any) {
            const status = Number(error?.status), reason = stage === 'request' && ![400, 401, 403].includes(status) ? retryReason(error, policy) : null;
            const detail = controller.signal.aborted || error?.name === 'AbortError' || error?.type === 'request-timeout' ? '请求超时'
              : stage === 'response' ? '响应格式无效' : Number.isInteger(status) && status >= 400 && status <= 599 ? `HTTP ${status}`
                : reason ? '连接建立失败' : '连接结果不明';
            failures.push(`${name} ${detail}（第 ${attempt} 次）`);
            if (!reason) throw fail();
            if (attempt === policy.maxAttempts) break;
            const delay = retryDelay(policy, attempt, retryAfter, timing.now());
            if (delay >= deadline - timing.now()) { failures.push('重试等待超过请求总时限'); throw fail(); }
            await timing.sleep(delay);
          }
        }
      }
      throw fail();
    } finally { clearTimeout(timer); }
  };
}
