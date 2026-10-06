import { useEffect, useRef, useState } from 'react';
import { api, chatStream } from '../api.js';
import { Spinner } from './ui.jsx';

const SUGGESTIONS = [
  'What is this project and what are its main risks?',
  'What needs my review right now?',
  'Run a compliance check across all languages',
  'Search online for new features worth adding',
  'Give me a summary of what has shipped',
];

/** Tool calls that mutate state get a louder colour than read-only lookups. */
const MUTATING = new Set([
  'approve_proposal', 'reject_proposal', 'configure_agent', 'run_agent', 'control_loop',
  'run_research', 'run_compliance_check', 'build_context', 'switch_project',
]);

/** Downloadable exports Alfred can produce — logs and data from agents, managers, the DB. */
const EXPORTS = [
  ['Full snapshot (report)', () => api.report()],
  ['Logs', () => api.logs({ limit: 1000 })],
  ['Agents', () => api.agentsList()],
  ['Managers', () => api.managers()],
  ['Reliability data', () => api.reliability()],
  ['Compliance findings', () => api.compliance()],
  ['Backlog', () => api.backlog()],
  ['Proposals', () => api.proposalsAll()],
  ['Cloud / deploy', () => api.cloudReport()],
];

async function downloadJson(name, dataPromise) {
  const data = await dataPromise;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `isl-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

const readAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

export default function Chat({ onStateChange, onClose }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [live, setLive] = useState(null); // { content, tools }
  const [error, setError] = useState(null);
  const [attachments, setAttachments] = useState([]); // {name, dataUrl}
  const [exportOpen, setExportOpen] = useState(false);
  const scroller = useRef(null);
  const abortRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    api.messages().then(setMessages).catch(() => {});
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, live]);

  const addFiles = async (files) => {
    const imgs = [...files].filter((f) => f.type.startsWith('image/')).slice(0, 4 - attachments.length);
    const read = await Promise.all(imgs.map(async (f) => ({ name: f.name, dataUrl: await readAsDataUrl(f) })));
    setAttachments((a) => [...a, ...read].slice(0, 4));
  };

  const submit = async (text) => {
    const message = (text ?? draft).trim();
    if ((!message && !attachments.length) || streaming) return;

    const imgs = attachments.map((a) => a.dataUrl);
    const shownImgs = attachments.map((a) => a.dataUrl);
    setDraft('');
    setAttachments([]);
    setError(null);
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: 'user', content: message, images: shownImgs, ts: Date.now() }]);
    setStreaming(true);
    setLive({ content: '', tools: [] });

    const ac = new AbortController();
    abortRef.current = ac;
    let touchedState = false;

    try {
      for await (const evt of chatStream(message || '(image)', ac.signal, imgs)) {
        if (evt.type === 'token') setLive((l) => ({ ...l, content: l.content + evt.text }));
        else if (evt.type === 'tool') {
          if (MUTATING.has(evt.name)) touchedState = true;
          setLive((l) => ({ ...l, tools: [...l.tools, evt] }));
        } else if (evt.type === 'done') {
          setMessages((m) => [...m, { id: `a-${Date.now()}`, role: 'assistant', content: evt.content, meta: { tools: evt.tools }, ts: Date.now() }]);
        } else if (evt.type === 'error') setError(evt.error);
      }
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    } finally {
      setStreaming(false);
      setLive(null);
      abortRef.current = null;
      if (touchedState) onStateChange?.();
    }
  };

  const clear = async () => {
    await api.clearMessages();
    setMessages([]);
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-ink-950">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-brand/20 text-[13px]">🎩</span>
        <div className="leading-tight">
          <div className="text-xs font-semibold text-slate-200">Alfred</div>
          <div className="text-[10px] text-slate-600">your operations assistant</div>
        </div>
        <div className="flex-1" />
        <div className="relative">
          <button onClick={() => setExportOpen((v) => !v)} className="btn-ghost h-7 px-2 text-[11px]" title="Export logs & data">⭳ export</button>
          {exportOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
              <div className="absolute right-0 z-50 mt-1 w-52 rounded-xl border border-ink-700 bg-ink-900 p-1 shadow-lift">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600">Download as JSON</div>
                {EXPORTS.map(([label, fn]) => (
                  <button
                    key={label}
                    onClick={async () => {
                      setExportOpen(false);
                      try {
                        await downloadJson(label, fn());
                      } catch (e) {
                        setError(`Export failed: ${e.message}`);
                      }
                    }}
                    className="block w-full rounded-lg px-2 py-1.5 text-left text-[12px] text-slate-300 hover:bg-ink-800"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        {messages.length > 0 && (
          <button onClick={clear} className="text-[10px] text-slate-600 hover:text-slate-300">clear</button>
        )}
        {onClose && <button onClick={onClose} className="btn-ghost h-7 px-1.5" aria-label="Close Alfred">✕</button>}
      </div>

      {/* messages — scrollable */}
      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!messages.length && !live && (
          <div className="space-y-2 pt-2">
            <p className="text-center text-[11px] leading-relaxed text-slate-600">
              Ask Alfred anything about the project, or tell him what to do — he can run agents and research,
              check compliance, review proposals, switch projects, steer the loop, and export logs & data.
            </p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => submit(s)}
                className="block w-full rounded-lg border border-ink-800 px-2.5 py-1.5 text-left text-[11px] text-slate-400 transition-colors hover:border-ink-600 hover:text-slate-200"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((m) => (
          <Bubble key={m.id} role={m.role} content={m.content} tools={m.meta?.tools} images={m.images} />
        ))}

        {live && <Bubble role="assistant" content={live.content} tools={live.tools} streaming />}
        {error && <p className="rounded-lg bg-rose-950/40 px-2.5 py-1.5 text-[11px] text-rose-300">{error}</p>}
      </div>

      {/* attachment thumbnails */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-ink-800 px-3 py-2">
          {attachments.map((a, i) => (
            <div key={i} className="relative">
              <img src={a.dataUrl} alt={a.name} className="h-12 w-12 rounded-lg border border-ink-700 object-cover" />
              <button
                onClick={() => setAttachments((list) => list.filter((_, j) => j !== i))}
                className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-ink-800 text-[10px] text-slate-300 hover:bg-rose-900 hover:text-white"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="border-t border-ink-800 p-2.5"
      >
        <div className="flex items-end gap-2">
          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={streaming || attachments.length >= 4}
            className="btn-ghost h-9 w-9 shrink-0 justify-center px-0"
            title="Attach image(s)"
          >
            📎
          </button>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder={streaming ? 'Alfred is thinking…' : 'Ask Alfred… (Enter to send)'}
            disabled={streaming}
            className="input max-h-28 min-h-[36px] flex-1 resize-none py-2"
            aria-label="Message Alfred"
          />
          {streaming ? (
            <button type="button" onClick={() => abortRef.current?.abort()} className="btn-danger h-9 shrink-0">stop</button>
          ) : (
            <button type="submit" disabled={!draft.trim() && !attachments.length} className="btn-primary h-9 shrink-0">send</button>
          )}
        </div>
      </form>
    </section>
  );
}

function Bubble({ role, content, tools, images, streaming }) {
  const isUser = role === 'user';
  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
      <span
        className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] ${
          isUser ? 'bg-emerald-500/20' : 'bg-brand/20'
        }`}
      >
        {isUser ? '🧑' : '🎩'}
      </span>
      <div className={`min-w-0 max-w-[85%] ${isUser ? 'items-end text-right' : ''}`}>
        {!!images?.length && (
          <div className="mb-1 flex flex-wrap gap-1">
            {images.map((src, i) => (
              <img key={i} src={src} alt="attachment" className="h-16 w-16 rounded-lg border border-ink-700 object-cover" />
            ))}
          </div>
        )}
        {!!tools?.length && (
          <div className="mb-1.5 space-y-0.5 text-left">
            {tools.map((t, i) => (
              <div key={i} className="flex items-start gap-1.5 font-mono text-[10px]">
                <span className={MUTATING.has(t.name) ? 'text-amber-500' : 'text-slate-600'}>{MUTATING.has(t.name) ? '⚡' : '·'}</span>
                <span className={MUTATING.has(t.name) ? 'text-amber-400' : 'text-slate-600'}>{t.name}</span>
                <span className="min-w-0 truncate text-slate-700">
                  {Object.entries(t.args ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}
                </span>
              </div>
            ))}
          </div>
        )}

        {(content || !tools?.length) && (
          <div
            className={`inline-block whitespace-pre-wrap rounded-xl px-3 py-2 text-left text-[12px] leading-relaxed ${
              isUser ? 'bg-emerald-500/15 text-emerald-100' : 'bg-ink-800/60 text-slate-300'
            }`}
          >
            {content}
            {streaming && !content && <Spinner className="text-slate-500" />}
            {streaming && content && <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-emerald-400 align-middle" />}
          </div>
        )}
      </div>
    </div>
  );
}
