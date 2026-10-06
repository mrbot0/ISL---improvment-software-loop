import { MAX_AGENT_STEPS, TOOL_HISTORY_BUDGET } from '../config.js';
import { createPlan, createProposal, createRun, finishRun, getAgentLessons, getAgentPlaybooks, linkPlanProposal } from '../db.js';
import { emit } from '../bus.js';
import { chat, toolArgs } from '../ollama.js';
import { TOOL_SCHEMAS, buildDiff, makeTools } from '../tools/index.js';
import { headCommit } from '../sandbox/worktree.js';
import { verifyFiles } from '../sandbox/verifier.js';
import { llmText } from '../iteration/llm.js';
import { fleetContextBlurb } from '../context/contextAgent.js';
import { memoryBlurb } from '../memory/memoryDb.js';
import { log } from '../logger.js';

/**
 * Run one agent to completion.
 *
 * The loop is a standard ReAct cycle: the model calls tools, we execute them and
 * feed observations back. Proposals are buffered by the tool layer and only turned
 * into DB rows once the run ends cleanly — a crashed run leaves no half-state.
 *
 * @returns {Promise<{runId:number, summary:string, proposalIds:number[], steps:number}>}
 */
export async function runAgent(agent, { trigger = 'loop', instruction = null, signal } = {}) {
  const runId = createRun(agent.id, trigger, instruction);
  emit('agent.started', { runId, agentId: agent.id, agentName: agent.name, trigger, instruction });
  log.info(agent.id, `run #${runId} started (${trigger})${instruction ? `: ${instruction}` : ''}`, { agentId: agent.id, runId });

  const base = headCommit();
  const tools = makeTools({
    scope: agent.scope,
    agentId: agent.id,
    runId,
    maxProposals: agent.maxProposals,
    verifyBudget: 3,
    verifyFiles: (files) => {
      emit('verify.started', { runId, agentId: agent.id, paths: files.map((f) => f.path), inline: true });
      return verifyFiles(files, {
        baseCommit: base,
        onProgress: (p) => emit('verify.progress', { runId, agentId: agent.id, inline: true, ...p }),
      }).then((v) => {
        emit('verify.finished', { runId, agentId: agent.id, ok: v.ok, inline: true, failed: v.checks?.find((c) => !c.ok)?.name ?? null });
        return v;
      });
    },
    critiqueBudget: 2,
    critique: async (diff) => {
      emit('agent.critique', { runId, agentId: agent.id });
      log.info(agent.id, 'requesting red-team critique of draft', { agentId: agent.id, runId });
      const { text } = await llmText({
        system:
          'You are a rigorous senior reviewer red-teaming a proposed code change to RentAll ' +
          '(Express + Prisma backend, React frontend). Find real problems only — do not nitpick style. ' +
          'Check, in order: (1) correctness bugs, (2) does it break any caller/route/export, ' +
          '(3) does it match existing conventions, (4) is it over-reaching beyond its stated goal, ' +
          '(5) security. Reply with a short numbered list of concrete concerns, most serious first. ' +
          'If the change is genuinely sound, say "No blocking concerns." Be terse.',
        user: `Review this diff:\n\n${diff.slice(0, 12000)}`,
        temperature: 0.2,
        signal,
      });
      return text.trim();
    },
    onProposal: (path) => emit('agent.proposal_drafted', { runId, agentId: agent.id, path }),
    onVerify: (paths) => log.info(agent.id, `self-verifying ${paths.join(', ')}`, { agentId: agent.id, runId }),
    onPlan: (p) => {
      emit('agent.plan', { runId, agentId: agent.id, title: p.title, criticality: p.criticality });
      // Extended, structured logging of the decision: the critical task + weighed trade-offs.
      log.info(agent.id, `PLAN [${p.criticality}] ${p.title}`, { agentId: agent.id, runId, data: { approach: p.approach, files: p.files, pros: p.pros, cons: p.cons, risks: p.risks } });
      log.debug(agent.id, `plan trade-offs — pros: ${p.pros.join('; ')} | cons: ${p.cons.join('; ')}`, { agentId: agent.id, runId });
    },
  });

  // Reflection: fold in what this agent has learned from past rejections/failures,
  // and the patterns that have actually landed (playbooks).
  const lessons = getAgentLessons(agent.id);
  const playbooks = getAgentPlaybooks(agent.id);
  const lessonBlock =
    (playbooks.length
      ? `\n\nWHAT HAS WORKED (changes of yours that were approved — lean into these patterns):\n${playbooks.map((p) => `- ${p}`).join('\n')}`
      : '') +
    (lessons.length
      ? `\n\nRECENT LESSONS (from your past rejections/failures — do not repeat these mistakes):\n${lessons.map((l) => `- ${l}`).join('\n')}`
      : '');

  const ctxBlurb = fleetContextBlurb();
  const memBlurb = memoryBlurb({ agentId: agent.id });
  const messages = [
    { role: 'system', content: agent.systemPrompt + lessonBlock + (ctxBlurb ? `\n\n${ctxBlurb}` : '') + (memBlurb ? `\n\n${memBlurb}` : '') },
    {
      role: 'user',
      content: [
        `Your objective for this run:`,
        agent.objective,
        instruction ? `\nThe operator has given you a specific instruction, which overrides the objective above:\n${instruction}` : '',
        `\nWorkflow: orient (list_files/outline) → gather evidence (read_file/search_code/find_references) → ` +
          `pick the single most CRITICAL improvement and commit to it with submit_plan (weighing pros & cons) → ` +
          `implement with stage_edit → prove it with verify_change → get a second opinion with critique_change → finish.`,
        `You may propose at most ${agent.maxProposals} change(s). Plan before you act; verify before you propose.`,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];

  let steps = 0;
  let nudges = 0;
  let summary = null;
  let error = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let llmCalls = 0;

  try {
    while (steps < MAX_AGENT_STEPS) {
      if (signal?.aborted) throw new Error('cancelled');
      steps++;

      const { content, thinking, toolCalls, usage } = await chat({
        messages,
        tools: TOOL_SCHEMAS,
        think: true,
        signal,
        onToken: (text, kind) => emit('agent.token', { runId, agentId: agent.id, text, kind }),
      });
      llmCalls++;
      tokensIn += usage?.promptTokens || 0;
      tokensOut += usage?.evalTokens || 0;

      // Keep the assistant turn in history so the model sees its own tool calls.
      messages.push({ role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      if (thinking) emit('agent.thought', { runId, agentId: agent.id, thinking: thinking.slice(0, 4000) });

      if (!toolCalls.length) {
        // No tool call this turn. If the model actually said something, treat it
        // as its closing summary. But a thinking-enabled model often ends a turn
        // with reasoning and empty content — ending there would waste the whole
        // run. Nudge it once or twice to commit to finish() or propose_change.
        if (content.trim()) {
          summary = content.trim();
          break;
        }
        if (nudges++ < 2) {
          emit('agent.nudged', { runId, agentId: agent.id, nudge: nudges });
          messages.push({
            role: 'user',
            content:
              'You did not call a tool. You must now either call propose_change with a concrete ' +
              'improvement, or call finish(summary) describing what you examined and why nothing ' +
              'needs changing. Do not reply in prose — call one of those tools.',
          });
          continue;
        }
        summary = 'Run ended without a decision after repeated nudges.';
        break;
      }

      let finished = false;
      for (const call of toolCalls) {
        const name = call.function?.name;
        const args = toolArgs(call);
        emit('agent.tool_call', { runId, agentId: agent.id, tool: name, args: preview(args) });
        if (name === 'propose_change')
          log.info(agent.id, `proposing change to ${args.path}: ${args.title}`, { agentId: agent.id, runId });

        const fn = tools[name];
        let observation;
        if (!fn || name.startsWith('__')) {
          observation = `Unknown tool: ${name}. Available: ${TOOL_SCHEMAS.map((t) => t.function.name).join(', ')}`;
        } else {
          try {
            observation = await fn(args);
          } catch (err) {
            // Tool errors are observations, not failures — the model can recover.
            observation = `Error: ${err.message}`;
          }
        }

        if (typeof observation === 'string' && observation.startsWith('__FINISH__')) {
          summary = observation.slice('__FINISH__'.length);
          finished = true;
          observation = 'Run complete.';
        }

        emit('agent.tool_result', { runId, agentId: agent.id, tool: name, result: String(observation).slice(0, 600) });
        messages.push({ role: 'tool', tool_name: name, content: String(observation) });
      }
      compactHistory(messages);
      if (finished) break;
    }

    if (summary === null) summary = `Stopped after reaching the ${MAX_AGENT_STEPS}-step limit.`;
  } catch (err) {
    error = err.message;
    emit('agent.error', { runId, agentId: agent.id, error: err.message });
    log.error(agent.id, `run #${runId} failed: ${err.message}`, { agentId: agent.id, runId });
  }

  // Persist whatever the agent drafted, even if the loop later errored.
  const drafted = tools.__collect();
  const proposalIds = [];

  // Persist the implementation plan (the critical task + weighed trade-offs).
  const draftedPlan = tools.__plan?.();
  let planId = null;
  if (draftedPlan) {
    planId = createPlan({ runId, agentId: agent.id, ...draftedPlan });
  }

  for (const d of drafted) {
    const { diff, additions, deletions } = buildDiff([d]);
    const id = createProposal({
      runId,
      agentId: agent.id,
      title: d.title,
      rationale: d.rationale,
      severity: d.severity,
      confidence: d.confidence ?? null,
      files: [{ path: d.path, newContent: d.newContent, oldContent: d.oldContent, isNew: d.isNew }],
      diff,
      additions,
      deletions,
      baseCommit: base,
    });
    proposalIds.push(id);
    if (planId) linkPlanProposal(planId, id);
    emit('proposal.created', {
      runId,
      agentId: agent.id,
      proposalId: id,
      title: d.title,
      severity: d.severity,
      path: d.path,
      additions,
      deletions,
    });
  }

  finishRun(runId, { status: error ? 'error' : 'done', summary, error, steps, tokensIn, tokensOut, llmCalls });
  if (!error)
    log.info(agent.id, `run #${runId} done · ${proposalIds.length} proposal(s) · ${steps} steps · ${tokensIn + tokensOut} tokens`, {
      agentId: agent.id,
      runId,
    });
  emit('agent.finished', {
    runId,
    agentId: agent.id,
    agentName: agent.name,
    status: error ? 'error' : 'done',
    summary,
    error,
    steps,
    tokensIn,
    tokensOut,
    llmCalls,
    proposals: proposalIds.length,
  });

  return { runId, summary, proposalIds, steps, error, tokensIn, tokensOut, llmCalls };
}

/**
 * Keep the transcript inside the model's context window.
 *
 * A run that reads eight files accumulates far more tool output than num_ctx can
 * hold. Ollama would silently truncate the *front* of the conversation — the system
 * prompt and the objective — leaving an agent that has forgotten its own rules.
 * Eliding the oldest observations instead keeps the instructions intact and costs
 * only stale file contents the model has already reasoned about.
 *
 * The three most recent observations are always preserved: the model is usually
 * mid-thought about them.
 */
function compactHistory(messages) {
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  let total = toolIdx.reduce((n, i) => n + messages[i].content.length, 0);
  if (total <= TOOL_HISTORY_BUDGET) return;

  for (const i of toolIdx.slice(0, -3)) {
    if (total <= TOOL_HISTORY_BUDGET) break;
    const msg = messages[i];
    if (msg.elided) continue;
    const placeholder = `[observation from ${msg.tool_name}() elided to stay within the context window — re-read the file if you still need it]`;
    total -= msg.content.length - placeholder.length;
    msg.content = placeholder;
    msg.elided = true;
  }
}

/** Tool args go to the UI — keep giant file bodies out of the event stream. */
function preview(args) {
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    out[k] = typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}… (${v.length} chars)` : v;
  }
  return out;
}
