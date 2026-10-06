/**
 * THE BRIEFING EVERY PART OF THE LOOP READS.
 *
 * The Context Manager already builds an accurate picture of the application — what it is, its
 * architecture, its areas, its key flows, and two lists that matter more than the rest: the
 * INVARIANTS (things that must never break) and the RISKS (ways this codebase is known to be
 * misunderstood). On the live project it holds, among others:
 *
 *   invariant — "Microservice outages must never block user access; fallback to local monolith
 *                logic is mandatory for critical paths"
 *   invariant — "Database migrations must use `prisma migrate deploy`; `db push` is forbidden"
 *   risk      — "Assuming existence of models like `ApiKey` or `Dispute` which do not exist,
 *                leading to runtime errors"
 *
 * That third line describes, in advance, the failure that later removed business users from the
 * application: a run added a `trustScore` field to a model whose table has no such column.
 *
 * The knowledge was there. It never reached the decisions. `projectContextBlurb()` was consumed by
 * three modules — chat, the deploy manager and the researcher — and by none of the four places
 * where it changes an outcome:
 *
 *   the PLANNER   decides what to work on without knowing what the application is;
 *   the REVIEWER  judges whether a change is right without knowing what must never break;
 *   the GRADERS   score a diff with no notion of the flows it touches;
 *   the MANAGERS  advise on a system whose invariants they have not been told.
 *
 * This module is the missing distribution. One composer, audience-aware, so each consumer gets the
 * slice that changes its decision at a length that fits its prompt — a planner needs the whole
 * shape of the app, a reviewer needs the rules for the files in front of it.
 */
import { getProfile } from './contextDb.js';
import { situationSnapshot } from './contextAgent.js';
import { getAllManagerBriefs } from '../db.js';

const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Best-effort profile read. No context is a reason to say less, never to throw. */
function profile() {
  try {
    return getProfile() || null;
  } catch {
    return null;
  }
}

/**
 * Which declared areas a set of changed files belongs to.
 *
 * Areas carry a path prefix (`backend/server`, `services`, `frontend/app`), so a diff can be mapped
 * to the parts of the system it touches — and therefore to the responsibilities and rules that
 * apply. Longest prefix wins, so `services/payments` prefers the microservices area over a
 * hypothetical root one.
 */
export function areasForFiles(files = [], p = profile()) {
  const areas = arr(p?.areas).filter((a) => a && a.path);
  if (!areas.length || !files.length) return [];
  const hit = new Map();
  for (const f of files) {
    const norm = String(f).replace(/\\/g, '/');
    let best = null;
    for (const a of areas) {
      const prefix = String(a.path).replace(/\\/g, '/').replace(/\/+$/, '');
      if (norm === prefix || norm.startsWith(`${prefix}/`)) {
        if (!best || prefix.length > String(best.path).length) best = a;
      }
    }
    if (best) hit.set(best.name, best);
  }
  return [...hit.values()];
}

/** What the application is — the two or three sentences that orient any decision about it. */
function identityBlock(p) {
  if (!p) return '';
  const bits = [
    p.whatItIs && `What it is: ${clip(p.whatItIs, 300)}`,
    p.objective && `Its purpose: ${clip(p.objective, 260)}`,
    p.stack && `Stack: ${clip(Array.isArray(p.stack) ? p.stack.join(', ') : p.stack, 220)}`,
    p.architecture && `Architecture: ${clip(p.architecture, 340)}`,
  ].filter(Boolean);
  return bits.length ? bits.join('\n') : '';
}

/**
 * The invariants, stated as prohibitions.
 *
 * Phrased this way deliberately: a model reads "the API contract must never change" as a constraint
 * on its own output, where the same fact written as a description reads as background it may
 * summarise back. These are the sentences most likely to stop a bad change.
 */
function invariantBlock(p, limit = 8) {
  const inv = arr(p?.invariants).slice(0, limit);
  if (!inv.length) return '';
  return `INVARIANTS — these must hold after your change. A change that breaks one is wrong even if it works:\n${inv
    .map((i) => `  • ${clip(typeof i === 'object' ? i.text || JSON.stringify(i) : i, 220)}`)
    .join('\n')}`;
}

/** Known ways this codebase gets misunderstood. */
function riskBlock(p, limit = 6) {
  const risks = arr(p?.risks).slice(0, limit);
  if (!risks.length) return '';
  return `KNOWN RISKS in this codebase — mistakes made here before:\n${risks
    .map((r) => `  • ${clip(typeof r === 'object' ? r.text || JSON.stringify(r) : r, 220)}`)
    .join('\n')}`;
}

/** The areas of the system, with what each is responsible for. */
function areaBlock(areas, { detail = true } = {}) {
  if (!areas.length) return '';
  return `AREAS THIS TOUCHES:\n${areas
    .map((a) => `  • ${a.name}${a.path ? ` (${a.path})` : ''}${detail && a.responsibility ? ` — ${clip(a.responsibility, 180)}` : ''}`)
    .join('\n')}`;
}

/** The user-visible journeys. A change that breaks one of these is not a small change. */
function flowBlock(p, limit = 5) {
  const flows = arr(p?.keyFlows).slice(0, limit);
  if (!flows.length) return '';
  return `KEY USER FLOWS — the journeys that must keep working:\n${flows
    .map((f) => `  • ${clip(typeof f === 'object' ? f.name || JSON.stringify(f) : f, 180)}`)
    .join('\n')}`;
}

/**
 * What the supervisory layer is currently worried about.
 *
 * Managers each publish a brief and, until now, nobody read anyone else's. A manager in `alert`
 * knows something the rest of the fleet is about to need — that the app is not booting, that a
 * gate keeps blocking one area, that reliability is degrading — and that knowledge stopped at its
 * own dashboard card.
 */
export function managerConcerns({ limit = 5 } = {}) {
  let briefs = [];
  try {
    briefs = getAllManagerBriefs() || [];
  } catch {
    return '';
  }
  const alerting = briefs
    .filter((b) => b && (b.status === 'alert' || b.status === 'acting'))
    .slice(0, limit);
  if (!alerting.length) return '';
  return `WHAT THE SUPERVISORY MANAGERS ARE FLAGGING RIGHT NOW:\n${alerting
    .map((b) => `  • ${b.name}: ${clip(b.headline, 160)}${b.recommendations?.[0] ? ` → ${clip(b.recommendations[0], 120)}` : ''}`)
    .join('\n')}`;
}

/** Live state of the loop, one line. */
function situationLine() {
  try {
    const s = situationSnapshot();
    if (!s?.activeIteration) return '';
    const a = s.activeIteration;
    return `Right now: iteration #${a.id}${a.phase ? ` in "${a.phase}"` : ''}${a.title ? ` — ${clip(a.title, 110)}` : ''}.`;
  } catch {
    return '';
  }
}

/**
 * Compose the briefing for one audience.
 *
 * @param {'planner'|'reviewer'|'implementer'|'manager'|'agent'} audience
 * @param {{files?: string[], area?: string|null, includeSituation?: boolean}} opts
 * @returns {string} a prompt block, or '' when there is nothing worth saying
 */
export function briefingFor(audience, { files = [], area = null, includeSituation = true } = {}) {
  const p = profile();
  if (!p) return '';

  const touched = files.length
    ? areasForFiles(files, p)
    : area
      ? arr(p.areas).filter((a) => a && (a.name === area || a.path === area))
      : [];

  const parts = [];

  switch (audience) {
    /*
     * The planner chooses the work. It needs the whole shape of the application — what it is, how
     * it is divided, which journeys must keep working — plus the rules and the known traps, because
     * the cheapest place to stop a bad change is before it is proposed.
     */
    case 'planner':
      parts.push(identityBlock(p), areaBlock(arr(p.areas), { detail: true }), flowBlock(p), invariantBlock(p), riskBlock(p), managerConcerns());
      break;

    /*
     * The reviewer judges a diff that already exists. It does not need the tour; it needs the rules
     * that apply to the files in front of it. Scoped by area so the block stays short enough to be
     * read rather than skimmed.
     */
    case 'reviewer':
      parts.push(
        identityBlock(p) && `About this application:\n${identityBlock(p)}`,
        areaBlock(touched),
        invariantBlock(p),
        riskBlock(p),
      );
      break;

    /* The implementer already receives a working context; this adds the rules it must not break. */
    case 'implementer':
      parts.push(areaBlock(touched, { detail: true }), invariantBlock(p, 6), riskBlock(p, 4));
      break;

    /* A manager advises about the system; it should know what the system is and what peers see. */
    case 'manager':
      parts.push(identityBlock(p), invariantBlock(p, 5), managerConcerns());
      break;

    default:
      parts.push(identityBlock(p), invariantBlock(p, 5), riskBlock(p, 4));
  }

  if (includeSituation) parts.push(situationLine());

  const body = parts.filter(Boolean).join('\n\n');
  if (!body) return '';
  return `PROJECT BRIEFING (from the Context Manager — treat as ground truth about this application):\n${body}`;
}

/** Everything at once, for the dashboard and for anything that wants to inspect the briefing. */
export function briefingSnapshot() {
  const p = profile();
  return {
    hasProfile: !!p,
    updatedAt: p?.updatedAt || null,
    counts: {
      invariants: arr(p?.invariants).length,
      risks: arr(p?.risks).length,
      areas: arr(p?.areas).length,
      keyFlows: arr(p?.keyFlows).length,
    },
    audiences: Object.fromEntries(
      ['planner', 'reviewer', 'implementer', 'manager'].map((a) => [a, briefingFor(a, { includeSituation: false }).length]),
    ),
  };
}
