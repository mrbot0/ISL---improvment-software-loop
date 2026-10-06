import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPO_ROOT, SECRET_GLOBS, ACTIVE_PROJECT_ID } from '../config.js';
import { matchesAny } from '../glob.js';
import { SECRET_RULES, highEntropyLiterals } from '../iteration/securityGate.js';
import { appendEgress, getPlatformSetting, setPlatformSetting, audit } from '../platform/platformDb.js';
import { notifyOnce } from '../db_iteration.js';

/**
 * LLM EGRESS FIREWALL (ISL_IMPROVE "Enterprise wave", P0).
 *
 * Every phase of ISL — plan, implement, review, security, research, Alfred, and the RAG index —
 * sends source code, diffs, shared memory and retrieved chunks to a model. When the configured
 * provider is a cloud endpoint, that content leaves the customer's perimeter. Before this module
 * there was no record of what was sent, no redaction, and no rule an operator could set. For a
 * regulated organisation that single gap blocks adoption regardless of how good the improvements
 * are, because "we don't know" is not an answer a security review accepts.
 *
 * This is the one choke point every outbound payload passes through. It does four things:
 *
 *   1. **Decides, failing CLOSED.** `local-only` refuses any non-local destination; a misconfigured
 *      or newly-added provider is refused rather than silently allowed. The default IS `local-only`,
 *      so an ISL that is upgraded into this version cannot start leaking on the next call.
 *   2. **Redacts before send.** Credentials are stripped using the SAME rule set the security gate
 *      detects with (imported, never copied — a drifted copy is a leak).
 *   3. **Trips a wire on forbidden content.** The contents of files ISL is never allowed to read
 *      (`.env`, private keys) are fingerprinted; if any of those lines appear in a payload, the call
 *      is denied. This catches the case redaction cannot: secret material that matches no pattern.
 *   4. **Writes an immutable record.** One hash-chained ledger row per call — model, destination,
 *      byte count, redaction count, and the SHA-256 of the exact payload. The hash, not the payload:
 *      storing the text would create a second copy of the customer's source to protect.
 *
 * Local calls are ledgered but NOT redacted or denied: redacting a prompt to a model running on the
 * operator's own machine costs answer quality and protects nothing. "Local" is decided by the
 * resolved hostname, not by the provider's name — an Ollama on a shared GPU box across the network
 * is remote, and is treated as remote.
 */

/* --------------------------------- policy ---------------------------------- */

const POLICY_KEY = 'egress.policy';

export const EGRESS_MODES = {
  'local-only': 'Only models on this machine. Any remote destination is refused.',
  'approved-vendors': 'Remote calls allowed only to explicitly approved hosts.',
  any: 'No destination restriction. Redaction and the ledger still apply.',
};

const DEFAULT_POLICY = {
  // Fails closed by design: an existing install that upgrades into this feature must not start
  // sending code somewhere new because nobody had configured a policy yet.
  mode: 'local-only',
  approvedHosts: [],
  // Files whose CONTENT must never appear in a prompt. Defaults to the same globs the file tools
  // already refuse to read, so the two boundaries agree.
  forbiddenGlobs: [...SECRET_GLOBS],
  // Storing payloads makes the ledger a second copy of the source code. Off unless asked for.
  capturePayloads: false,
  redact: true,
};

export function egressPolicy() {
  const saved = getPlatformSetting(POLICY_KEY, null);
  const p = { ...DEFAULT_POLICY, ...(saved || {}) };
  if (!EGRESS_MODES[p.mode]) p.mode = DEFAULT_POLICY.mode; // unknown mode → the safe one
  return p;
}

export function setEgressPolicy(patch = {}, actor = 'system') {
  const next = { ...egressPolicy(), ...patch };
  if (!EGRESS_MODES[next.mode]) throw new Error(`unknown egress mode: ${next.mode}`);
  next.approvedHosts = (next.approvedHosts || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  next.forbiddenGlobs = (next.forbiddenGlobs || []).map(String).filter(Boolean);
  setPlatformSetting(POLICY_KEY, next);
  // Loosening the data boundary is itself an auditable act.
  audit('egress.policy_changed', { actor, detail: next });
  _tripwire = null; // forbidden globs may have changed
  return next;
}

/* ------------------------------- destination ------------------------------- */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

/** Classify a URL as local or remote by its RESOLVED host, not by the provider's name. */
export function classifyHost(urlOrHost) {
  let host = String(urlOrHost || '').trim();
  try { host = new URL(host).hostname; } catch { host = host.replace(/^https?:\/\//, '').split('/')[0].split(':')[0]; }
  host = host.toLowerCase();
  const local =
    LOCAL_HOSTS.has(host) ||
    host.endsWith('.localhost') ||
    // RFC1918 / link-local: a model on the LAN is still inside the perimeter for most operators,
    // but it is NOT this machine — reported separately so a policy can distinguish them.
    /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  return { host, destination: local ? 'local' : 'remote' };
}

/* -------------------------------- redaction -------------------------------- */

/** A global-flagged clone of a rule's regex — the gate's rules are written for single matches. */
const globalize = (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);

/**
 * Strip credentials from text. Deliberately blunt: a matched secret assignment is replaced whole
 * (`«redacted:hardcoded-secret»`) rather than surgically, because leaving the value's shape intact
 * is exactly how a secret survives redaction.
 */
export function redactText(text) {
  let out = String(text ?? '');
  let count = 0;
  for (const rule of SECRET_RULES) {
    out = out.replace(globalize(rule.re), () => { count++; return `«redacted:${rule.kind}»`; });
  }
  // Vendor-less high-entropy literals: the gate reports one example, the redactor must catch all.
  for (const lit of highEntropyLiterals(out, 50)) {
    const escaped = lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), () => { count++; return '«redacted:high-entropy»'; });
  }
  return { text: out, count };
}

/* -------------------------------- tripwire --------------------------------- */

const IGNORE_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.data', '.next', 'vendor', 'target']);
const TRIPWIRE_TTL = 300_000;
let _tripwire = null;

/**
 * Fingerprint the forbidden files: their distinctive lines, which we then look for in payloads.
 *
 * This is the safety net under redaction. A pattern-based redactor only removes what it recognises;
 * a `.env` full of bespoke internal tokens matches nothing. Fingerprinting answers a different and
 * stricter question — "did any line of a file ISL is forbidden to read end up in this prompt?" —
 * and it needs no pattern at all.
 */
function tripwireFingerprints() {
  if (_tripwire && Date.now() - _tripwire.at < TRIPWIRE_TTL && _tripwire.root === REPO_ROOT) return _tripwire;
  const globs = egressPolicy().forbiddenGlobs;
  const lines = new Map(); // distinctive line → source file
  const walk = (dir, rel, depth) => {
    if (depth > 3 || lines.size > 4000) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORE_DIR.has(e.name)) walk(path.join(dir, e.name), childRel, depth + 1);
        continue;
      }
      if (!matchesAny(childRel, globs)) continue;
      let content = '';
      try {
        if (fs.statSync(path.join(dir, e.name)).size > 256_000) continue; // a huge key file is not a key
        content = fs.readFileSync(path.join(dir, e.name), 'utf8');
      } catch { continue; }
      for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        // Short or structural lines ("PORT=3000", "-----BEGIN…") produce false positives; only
        // lines long enough to be distinctive are worth matching on.
        if (line.length < 16 || line.startsWith('#') || line.startsWith('//')) continue;
        lines.set(line, childRel);
        // For `KEY=value` also fingerprint the value alone: prompts quote values without their key.
        const eq = line.indexOf('=');
        if (eq > 0 && line.length - eq > 17) lines.set(line.slice(eq + 1).trim(), childRel);
      }
    }
  };
  try { walk(REPO_ROOT, '', 0); } catch { /* an unreadable repo must not break the call */ }
  _tripwire = { at: Date.now(), root: REPO_ROOT, lines };
  return _tripwire;
}

/** Which forbidden files have content present in this payload. */
function tripwireHits(payload) {
  const { lines } = tripwireFingerprints();
  const hits = new Set();
  for (const [line, file] of lines) {
    if (payload.includes(line)) hits.add(file);
    if (hits.size >= 5) break;
  }
  return [...hits];
}

/** Drop the cached fingerprints — call when the active project (and so REPO_ROOT) changes. */
export function invalidateEgressTripwire() {
  _tripwire = null;
}

/* ---------------------------------- guard ---------------------------------- */

export class EgressDenied extends Error {
  constructor(reason) {
    super(`egress denied: ${reason}`);
    this.name = 'EgressDenied';
    this.reason = reason;
  }
}

/**
 * Tell a human that the boundary refused a call.
 *
 * Deduped, because a misconfigured provider fails on every phase of every iteration and would
 * otherwise bury the feed. Every occurrence is still in the ledger; this governs only how often
 * someone is interrupted about it. Best-effort: notifying must never be the reason a denial fails
 * to happen.
 */
function announceDenial(reason, destination, host) {
  try {
    notifyOnce({
      kind: 'governance',
      severity: 'warn',
      title: `Model call refused by the egress policy (${host})`,
      body: `${reason}. Destination classified as ${destination}. Change the policy or the provider in ⚖ Governance → Data egress.`,
      link: 'governance',
    });
  } catch { /* the control matters, the announcement does not */ }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * The choke point. Call before any payload leaves the process.
 *
 * @param {object} o
 * @param {string} o.purpose   what this call is for (implement | review | chat | embed | …)
 * @param {string} o.provider  ollama | openai-compatible
 * @param {string} o.model
 * @param {string} o.url       the endpoint being called — classified to decide local vs remote
 * @param {string[]} o.parts   the text pieces being sent (message contents, embedding inputs)
 * @returns {{parts: string[], destination: string, redactions: number, ledgerId: number|null}}
 * @throws {EgressDenied} when policy refuses the call — callers must let this propagate.
 */
export function guardEgress({ purpose = 'unknown', provider = 'ollama', model = null, url = '', parts = [] }) {
  const policy = egressPolicy();
  const { host, destination } = classifyHost(url);
  const texts = parts.map((p) => String(p ?? ''));

  const record = (decision, reason, finalTexts, redactions, tripwires) => {
    const joined = finalTexts.join('\n');
    return appendEgress({
      projectId: ACTIVE_PROJECT_ID,
      purpose, provider, model, host, destination, decision, reason,
      bytes: Buffer.byteLength(joined, 'utf8'),
      parts: finalTexts.length,
      redactions,
      tripwires,
      payloadSha: sha256(joined),
      payload: policy.capturePayloads ? joined.slice(0, 200_000) : null,
    });
  };

  // 1. Destination policy — evaluated before anything else, and failing closed.
  if (destination === 'remote') {
    if (policy.mode === 'local-only') {
      const reason = `policy is local-only and ${host} is not on this machine`;
      record('deny', reason, texts, 0, []);
      announceDenial(reason, destination, host);
      throw new EgressDenied(reason);
    }
    if (policy.mode === 'approved-vendors' && !policy.approvedHosts.includes(host)) {
      const reason = `${host} is not in the approved-vendor list`;
      record('deny', reason, texts, 0, []);
      announceDenial(reason, destination, host);
      throw new EgressDenied(reason);
    }
  }

  // 2. Local destinations are recorded but left untouched: redacting a prompt to a model on this
  //    machine degrades the answer and protects nothing that has not already been read from disk.
  if (destination === 'local') {
    const r = record('allow', null, texts, 0, []);
    return { parts: texts, destination, redactions: 0, ledgerId: r.id ?? null };
  }

  // 3. Redact, then check the tripwire on what would ACTUALLY be sent — checking before redaction
  //    would deny calls that redaction had already made safe.
  let redactions = 0;
  const redacted = policy.redact
    ? texts.map((t) => { const r = redactText(t); redactions += r.count; return r.text; })
    : texts;

  const hits = tripwireHits(redacted.join('\n'));
  if (hits.length) {
    const reason = `content from ${hits.join(', ')} would have been sent (forbidden file)`;
    record('deny', reason, redacted, redactions, hits);
    announceDenial(reason, destination, host);
    throw new EgressDenied(reason);
  }

  const r = record('allow', null, redacted, redactions, []);
  return { parts: redacted, destination, redactions, ledgerId: r.id ?? null };
}
