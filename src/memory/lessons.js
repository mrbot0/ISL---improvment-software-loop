import { KIND } from '../core/failure.js';

/**
 * WHAT IS WORTH LEARNING FROM (and what is only worth logging).
 *
 * The fleet's shared memory was being filled with restated error messages. Measured on the live
 * database, the highest-ranked "lessons" an agent was shown before every task were:
 *
 *     "Recurring failure: implementation error — the implementer…"      (×77)
 *     "Iteration failure: Implementation error — the implementer…"      (×77, the same thing again)
 *     "Recurring error: ## empty — implementation error…"               (×77, and again)
 *     "Recurring failure: failed — cause not recognised"                (×20)
 *     "Recurring error: fetch failed"                                   (×11)
 *
 * None of those change what an agent does. "cause not recognised" is a gap in our classifier;
 * "fetch failed" is a network hiccup; and the first three are one failure written by three different
 * code paths. They occupied the top of every prompt's memory block because `recall` ranked by how
 * often a memory had RECURRED — so the most frequent infrastructure problem outranked a carefully
 * written lesson that had been recorded once.
 *
 * The rule this module enforces is simple and worth stating plainly:
 *
 *     A memory earns a place in a prompt only if it would change what the agent does next.
 *
 * Everything else still gets recorded as an error, an anomaly, a run record — the operator can see
 * all of it. It just does not get taught.
 */

/**
 * The curated lessons, keyed by the failure classifier's code.
 *
 * Each says what went wrong AND what to do instead. "Do not duplicate code" is a scolding; a lesson
 * that names the tool to use and the step that was skipped is something an agent can act on. These
 * are written by hand on purpose — a generated summary of an error message is the thing this module
 * exists to stop.
 */
export const FAILURE_LESSONS = {
  'refactor-duplication': {
    title: 'A refactor must replace, never duplicate',
    agentTitle: 'Your last refactor duplicated instead of replacing',
    content:
      'A change framed as a refactor added code and deleted NOTHING, so the original still sits alongside the replacement — the codebase grew and nothing was simplified. '
      + 'Before finishing a structural change: find every caller of the old code with search_code, point them at the new code, and DELETE the old definition in the SAME change. '
      + 'If you cannot delete it yet, the task is not a refactor — say so and make the smaller, honest change instead.',
  },
  'dead-code': {
    title: 'Never leave new code unused',
    agentTitle: 'Your last change added code nothing calls',
    content:
      'A new file, hook, helper or export that nothing imports or calls is dead code and is vetoed. '
      + 'Wire it into a real caller in the SAME change (use search_code to find where it belongs), or make the edit inline instead of adding an abstraction nobody uses yet.',
  },
  'security-veto': {
    title: 'Never weaken security, even incidentally',
    agentTitle: 'Your last change removed a security control',
    content:
      'The deterministic security gate refused a change that removed an auth, ownership, sanitisation or hashing control — or introduced a credential. '
      + 'If a guard is in your way, MOVE it, do not delete it. If you are editing prose that merely mentions a security mechanism, leave the mechanism itself untouched.',
  },
  boot: {
    title: 'A change that stops the app booting is never acceptable',
    agentTitle: 'Your last change stopped the application starting',
    content:
      'Every test passed and the application still failed to start. This is almost always a missing import, a renamed export a caller still references, or a config key removed from one side only. '
      + 'After an edit that touches imports, entry points or config, trace the boot path before finishing.',
  },
  contract: {
    title: 'Do not break the public surface silently',
    agentTitle: 'Your last change broke the public surface',
    content:
      'A route, an exported symbol or a database column that consumers outside this repository depend on was removed or changed shape. A green test suite cannot see this. '
      + 'Deprecate rather than delete: keep the old surface working alongside the new one, or state explicitly that the change is breaking.',
  },
  behaviour: {
    title: 'A refactor must not change what the software does',
    agentTitle: 'Your last refactor changed behaviour',
    content:
      'The suite was run at the base commit and again against your change, and the results differed — a test that passed now fails, or fewer tests ran than before. '
      + 'That is not a refactor; it is a behaviour change wearing the name of one. Move code without editing what it does: keep the same inputs, outputs, order and error cases. '
      + 'If a test stopped being collected, you moved or renamed a file the runner was finding — put it back where the runner looks. '
      + 'If you genuinely need to change behaviour, say so and make it a separate, honest change.',
  },
  'broke-tests': {
    title: 'Never leave a suite redder than you found it',
    agentTitle: 'Your last change broke a passing test suite',
    content:
      'A test suite that PASSED at the base commit fails after your change. This is not a pre-existing failure you inherited — it is attributable to you, and it was checked both ways to be sure. '
      + 'Run the suite for the area you are editing before you finish. If a test fails because it encoded behaviour you deliberately changed, update the test IN THE SAME change and say so in your summary; '
      + 'if it fails for any other reason, the change is not done.',
  },
  parse: {
    title: 'Every file you write must compile',
    agentTitle: 'Your last change produced a file that does not parse',
    content:
      'A file you edited is not valid source — the language parser rejected it. This is almost always a truncated edit, an unbalanced brace or bracket, or a stray fragment left behind by a partial replacement. '
      + 'After every edit, re-read the WHOLE region you changed, not just the lines you typed: an edit that lands halfway through an existing block leaves the file broken in a way the diff alone does not show.',
  },
  'too-big': {
    title: 'Keep a change reviewable',
    agentTitle: 'Your last change exceeded the size budget',
    content:
      'The diff was larger than the configured change budget. A large change is harder to review, riskier to land, and harder to revert cleanly. '
      + 'Split the work: land the smallest coherent piece that stands on its own, and leave the rest as a follow-up backlog item.',
  },
  empty: {
    title: 'Finish with a concrete edit, not a description of one',
    agentTitle: 'Your last task ended without editing a single file',
    content:
      'You finished without changing any file. Prose in the chat is not a change — it is discarded. '
      + 'If the plan is unclear, make the smallest edit that is definitely right and say what is left. If a tool refused your edit, READ the refusal: it names the reason (a path outside the writable area, an old_string that does not match) and it is usually one correction away from working.',
  },
};

/**
 * Failure codes that describe the MACHINE or the OPERATOR, not the work.
 *
 * Teaching an agent about these is worse than useless: it cannot act on them, and the memory block
 * has a budget — every line spent on "the network dropped" is a line not spent on something it could
 * have done differently.
 */
const NOT_TEACHABLE = new Set([
  'unknown', // a gap in our classifier, not a lesson for the fleet
  'cancelled',
  'interrupted',
  'server_restart',
  'infra',
  'conflict', // the base moved underneath the change; nobody did anything wrong
  'quality', // "scored below threshold" — the specific gate that failed is the lesson, not this
]);

/**
 * The lesson to record for a failure, or `null` when there is nothing to teach.
 *
 * @param {{kind?:string, code?:string, title?:string, explanation?:string}} failure
 * @param {{agentId?:string|null}} [opts]
 * @returns {{scope:string, kind:'pitfall', title:string, content:string, source:string}|null}
 */
export function lessonFor(failure, { agentId = null } = {}) {
  if (!failure) return null;

  // Only the WORK can teach. An interruption was never judged; infrastructure is not behaviour.
  if (failure.kind && failure.kind !== KIND.IMPLEMENTATION) return null;
  if (failure.code && NOT_TEACHABLE.has(failure.code)) return null;

  const curated = FAILURE_LESSONS[failure.code];
  if (!curated) return null;

  return {
    scope: agentId ? `agent:${agentId}` : 'global',
    kind: 'pitfall',
    title: agentId ? curated.agentTitle : curated.title,
    content: curated.content,
    source: `lesson:${failure.code}`,
  };
}

/** Is there anything worth teaching the fleet about this failure? */
export const isTeachable = (failure) => lessonFor(failure) !== null;
