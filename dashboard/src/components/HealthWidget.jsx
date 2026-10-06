import { useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { SAFETY_NET_MS } from '../liveKeys.js';

/**
 * Compact health popover: Ollama reachability, model + VRAM, WS status, and the
 * repo branch/head. Reads /health from the shared resource cache, refreshed by the events that
 * change it rather than on a timer.
 */
export default function HealthWidget({ wsStatus, repo }) {
  const [open, setOpen] = useState(false);
  // On the shared resource: an iteration finishing invalidates `health`, so this reflects a new
  // score the moment one lands rather than up to fifteen seconds later — and the widget is mounted
  // on every page, so its request is now deduped with anything else asking the same question.
  // A failed fetch is itself a health signal: the old code set `{ ok: false }` on error, and losing
  // that would make an unreachable server look merely "not loaded yet".
  const { data, error } = useResource('health', api.health, { interval: SAFETY_NET_MS });
  const health = error ? { ok: false } : data;

  const ollamaOk = health?.ollama?.ok;
  const baseline = health?.baseline;
  // A misaligned baseline means the fleet is improving code you don't ship. That is
  // not a footnote — it is a health failure, and it turns the dot red.
  const baselineOk = baseline ? baseline.aligned && !baseline.warning : true;
  const allOk = ollamaOk && wsStatus === 'online' && baselineOk;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2 py-1 text-[11px] text-slate-400 hover:bg-ink-800"
        title="System health"
      >
        <span className={`h-2 w-2 rounded-full ${allOk ? 'bg-emerald-400' : !baselineOk ? 'bg-rose-400' : ollamaOk || wsStatus === 'online' ? 'bg-amber-400' : 'bg-rose-400'}`} />
        health
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 space-y-2 rounded-xl border border-ink-700 bg-ink-950 p-3 text-[11px] shadow-2xl">
          <Row label="Ollama" ok={ollamaOk} value={ollamaOk ? 'reachable' : health?.ollama?.error || 'unreachable'} />
          <Row label="Model" value={health?.ollama?.model || '—'} mono />
          <Row label="WebSocket" ok={wsStatus === 'online'} value={wsStatus} />
          <Row
            label="Pipeline"
            ok={health?.control?.looping}
            value={health?.control?.running ? 'iterating' : health?.control?.looping ? 'armed' : 'stopped'}
            neutral
          />
          <Row label="Parallel" value={`${health?.control?.parallel?.maxTasks ?? 1} task(s)`} neutral />

          {/* Which code are the agents actually improving? */}
          <div className="border-t border-ink-800 pt-2">
            <Row label="Improving" ok={baseline?.aligned} value={baseline?.baseBranch || '—'} mono />
            <Row label="Checked out" value={baseline?.checkedOut || '—'} mono />
            <Row label="Tracked files" value={baseline?.trackedFiles ?? '—'} mono neutral />
            {baseline?.warning && (
              <div className="mt-1.5 rounded border border-rose-900/60 bg-rose-950/40 p-1.5 leading-relaxed text-rose-300">
                {baseline.warning}
              </div>
            )}
          </div>

          <div className="border-t border-ink-800 pt-2">
            <Row label="HEAD" value={repo?.head} mono />
            {/*
              "working tree dirty" era un semaforo rosso senza istruzioni: diceva che c'era
              qualcosa, non che cosa né cosa farne. Da qui si arriva alla classificazione, che è
              l'unica informazione che rende l'avviso azionabile.
            */}
            {repo?.dirty && <TreeCleaner />}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * L'albero sporco, spiegato e ripulibile.
 *
 * Le voci arrivano già classificate dal server. Qui la regola dell'interfaccia è una sola: ciò che
 * contiene lavoro vero non è selezionabile. Non "selezionabile con un avviso" — non selezionabile,
 * perché un avviso che si può ignorare con un clic è la premessa di un lavoro perso.
 */
function TreeCleaner() {
  const [analisi, setAnalisi] = useState(null);
  const [scelti, setScelti] = useState([]);
  const [esito, setEsito] = useState(null);
  const [busy, setBusy] = useState(false);

  const apri = async () => {
    setBusy(true);
    try {
      const r = await api.treeAnalyse();
      setAnalisi(r);
      // Preselezionate solo le categorie a rischio zero: gli scarti e il rumore di formattazione.
      setScelti((r.items || []).filter((i) => i.rischio === 0).map((i) => i.path));
    } catch (e) { setEsito({ error: e.message }); }
    finally { setBusy(false); }
  };

  const esegui = async () => {
    setBusy(true);
    try { setEsito(await api.treeClean(scelti)); await apri(); }
    catch (e) { setEsito({ error: e.message }); }
    finally { setBusy(false); }
  };

  if (!analisi) {
    return (
      <button onClick={apri} disabled={busy} className="mt-1 text-amber-400 underline decoration-dotted hover:text-amber-300">
        {busy ? 'analisi…' : 'working tree dirty — esamina'}
      </button>
    );
  }
  if (analisi.clean) return <div className="mt-1 text-emerald-400">albero pulito</div>;

  const lavoro = (analisi.items || []).filter((i) => i.categoria === 'lavoro');
  const azionabili = (analisi.items || []).filter((i) => i.categoria !== 'lavoro');

  return (
    <div className="mt-1 space-y-1">
      <div className="text-amber-400">{analisi.summary}</div>
      {azionabili.map((i) => (
        <label key={i.path} className="flex items-start gap-1.5 text-[10px] text-slate-400">
          <input
            type="checkbox"
            checked={scelti.includes(i.path)}
            onChange={(e) => setScelti((s) => (e.target.checked ? [...s, i.path] : s.filter((p) => p !== i.path)))}
            className="mt-0.5"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono" title={i.path}>{i.path}</span>
            <span className="text-slate-600">{i.etichetta} → {i.azione}{i.bytes ? ` · ${Math.round(i.bytes / 1024)} KB` : ''}</span>
          </span>
        </label>
      ))}
      {lavoro.length > 0 && (
        <div className="rounded border border-ink-800 px-1.5 py-1 text-[10px] text-slate-500">
          {lavoro.length} file con modifiche vere — non selezionabili. Salvale con un commit o uno stash.
        </div>
      )}
      {esito?.error && <div className="text-rose-400">{esito.error}</div>}
      {esito?.done?.length > 0 && (
        <div className="text-emerald-400">
          {esito.done.length} voci sistemate. {esito.recupero?.come}
        </div>
      )}
      <button
        onClick={esegui}
        disabled={busy || !scelti.length}
        className="w-full rounded border border-amber-900/60 px-2 py-1 text-[10px] font-semibold text-amber-300 hover:bg-amber-950/40 disabled:opacity-40"
      >
        {busy ? 'in corso…' : `ripulisci ${scelti.length} voci (recuperabile)`}
      </button>
    </div>
  );
}

const Row = ({ label, value, ok, mono, neutral }) => (
  <div className="flex items-center justify-between gap-2">
    <span className="text-slate-500">{label}</span>
    <span className={`flex items-center gap-1.5 ${mono ? 'font-mono' : ''} ${ok === undefined || neutral ? 'text-slate-300' : ok ? 'text-emerald-400' : 'text-rose-400'}`}>
      {ok !== undefined && !neutral && <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-400' : 'bg-rose-400'}`} />}
      <span className="truncate">{value}</span>
    </span>
  </div>
);
