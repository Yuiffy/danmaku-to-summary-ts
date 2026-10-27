import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Model, ModelRequest, ModelResponse, Usage, protocol } from '@openai/agents-core';
import { questionProviderSettings } from '../live-vote/questions/DaiyuQuestionClient';
import { QQ_LIMITS, QQ_MODEL } from './QQPolicy';

type ChatMessage = { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string };
function chatMessages(request: ModelRequest): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: request.systemInstructions || '' }];
  if (typeof request.input === 'string') return [...messages, { role: 'user', content: request.input }];
  for (const item of request.input) {
    if (item.type === 'function_call') messages.push({ role: 'assistant', content: null,
      tool_calls: [{ id: item.callId, type: 'function', function: { name: item.name, arguments: item.arguments } }] });
    else if (item.type === 'function_call_result') messages.push({ role: 'tool', tool_call_id: item.callId,
      content: typeof item.output === 'string' ? item.output : !Array.isArray(item.output) && item.output.type === 'text' ? item.output.text :
        JSON.stringify(item.output) });
    else if ('role' in item) {
      const content = typeof item.content === 'string' ? item.content : item.content.map(part => {
        if (part.type !== 'input_text' && part.type !== 'output_text') throw new Error('Non-text QQ model input');
        return part.text;
      }).join('\n');
      messages.push({ role: item.role, content });
    } else throw new Error('Unsupported QQ model input');
  }
  return messages;
}

/** Agents SDK custom Model adapter for the existing fixed daiYu endpoint and injected transport. */
export function createQQAgentModel(settings: ReturnType<typeof questionProviderSettings>, signal: AbortSignal,
  transport = fetch, observe?: (delta: Pick<Usage, 'requests' | 'inputTokens' | 'outputTokens'>) => void): Model {
  const agent = settings.proxy ? new HttpsProxyAgent(settings.proxy) : undefined;
  let reserved = 0, turns = 0;
  return {
    async getResponse(request): Promise<ModelResponse> {
      signal.throwIfAborted();
      const messages = chatMessages(request);
      const tools = request.tools.map(definition => {
        if (definition.type !== 'function') throw new Error('Unsupported QQ tool');
        return { type: 'function', function: { name: definition.name, description: definition.description,
          parameters: definition.parameters, strict: true } };
      });
      const body = { model: QQ_MODEL, messages, max_tokens: 768,
        ...(tools.length ? { tools, tool_choice: turns >= QQ_LIMITS.agentTurns - 1 ? 'none' : 'auto', parallel_tool_calls: false } : {}),
        ...(request.outputType !== 'text' ? { response_format: { type: 'json_schema', json_schema: {
          name: request.outputType.name, schema: request.outputType.schema, strict: true } } } : {}) };
      // Reserve all turns before provider IO. Include schemas/framing and output, not only user text.
      let charge = Buffer.byteLength(JSON.stringify(body), 'utf8') + body.max_tokens + 256;
      // Leave enough room for a final answer after a maximum-size tool result. Stop querying gracefully.
      if (tools.length && reserved + charge * 2 + 6500 > QQ_LIMITS.reservation) {
        body.tool_choice = 'none';
        messages.push({ role: 'system', content: '剩余预算只够作答，请据已有工具资料完成最终JSON；资料不足就说明具体缺口，不能编造或继续调用工具。' });
        charge = Buffer.byteLength(JSON.stringify(body), 'utf8') + body.max_tokens + 256;
      }
      if (reserved + charge > QQ_LIMITS.reservation || ++turns > QQ_LIMITS.agentTurns) throw new Error('QQ agent budget exceeded');
      reserved += charge;
      observe?.({ requests: 1, inputTokens: charge - body.max_tokens, outputTokens: body.max_tokens });
      const response = await transport(settings.url, { method: 'POST', redirect: 'error', timeout: QQ_LIMITS.timeoutMs,
        size: 64 * 1024, signal: (request.signal || signal) as any, agent,
        headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error('QQ provider unavailable');
      const payload = await response.json() as any;
      signal.throwIfAborted();
      const choice = payload?.choices?.[0], message = choice?.message;
      if (!message || !['stop', 'tool_calls'].includes(choice.finish_reason) ||
          message.content != null && (typeof message.content !== 'string' || message.content.length > 4000)) throw new Error('Invalid QQ model output');
      const calls = message.tool_calls;
      const output: ModelResponse['output'] = [];
      if (calls !== undefined) {
        if (!Array.isArray(calls) || calls.length !== 1 || turns >= QQ_LIMITS.agentTurns || body.tool_choice === 'none') throw new Error('Invalid QQ tool calls');
        const call = calls[0];
        if (call.type !== 'function' || typeof call.id !== 'string' || !/^[\w-]{1,100}$/u.test(call.id) ||
            !tools.some(tool => tool.function.name === call.function?.name) ||
            typeof call.function.arguments !== 'string' || call.function.arguments.length > 2000) throw new Error('Unknown QQ tool');
        output.push({ type: 'function_call', callId: call.id, name: call.function.name, arguments: call.function.arguments });
      } else if (typeof message.content === 'string' && message.content.trim()) output.push({ type: 'message', role: 'assistant',
        status: 'completed', content: [{ type: 'output_text', text: message.content }] });
      else throw new Error('Empty QQ model output');
      const usage = payload.usage;
      const measured = new Usage({ requests: 1,
        inputTokens: Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 ? usage.prompt_tokens : charge - body.max_tokens,
        outputTokens: Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0 ? usage.completion_tokens : body.max_tokens });
      observe?.({ requests: 0, inputTokens: measured.inputTokens - (charge - body.max_tokens), outputTokens: measured.outputTokens - body.max_tokens });
      return { output, usage: measured };
    },
    async *getStreamedResponse(): AsyncIterable<protocol.StreamEvent> { throw new Error('QQ streaming is disabled'); }
  };
}
