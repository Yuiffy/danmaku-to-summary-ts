import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ConfigObject, loadConfigLayers } from '../../../core/config/ConfigLayers';
import { AgentComplete, AgentMessage, QUESTION_TOOLS, runQuestionAgent } from './QuestionAgent';
import { LiveQuestionConfig, NO_EVIDENCE, QuestionAnswerer, validateQuestionConfig } from './QuestionPolicy';
import { QuestionCorpus } from './QuestionCorpus';
import { createRemoteEmbedder } from './EmbeddingClient';
import { createLocalEmbedder } from './LocalEmbedding';
import { getProjectRoot } from '../../../core/config/ProjectPaths';

interface DaiyuSettings { apiKey: string; url: string; proxy?: string }
function object(value: unknown): ConfigObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ConfigObject : {};
}

export function questionProviderSettings(config: ConfigObject): DaiyuSettings {
  const ai = object(config.ai);
  const text = object(object(ai.text).daiYu);
  const provider = object(object(ai.providers).daiYu);
  const key = text.apiKey || provider.apiKey;
  const base = text.baseUrl || provider.baseURL || provider.baseUrl || 'http://localhost:8080';
  const proxy = text.proxy ?? provider.proxy;
  if (text.enabled === false || provider.enabled === false || typeof key !== 'string' || !key.trim() ||
      typeof base !== 'string' || proxy !== undefined && typeof proxy !== 'string') {
    throw new Error('Configure daiYu question provider credentials in the explicit provider config');
  }
  let url: URL;
  try { url = new URL(base); } catch { throw new Error('Invalid daiYu question provider endpoint'); }
  if (url.username || url.password || url.search || url.hash ||
      url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('daiYu questions require HTTPS or a loopback HTTP endpoint');
  }
  url.pathname = url.pathname.replace(/\/$/u, '').replace(/\/v1$/u, '') + '/v1/chat/completions';
  return { apiKey: key, url: url.toString(), proxy: proxy as string | undefined };
}

/** Fixed provider/model; neither endpoint nor credentials are ever placed in model context. */
export function createDaiyuQuestionCompletion(settings: DaiyuSettings, transport = fetch): AgentComplete {
  const agent = settings.proxy ? new HttpsProxyAgent(settings.proxy) : undefined;
  return async (request, signal) => {
    if (signal.aborted) throw new Error('Question cancelled');
    try {
      const response = await transport(settings.url, {
        method: 'POST', redirect: 'error', signal: signal as any, timeout: 45000, size: 128 * 1024, agent,
        headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-6-luna', messages: request.messages,
          tools: request.phase === 'plan' ? [QUESTION_TOOLS[0]] : QUESTION_TOOLS,
          tool_choice: request.toolChoice, parallel_tool_calls: false, max_tokens: 2048
        })
      });
      if (!response.ok) throw new Error('Provider request failed');
      const data = await response.json() as { choices?: Array<{ message?: AgentMessage }> };
      const message = data?.choices?.[0]?.message;
      const toolOnly = message?.content === undefined && Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
      if (!message || !toolOnly && message.content !== null && typeof message.content !== 'string' ||
          message.content && message.content.length > 12000 ||
          message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new Error('Invalid provider response');
      // Rebuild the assistant turn; provider-supplied roles and unrelated fields cannot enter the conversation.
      return { content: message.content ?? null, tool_calls: message.tool_calls };
    } catch { throw new Error('daiYu question request failed'); }
  };
}

export function createLiveQuestionAnswerer(config?: LiveQuestionConfig, botUid?: string): QuestionAnswerer | undefined {
  if (!config) return undefined;
  validateQuestionConfig(config);
  if (!config.enabled) return undefined;
  let settings: DaiyuSettings;
  try { settings = questionProviderSettings(loadConfigLayers({ configPath: config.providerConfigPath })); }
  catch { throw new Error('Unable to load daiYu question provider configuration'); }
  const complete = createDaiyuQuestionCompletion(settings);
  return async (request, signal) => {
    const started = Date.now();
    let modelMs = 0, toolMs = 0, modelTurns = 0;
    let status = 'answered';
    const semantic = config.semantic?.enabled ? config.semantic : undefined;
    const evidence = new QuestionCorpus(config, request, signal, botUid, semantic ? () => semantic.backend === 'local' ?
      createLocalEmbedder(semantic, getProjectRoot()) : createRemoteEmbedder(semantic, settings) : undefined);
    try {
      const result = await runQuestionAgent(request, signal, evidence, complete, step => {
        if (step.phase === 'model') { modelMs += step.elapsedMs; modelTurns++; }
        else toolMs += step.elapsedMs;
        console.info('[question step]', JSON.stringify({ roomId: request.roomId, askedAt: request.askedAt, ...step }));
      });
      status = result.answer === NO_EVIDENCE ? 'no-evidence' : 'answered';
      return result;
    } catch (error) {
      status = signal.aborted ? 'cancelled' : 'failed';
      throw error;
    } finally {
      await evidence.close();
      try {
        console.info('[question query]', JSON.stringify({ roomId: request.roomId, askedAt: request.askedAt,
          searchedRooms: evidence.rooms.map(room => room.roomId), status, elapsedMs: Math.max(0, Date.now() - started), modelMs, toolMs, modelTurns }));
      } catch { /* Diagnostics must not turn an answer into a failed query. */ }
    }
  };
}
