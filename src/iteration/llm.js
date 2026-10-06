import { chat } from '../ollama.js';
import { ollama } from '../config.js';

/** Pull the first balanced JSON object/array out of a model response. */
function extractJson(text) {
  if (!text) return null;
  // Prefer fenced blocks.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * One-shot LLM call that returns parsed JSON (or null). Non-streaming intent —
 * used by planner / researcher / graders where we want the whole structured answer.
 * Returns { data, usage } so the engine can bill tokens.
 */
export async function llmJson({ system, user, model = ollama.model, temperature = 0.4, think = false, signal }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const { content, usage } = await chat({ messages, model, think, temperature, signal });
  return { data: extractJson(content), raw: content, usage };
}

/** Free-text one-shot (e.g. a grader that returns a number we regex out). */
export async function llmText({ system, user, model = ollama.model, temperature = 0.3, think = false, signal }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const { content, usage } = await chat({ messages, model, think, temperature, signal });
  return { text: content, usage };
}

export { extractJson };
