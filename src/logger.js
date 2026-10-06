import { writeLog } from './db.js';
import { bus } from './bus.js';

/**
 * Structured logger. Every line is persisted (the "logs" tab) and streamed to
 * the dashboard over the socket as a `log` event. Distinct from bus semantic
 * events: this is the operational, level-filterable trace.
 */
function emit(level, source, message, meta = {}) {
  let id;
  try {
    id = writeLog({ level, source, message, agentId: meta.agentId ?? null, runId: meta.runId ?? null, data: meta.data ?? null });
  } catch {
    /* logging must never throw */
  }
  const line = { type: 'log', id, ts: Date.now(), level, source, message: String(message), ...meta };
  bus.emit('event', line);
  // Funnel error logs to a dedicated channel the Reliability Manager listens on,
  // so it can capture every failure without subscribing to the whole event fire-hose.
  if (level === 'error') {
    bus.emit('log.error', line);
    // Mirror to the process console so a headless deploy still surfaces them.
    console.error(`[${source}] ${message}`);
  }
  return line;
}

const make = (level) => (source, message, meta) => emit(level, source, message, meta);

export const log = {
  debug: make('debug'),
  info: make('info'),
  warn: make('warn'),
  error: make('error'),
  /** Bind a fixed source so callers don't repeat it. */
  for: (source) => ({
    debug: (m, meta) => emit('debug', source, m, meta),
    info: (m, meta) => emit('info', source, m, meta),
    warn: (m, meta) => emit('warn', source, m, meta),
    error: (m, meta) => emit('error', source, m, meta),
  }),
};
