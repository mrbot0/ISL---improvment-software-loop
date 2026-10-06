/**
 * DETERMINISTIC SECURITY GATE (ISL_IMPROVE §1 & §6).
 *
 * The LLM security grader gives an opinion; this gate gives facts. It reads the unified
 * diff and flags, deterministically:
 *   - SECRETS introduced in added lines (private keys, cloud keys, provider tokens,
 *     hardcoded passwords) — these VETO the change outright.
 *   - HARMFUL / WEAKENING changes: disabling TLS verification, eval/new Function on
 *     dynamic input, `Math.random` used for security material, and — from REMOVED lines —
 *     stripping an authorization/ownership check. Security controls being *removed* is the
 *     single most dangerous thing an autonomous agent can do, so those veto too.
 *   - Lower-severity smells (shell exec with interpolation, disabled lint on a security
 *     rule) that penalise the score without vetoing.
 *
 * An LLM score can never override a veto here: we do not commit secrets or a weakened
 * security posture, no matter how the prose reads.
 */

// Test/spec/fixture files legitimately contain fake secrets and dummy tokens — don't veto on them.
const TEST_FILE = /(^|\/)(__tests__|tests?|spec|fixtures?|mocks?|examples?)\/|\.(test|spec)\.[jt]sx?$|\.(md|txt|sample|example)$/i;

// —— secret signatures (high confidence) ——
// Exported so the egress firewall REDACTS exactly what this gate DETECTS. Two copies of these
// patterns would drift, and a pattern that drifted out of the redactor is a credential leaving the
// perimeter — so there is deliberately only one list.
export const SECRET_RULES = [
  { kind: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/, msg: 'a private key' },
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/, msg: 'an AWS access key id' },
  { kind: 'stripe-secret', re: /\bsk_live_[0-9A-Za-z]{16,}\b/, msg: 'a live Stripe secret key' },
  { kind: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{30,}\b/, msg: 'a GitHub token' },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_\-]{30,}\b/, msg: 'a Google API key' },
  { kind: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, msg: 'a Slack token' },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/, msg: 'a hardcoded JWT' },
  // Generic assignment of a long literal to a secret-looking name.
  { kind: 'hardcoded-secret', re: /\b(?:api[_-]?key|secret|passwd|password|access[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i, msg: 'a hardcoded secret/credential' },
];

// —— dangerous / weakening patterns in ADDED lines ——
const DANGER_RULES = [
  { kind: 'tls-disabled', sev: 'critical', re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:0|false)/i, msg: 'disables TLS certificate verification' },
  { kind: 'weak-crypto-random', sev: 'high', re: /Math\.random\s*\(\)/, near: /token|secret|password|salt|nonce|otp|key|session|csrf/i, msg: 'uses Math.random() for security-sensitive material (not cryptographically secure)' },
  { kind: 'eval', sev: 'high', re: /\beval\s*\(|new Function\s*\(/, msg: 'introduces eval / new Function (code injection risk)' },
  { kind: 'shell-interpolation', sev: 'medium', re: /\b(?:exec|execSync|spawn|execFile)\s*\(\s*[`'"][^`'"]*\$\{|os\.system\s*\(|subprocess\.[a-z]+\([^)]*shell\s*=\s*True/i, msg: 'builds a shell command from interpolated input (command injection risk)' },
  { kind: 'weak-hash', sev: 'medium', re: /createHash\s*\(\s*['"]md5['"]|createHash\s*\(\s*['"]sha1['"]|hashlib\.md5/i, msg: 'uses a weak hash (md5/sha1) — avoid for security' },
  { kind: 'security-lint-off', sev: 'low', re: /eslint-disable[^\n]*\b(?:security|no-eval|no-unsafe)|nosec|noqa/i, msg: 'disables a security linter rule' },
];

// —— security controls being REMOVED (from '-' lines) ——
const REMOVED_GUARD_RE = /\b(requireAuth|isAuthenticated|ensureAuth|authorize|authorization|checkOwnership|ownerOnly|requireRole|requireAdmin|adminOnly|csrf|helmet|rateLimit|sanitize|escape|verifyToken|verifyJwt|bcrypt|scrypt|argon2)\b/i;

/**
 * Strip JSX/HTML **text nodes** before looking for a removed security control.
 *
 * These names appear in user-facing prose as often as in code. A privacy policy reading
 * "password (sempre cifrata con bcrypt)" is a sentence, not a control — and vetoing its edit cost
 * three real iterations before this was noticed. Removing the text between `>` and `<` deletes the
 * prose and leaves the code, so `router.use(requireAuth)` and `<Protected requireAuth />` still
 * veto while a paragraph mentioning bcrypt does not.
 *
 * A segment containing `{` is kept: that is a JSX expression, which is code, and silently ignoring
 * it would turn this narrowing into a hole. Quoted strings are also kept, because `require('bcrypt')`
 * puts the module name inside one — dropping strings would miss a removed import.
 */
function codeOnly(line) {
  return line.replace(/>([^<>]*)</g, (m, inner) => (inner.includes('{') ? m : '><'));
}

/** Parse the diff into per-file added/removed lines. */
// Shannon entropy (bits/char) — random secrets sit high (~4.5+), English/code low (~3).
function shannon(s) {
  const freq = {};
  for (const c of s) freq[c] = (freq[c] || 0) + 1;
  let e = 0;
  for (const k in freq) {
    const p = freq[k] / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

// High-entropy string literals that look like credentials without a known vendor prefix.
// `limit` defaults to 3 because the gate only needs an example to report; the egress redactor
// raises it, since for redaction missing the fourth one defeats the whole purpose.
export function highEntropyLiterals(addedText, limit = 3) {
  const out = [];
  const re = /['"`]([A-Za-z0-9+/_\-=]{20,120})['"`]/g;
  let m;
  while ((m = re.exec(addedText)) && out.length < limit) {
    const v = m[1];
    if (/^(https?:|data:|\/|\.\/|@|#)/.test(v)) continue; // urls/paths/imports
    if (/^[0-9]+$/.test(v) || /^[a-f0-9]{20,}$/i.test(v)) continue; // pure numbers / hex hashes
    // Require mixed case + digit (random tokens) and high entropy.
    if (shannon(v) >= 4.0 && /[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9]/.test(v)) out.push(v);
  }
  return out;
}

function walkDiff(diff) {
  const files = [];
  let cur = null;
  for (const line of String(diff).split('\n')) {
    const mf = line.match(/^\+\+\+ b\/(.+)$/);
    if (mf) {
      cur = { file: mf[1] === 'dev/null' ? null : mf[1], added: [], removed: [] };
      if (cur.file) files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) cur.added.push(line.slice(1));
    else if (line.startsWith('-') && !line.startsWith('---')) cur.removed.push(line.slice(1));
  }
  return files;
}

/**
 * @returns {{ findings: Array<{severity,kind,file,message}>, veto: boolean, summary: string }}
 */
export function scanDiff(diff) {
  const findings = [];
  if (!diff || !diff.trim()) return { findings, veto: false, summary: 'No changes to scan.' };

  for (const f of walkDiff(diff)) {
    const isTest = f.file && TEST_FILE.test(f.file);
    const addedText = f.added.join('\n');

    // Secrets (skip test/fixture/doc files to avoid false vetoes on dummy values).
    if (!isTest) {
      for (const rule of SECRET_RULES) {
        if (rule.re.test(addedText)) findings.push({ severity: 'critical', kind: rule.kind, file: f.file, message: `${f.file}: introduces ${rule.msg}.` });
      }
      // Entropy heuristic — a possible hardcoded credential with no known vendor prefix.
      // High severity (penalise) rather than a hard veto, to tolerate the odd false hit.
      const ent = highEntropyLiterals(addedText);
      if (ent.length) findings.push({ severity: 'high', kind: 'possible-secret', file: f.file, message: `${f.file}: a high-entropy string literal looks like a hardcoded credential ("${ent[0].slice(0, 8)}…"). Move it to config/env.` });
    }

    // Dangerous / weakening additions.
    for (const rule of DANGER_RULES) {
      if (!rule.re.test(addedText)) continue;
      if (rule.near && !rule.near.test(addedText)) continue; // context-gated (e.g. Math.random near crypto words)
      findings.push({ severity: rule.sev, kind: rule.kind, file: f.file, message: `${f.file}: ${rule.msg}.` });
    }

    // Security controls removed (in a non-test file) and NOT re-added.
    if (!isTest) {
      for (const removed of f.removed) {
        // Match against the CODE on the line, not its rendered prose — see `codeOnly`.
        const m = codeOnly(removed).match(REMOVED_GUARD_RE);
        if (m && !new RegExp(`\\b${m[1]}\\b`, 'i').test(addedText)) {
          findings.push({ severity: 'critical', kind: 'weakened-security', file: f.file, message: `${f.file}: removes a security control ("${m[1]}") — refuses to weaken security.` });
          break; // one per file is enough
        }
      }
    }
  }

  // Dedup identical findings.
  const seen = new Set();
  const deduped = findings.filter((x) => {
    const k = `${x.kind}:${x.file}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const veto = deduped.some((x) => x.severity === 'critical');
  const summary = deduped.length
    ? `${deduped.length} security finding(s)${veto ? ' — VETO' : ''}: ${deduped[0].message}`
    : 'No security issues found.';
  return { findings: deduped.slice(0, 12), veto, summary };
}

/** Score penalty from findings (0 = no penalty). */
export function scorePenalty(findings) {
  const w = { critical: 60, high: 25, medium: 12, low: 4 };
  return findings.reduce((n, f) => n + (w[f.severity] || 0), 0);
}
