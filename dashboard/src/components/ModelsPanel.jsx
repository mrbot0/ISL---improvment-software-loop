import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Models & LLM — pick the brain per phase from what is ACTUALLY installed, without editing .env or
 * restarting. Detection probes Ollama (and any OpenAI-compatible endpoint), reports size, family and
 * embedding capability, and shows which model each role resolves to and WHY (your setting →
 * environment variable → default). Every model can be liveness-tested from here.
 */
const ROLE_LABEL = { implement: 'Implement', review: 'Review', security: 'Security', plan: 'Plan', research: 'Research' };
const ROLE_HINT = {
  implement: 'writes the change — where quality is decided',
  review: 'grades the diff, catches dead code',
  security: 'scans the diff for weakened controls',
  plan: 'composes the batch — fast is fine',
  research: 'reads the web, proposes features',
};

export default function ModelsPanel({ toast }) {
  const [d, setD] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(null);
  const [tested, setTested] = useState({});

  const load = () => api.models().then((r) => { setD(r); setForm(r.config); }).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!d || !form) return null;

  const det = d.detected;
  const chat = det?.chatModels || [];
  const embed = det?.embedModels || [];
  const eff = d.effective;
  const dirty = JSON.stringify(form) !== JSON.stringify(d.config);

  const detect = async () => {
    setBusy('detect');
    try { const r = await api.detectModels(); setD(r); toast?.(`Detected ${r.detected.models.length} model(s)`, { type: 'success' }); }
    catch (e) { toast?.(e.message, { type: 'error' }); } finally { setBusy(null); }
  };
  const save = async () => {
    setBusy('save');
    try { await api.setModelConfig(form); await load(); toast?.('Models updated — in force on the next call, no restart', { type: 'success' }); }
    catch (e) { toast?.(e.message, { type: 'error' }); } finally { setBusy(null); }
  };
  const reset = async () => {
    setBusy('save');
    try { await api.resetModelConfig(); await load(); toast?.('Back to defaults', { type: 'info' }); }
    finally { setBusy(null); }
  };
  const test = async (id, isEmbed) => {
    setBusy(`test:${id}`);
    try {
      const r = await api.testModel(id, isEmbed);
      setTested((t) => ({ ...t, [id]: r }));
      toast?.(`${id}: ${r.ok ? 'OK' : 'failed'} — ${r.detail}`, { type: r.ok ? 'success' : 'error' });
    } catch (e) { toast?.(e.message, { type: 'error' }); } finally { setBusy(null); }
  };

  const Select = ({ value, onChange, options, emptyLabel = 'use default' }) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="input">
      <option value="">{emptyLabel}</option>
      {options.map((m) => <option key={m} value={m}>{m}</option>)}
      {value && !options.includes(value) && <option value={value}>{value} (not installed)</option>}
    </select>
  );
  const From = ({ from }) => (
    <span className={`pill ${from === 'setting' ? 'bg-emerald-500/15 text-emerald-300' : from === 'env' ? 'bg-sky-500/15 text-sky-300' : 'bg-ink-800 text-slate-500'}`}>{from}</span>
  );
  const Field = ({ label, hint, children }) => (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-slate-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[10px] leading-relaxed text-slate-600">{hint}</span>}
    </label>
  );

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-white">Models &amp; LLM</h3>
      <p className="mt-0.5 text-[11px] text-slate-500">
        Pick the model for each phase from what is actually installed. Changes take effect on the next call — no restart.
        Precedence: your setting → environment variable → default.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className={`pill ${det?.providers?.ollama?.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>
          Ollama {det?.providers?.ollama?.ok ? `· ${det.providers.ollama.count} models` : `· ${det?.providers?.ollama?.error || 'unreachable'}`}
        </span>
        {det?.providers?.openaiCompat && (
          <span className={`pill ${det.providers.openaiCompat.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
            OpenAI-compat · {det.providers.openaiCompat.ok ? `${det.providers.openaiCompat.count} models` : det.providers.openaiCompat.error}
          </span>
        )}
        <span className="pill bg-ink-800 text-slate-400">provider: {eff?.provider}</span>
        <div className="flex-1" />
        <button onClick={detect} disabled={!!busy} className="btn-ghost text-[11px]">{busy === 'detect' ? '…' : '⟳ detect models'}</button>
      </div>

      {!!det?.models?.length && (
        <div className="mt-3 max-h-44 divide-y divide-ink-800 overflow-y-auto rounded-lg border border-ink-800">
          {det.models.map((m) => (
            <div key={m.id} className="flex items-center gap-2 px-2 py-1.5 text-[11px]">
              <span className="min-w-0 flex-1 truncate font-mono text-slate-300">{m.id}</span>
              {m.loaded && <span className="pill bg-emerald-500/15 text-emerald-300">loaded{m.vramGB ? ` ${m.vramGB}GB` : ''}</span>}
              <span className={`pill ${m.embedding ? 'bg-violet-500/15 text-violet-300' : 'bg-ink-800 text-slate-500'}`}>{m.embedding ? 'embedding' : 'chat'}</span>
              {m.params && <span className="hidden text-slate-600 sm:inline">{m.params}</span>}
              {m.sizeGB != null && <span className="w-14 text-right text-slate-600">{m.sizeGB} GB</span>}
              <button onClick={() => test(m.id, m.embedding)} disabled={!!busy} className="btn-ghost text-[10px]" title="Send a one-token probe to this model">
                {busy === `test:${m.id}` ? '…' : tested[m.id] ? (tested[m.id].ok ? `✓ ${tested[m.id].ms}ms` : '✗ failed') : 'test'}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="Default model" hint={<>in force: {eff.default.model} <From from={eff.default.from} /></>}>
          <Select value={form.default} onChange={(v) => setForm({ ...form, default: v })} options={chat} />
        </Field>
        <Field label="Alfred (chat)" hint={<>in force: {eff.chat.model} <From from={eff.chat.from} /></>}>
          <Select value={form.chat} onChange={(v) => setForm({ ...form, chat: v })} options={chat} />
        </Field>
        <Field label="Embeddings" hint={<>in force: {eff.embed.model || '(none — lexical only)'} <From from={eff.embed.from} /></>}>
          <Select value={form.embed} onChange={(v) => setForm({ ...form, embed: v })} options={embed} emptyLabel="none (lexical only)" />
        </Field>
      </div>

      <div className="mt-4">
        <div className="mb-2 text-[11px] font-medium text-slate-400">Per phase — put the strong model where quality is decided</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.keys(ROLE_LABEL).map((r) => (
            <Field key={r} label={ROLE_LABEL[r]} hint={<>{ROLE_HINT[r]} · now: {eff.roles[r].model} <From from={eff.roles[r].from} /></>}>
              <Select value={form.roles[r] || ''} onChange={(v) => setForm({ ...form, roles: { ...form.roles, [r]: v } })} options={chat} />
            </Field>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button className="btn-primary" disabled={!!busy || !dirty} onClick={save}>{busy === 'save' ? '…' : dirty ? 'save models' : 'saved'}</button>
        <button className="btn-ghost" disabled={!!busy} onClick={reset}>reset to defaults</button>
        {det?.detectedAt && <span className="text-[11px] text-slate-600">detected {new Date(det.detectedAt).toLocaleTimeString()}</span>}
      </div>
    </div>
  );
}
