/**
 * DID THE CHANGE DO WHAT THE TASK SAID?
 *
 * The gate stack checks whether a diff is broken — it does not parse, it removes an export, it
 * breaks a suite, the app stops booting. None of those ask the simpler question: is this the change
 * that was asked for?
 *
 * The failure that motivated this is worth stating exactly, because it is not a compile error and
 * no existing gate could have caught it. Run #426 carried the task:
 *
 *     "Resolve TODO in backend/server/routes/search.js regarding userPrefs at line 45"
 *
 * The implementer resolved it by DELETING the code the TODO referred to: the whole personalisation
 * block (favourite categories, price range, currency) and the `userPrefs` argument to `rankItems`.
 * Review scored it 55 — the only grader that reads intent against diff, and the only one that
 * objected. Security 95, regression 100, tests 100, boot 100. Review weighs 0.2, so the total came
 * to 90 against a rollback threshold of 60, and it committed. The search bar lost personalisation
 * in production, and nothing in the record said so.
 *
 * Two rules, both deterministic, both about the same thing:
 *
 *   1. A task whose stated intent is to ADD or FIX something must not produce a pure deletion of
 *      the identifier it names.
 *   2. A review score below a floor is disqualifying on its own, regardless of what the average
 *      says. A weighted mean lets four mechanical checks outvote the one judgement call.
 */

/** Verbs that mean "there should be MORE of this afterwards, not less". */
const ADDITIVE = /\b(add|implement|resolve|wire|introduce|support|enable|complete|finish|handle|apply|use|restore|fix)\b/i;

/** Verbs that legitimately mean "there should be less". A deletion is the point of these. */
const SUBTRACTIVE = /\b(remove|delete|drop|strip|prune|clean\s*up|deprecate|unused|dead\s*code|simplif|inline|consolidat)\b/i;

/**
 * Identifiers a task names, taken from its title and rationale.
 *
 * `userPrefs`, `rankItems`, `getRemainingCooldown` — camelCase and snake_case names of four or more
 * characters. Ordinary prose words are excluded by requiring an internal capital or underscore, so
 * "Resolve TODO in search.js regarding userPrefs" yields `userPrefs` and nothing else.
 */
export function namedIdentifiers(text = '') {
  const out = new Set();
  for (const m of String(text).matchAll(/\b([a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+|[a-z]+(?:_[a-z0-9]+)+)\b/g)) {
    if (m[1].length >= 4) out.add(m[1]);
  }
  return [...out];
}

/** Added and removed occurrences of `name` across a unified diff. */
export function countInDiff(diff = '', name = '') {
  if (!name) return { added: 0, removed: 0 };
  // Word-boundary match so `prefs` does not count occurrences of `prefsFoo`.
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  let added = 0;
  let removed = 0;
  for (const line of String(diff).split('\n')) {
    // `+++`/`---` are file headers, not content.
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') && re.test(line)) added++;
    else if (line.startsWith('-') && re.test(line)) removed++;
  }
  return { added, removed };
}

/**
 * Split a unified diff into per-file sections, keyed by the post-image path.
 *
 * Needed because a batch runs several tasks into one diff. Checking every task against the whole
 * thing would let a deletion made by an honest cleanup task be blamed on an unrelated additive one
 * in the same batch — a false accusation that would get this gate turned off within a week.
 */
export function diffByFile(diff = '') {
  const out = new Map();
  let current = null;
  for (const line of String(diff).split('\n')) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) {
      current = m[1];
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    if (current) out.get(current).push(line);
  }
  return new Map([...out].map(([k, v]) => [k, v.join('\n')]));
}

/**
 * Check one batch plan against the diff it produced.
 *
 * A violation is narrow on purpose — a gate that fires on judgement calls gets switched off. It
 * needs all of: an additive task, no subtractive word anywhere in it, an identifier the task names
 * by hand, and — within the files that task declared — that identifier being removed and never
 * added back. A change that is doing what it said does not make its own subject disappear.
 *
 * @param {object} plan  the batch plan (`{ tasks: [{ title, rationale, files, … }] }`)
 * @param {string} diff  the unified diff the run produced
 * @returns {{veto:boolean, violations:Array, checked:boolean, summary:string}}
 */
export function checkIntentPreserved(plan, diff, { minRemovals = 1 } = {}) {
  const tasks = plan?.tasks || [];
  if (!tasks.length || !diff) {
    return { veto: false, violations: [], checked: false, summary: 'no plan or no diff to compare' };
  }

  const byFile = diffByFile(diff);
  const violations = [];
  for (const task of tasks) {
    /*
     * Intent is judged from the TITLE, which is the commitment; identifiers are gathered from the
     * rationale too, because that is where the specifics live.
     *
     * Classifying on the rationale as well looked more thorough and was the hole #426 went through.
     * Its title was "Resolve TODO … regarding userPrefs"; its rationale said the TODO was
     * "unclear if it's dead code or a missing feature" and that "removing/clearing this ensures the
     * search route is clean". Reading both, the gate saw a subtractive word and stood down — so a
     * task could licence any deletion just by mentioning one in its prose, which is exactly what a
     * model writing its own justification will do.
     */
    const title = task?.title || '';
    const text = `${title} ${task?.rationale || ''}`;
    if (!ADDITIVE.test(title) || SUBTRACTIVE.test(title)) continue;

    /*
     * Scope to what this task said it would touch, in three cases:
     *   declared files, some present  → check only those, so a cleanup task in one file cannot be
     *                                   charged to an additive task in another;
     *   declared files, none present  → this task changed nothing, so it has no intent to violate;
     *   declared nothing              → check the whole diff, since there is no narrower claim, and
     *                                   an undeclared file list is itself how #426 came to rewrite
     *                                   a route nobody expected it to touch.
     */
    const declaredAll = task?.files || [];
    const declared = declaredAll.filter((f) => byFile.has(f));
    if (declaredAll.length && !declared.length) continue;
    const scope = declared.length ? declared.map((f) => byFile.get(f)).join('\n') : diff;

    for (const name of namedIdentifiers(text)) {
      const { added, removed } = countInDiff(scope, name);
      // Removed and never added back: the task said "resolve/implement/wire this", and the change
      // made the thing it names disappear.
      if (removed >= minRemovals && added === 0) {
        violations.push({ task: task.title || '(untitled)', identifier: name, removed, added });
      }
    }
  }

  return {
    veto: violations.length > 0,
    violations,
    checked: true,
    summary: violations.length
      ? violations.map((v) => `"${v.identifier}" deleted ${v.removed}× and never re-added, by a task that said it would add or fix it`).join('; ')
      : `intent preserved across ${tasks.length} task(s)`,
  };
}

/*
 * `reviewFloorVeto` viveva qui. E' stata sostituita da `floorBreaches` in engine.js, che applica
 * la stessa regola a OGNI dimensione invece che al solo review, e la rende configurabile dalla
 * tabella kpi. Teneva un solo caso speciale cablato; ora aggiungere una soglia non richiede di
 * toccare il codice.
 */
