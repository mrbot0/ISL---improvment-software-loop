import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/db_iteration.js';
import { openProjectDb } from '../src/db.js';
import {
  replaceQuestions,
  listQuestions,
  answerQuestion,
  countPendingQuestions,
  clearAllContext,
} from '../src/context/contextDb.js';

/**
 * THE ONE THING IN THIS SUBSYSTEM THAT CANNOT BE RE-DERIVED.
 *
 * Everything the Context Manager knows it read from the project: the profile comes from the docs,
 * the areas from the directories, the risks from the corpus. Rebuild it and you get it all back.
 *
 * Except the answers. A question is marked `pending` precisely *because* the documentation does
 * not answer it — that is what the prompt instructs ("Only if the answer is genuinely NOT
 * derivable ... set source:pending"). So when an operator types "a booking may never overlap
 * another for the same listing", that sentence exists nowhere else: not in the docs, not in the
 * code, not in the model's weights. It then flows into every planner, implementer and reviewer
 * prompt through `projectContextBlurb()`'s "Known constraints" block.
 *
 * `replaceQuestions()` opened with an unconditional `DELETE FROM context_questions` and re-inserted
 * only the model's fresh rows — whose answers are null by construction. Pressing "Build context"
 * a second time, or asking the chat assistant to refresh it, therefore destroyed the operator's
 * work and silently removed the constraints block from every agent prompt. Neither the dashboard
 * button nor the chat tool warns, and nothing else holds a copy.
 *
 * These tests pin the rule: a rebuild may replace what the model produced, never what a human typed.
 */

before(() => {
  openProjectDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isl-questions-')), 'p.sqlite'));
});

// A human answer is deliberately immortal — it survives any rebuild — so it survives into the next
// test too. Each case needs a clean table, or it inherits the previous one's answered questions.
beforeEach(() => clearAllContext());

/** The model's output: the same three questions it derives from an unchanged project, all unanswered. */
const GENERATED = [
  { question: 'What are the non-negotiable invariants?', answer: null, source: 'pending', rationale: 'Not stated in the docs.' },
  { question: 'Who are the primary users?', answer: null, source: 'pending', rationale: 'Not stated in the docs.' },
  { question: 'What is the deployment target?', answer: null, source: 'pending', rationale: 'Not stated in the docs.' },
];

test('a rebuild keeps the answer a human typed', () => {
  replaceQuestions(GENERATED);
  assert.equal(countPendingQuestions(), 3);

  const invariants = listQuestions().find((q) => q.question.startsWith('What are the non-negotiable'));
  answerQuestion(invariants.id, 'A booking may never overlap another for the same listing.');
  assert.equal(countPendingQuestions(), 2, 'answering one question should leave two gaps');

  // The operator presses "Build context" again. The project has not changed, so the model returns
  // the very same questions, unanswered.
  replaceQuestions(GENERATED);

  const after = listQuestions().find((q) => q.question.startsWith('What are the non-negotiable'));
  assert.match(after.answer || '', /may never overlap/, 'the human answer must survive the rebuild');
  assert.equal(after.source, 'user', 'and must still be attributed to the human');
  assert.equal(countPendingQuestions(), 2, 'a rebuild must not reopen a gap the operator closed');
});

test('an answered question the model stops asking is not thrown away', () => {
  replaceQuestions(GENERATED);
  const target = listQuestions().find((q) => q.question.startsWith('What is the deployment target'));
  answerQuestion(target.id, 'Managed Kubernetes, blue-green.');

  // A later build drops that question — a reworded corpus, a different model, a shorter list.
  // Dropping the question is the model's prerogative; dropping the answer is data loss.
  replaceQuestions(GENERATED.slice(0, 2));

  const kept = listQuestions().find((q) => q.question.startsWith('What is the deployment target'));
  assert.ok(kept, 'a question carrying a human answer must be retained');
  assert.match(kept.answer, /blue-green/);
  assert.equal(kept.source, 'user');
});

test('the model may freely revise anything the human has not answered', () => {
  replaceQuestions(GENERATED);

  // Nothing was answered, so a new build owes the previous set nothing.
  replaceQuestions([{ question: 'What compliance regime applies?', answer: 'GDPR', source: 'auto', rationale: 'Stated in docs/privacy.md.' }]);

  const qs = listQuestions();
  assert.equal(qs.length, 1, 'unanswered questions should not accumulate across rebuilds');
  assert.equal(qs[0].question, 'What compliance regime applies?');
  assert.equal(qs[0].source, 'auto');
  assert.equal(countPendingQuestions(), 0, 'an auto-answered question is not a gap');
});

test('a model answer never overwrites a human one', () => {
  replaceQuestions(GENERATED);
  const users = listQuestions().find((q) => q.question.startsWith('Who are the primary users'));
  answerQuestion(users.id, 'Property managers, not tenants.');

  // The model now believes it can answer this itself, and is wrong in a way only the operator knows.
  replaceQuestions([{ ...GENERATED[1], answer: 'End consumers browsing listings.', source: 'auto', rationale: 'Inferred from the landing page.' }]);

  const after = listQuestions().find((q) => q.question.startsWith('Who are the primary users'));
  assert.match(after.answer, /Property managers/, 'the human answer outranks the model guess');
  assert.equal(after.source, 'user');
});
