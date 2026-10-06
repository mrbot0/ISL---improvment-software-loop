import { llm } from './config.js';

/**
 * OpenAI-compatible chat provider (ISL_IMPROVE §2 — strong-model support).
 *
 * Speaks the OpenAI `/chat/completions` streaming API, which almost every serious LLM
 * gateway implements: OpenAI, OpenRouter, Groq, Together, vLLM, LM Studio, and Ollama's
 * own `/v1` endpoint. This is how a strong cloud/local model plugs into the phases that
 * decide quality. It returns the SAME shape as the Ollama `chat()` so callers are
 * unchanged: `{ content, thinking, toolCalls, usage }`.
 *
 * Enabled only when ISL_LLM_PROVIDER != 'ollama'; otherwise the local path is used.
 */
export function providerActive() {
  return llm.provider !== 'ollama' && !!llm.baseUrl;
}

export async function openaiChat({ messages, tools, model, temperature = 0.3, onToken, signal }) {
  if (!llm.baseUrl) throw new Error('ISL_LLM_BASE_URL is not set for the configured LLM provider');

  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: normaliseMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
      temperature,
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    }),
    signal,
  });
  if (!res.ok) throw new Error(`LLM provider ${llm.provider} → ${res.status}: ${(await res.text()).slice(0, 400)}`);

  let content = '';
  const toolAcc = new Map(); // index -> { id, function:{name,arguments} }
  const usage = { promptTokens: 0, evalTokens: 0 };
  let buffer = '';
  const decoder = new TextDecoder();

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      if (evt.usage) {
        usage.promptTokens = evt.usage.prompt_tokens || usage.promptTokens;
        usage.evalTokens = evt.usage.completion_tokens || usage.evalTokens;
      }
      const delta = evt.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        onToken?.(delta.content, 'content');
      }
      // Tool-call deltas arrive by index and accumulate their arguments string.
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? 0;
        const acc = toolAcc.get(i) || { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function.name = tc.function.name;
        if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
        toolAcc.set(i, acc);
      }
    }
  }

  const toolCalls = [...toolAcc.values()].filter((t) => t.function.name);
  return { content, thinking: '', toolCalls, usage };
}

// OpenAI expects `tool` messages to carry `tool_call_id`; our internal format uses
// `tool_name`. Bridge the difference and drop fields the API rejects.
function normaliseMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id || m.tool_name || 'call' };
    const out = { role: m.role, content: m.content ?? '' };
    if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
    return out;
  });
}
