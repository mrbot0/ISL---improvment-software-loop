import { ollama } from './config.js';
import { chat as ollamaChat, toolArgs } from './ollama.js';
import {
  addMessage,
  getAgent,
  getProposal,
  listAgents,
  listMessages,
  listProposals,
  listRuns,
  updateAgent,
} from './db.js';
import { approveProposal, rejectProposal } from './apply.js';
import { orchestrator } from './orchestrator.js';
import { controller } from './core/controller.js';
import { verifyProposal } from './sandbox/verifier.js';
import { onboardingStatus, projectContextBlurb, buildContext } from './context/contextManager.js';
import { getCodeStats } from './context/codeScan.js';
import { queryIndex } from './context/knowledgeIndex.js';
import { complianceReport, runComplianceCheck } from './bestpractices/complianceManager.js';
import { reliabilityReport } from './reliability/reliabilityManager.js';
import { landedCommits } from './summary.js';
import { researchProposals } from './iteration/researcher.js';
import { listProjects, getProject } from './platform/projects.js';
import { activateProject, getActiveProject } from './platform/activeProject.js';
import { log } from './logger.js';

const SYSTEM = `
You are Alfred — the operations assistant for ISL, an autonomous software-improvement platform.
The operator talks to you to understand and steer the improvement of the ACTIVE PROJECT's code.

You can: explain what the project is and its risks; steer the agents (change focus, scope, run
them); start/stop the improvement loop; review and land proposed changes; run online feature
research; run a best-practice compliance check across all the project's languages; report what has
shipped; and switch between projects.

BEHAVIOUR
- Use your tools to read real state before answering. Never guess a proposal's status, an agent's
  scope, the loop state, or the project's languages — look it up.
- Act when the operator clearly asks you to. Ask first only when the request is ambiguous or destructive.
- approve_proposal LANDS CODE, and switch_project changes the runtime for everyone. Only call these
  when the operator explicitly asked for that exact action. If a proposal failed verification, say so
  and make them confirm before approving anyway.
- The project may be in ANY language (JavaScript, Python, Java, Go, ABAP, Apex, COBOL, …). Do not
  assume a stack — read the context and code composition.
- When you change an agent's scope/objective, restate the new value so the operator can catch a mistake.
- Be concise. The operator reads you in a sidebar, not a report. Answer in the operator's language.
`.trim();

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_status',
      description: 'Current fleet status: loop state, interval, queue, pending backlog, apply mode.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_agents',
      description: 'All agents with their objective, file scope and enabled state.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'configure_agent',
      description:
        'Change what an agent works on. Supply only the fields you want to change. ' +
        'Use this to redirect an agent ("focus on the payments routes") or park it.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent id — call list_agents to see valid ids.' },
          objective: { type: 'string', description: 'The new objective, written as an instruction to the agent.' },
          enabled: { type: 'boolean' },
          include_globs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files the agent may modify, e.g. ["backend/src/routes/stripe.js"]',
          },
          exclude_globs: { type: 'array', items: { type: 'string' } },
          max_proposals: { type: 'integer', description: 'Proposals per run, 1-5' },
        },
        required: ['agent_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_agent',
      description: 'Queue an agent to run now, optionally with a one-off instruction that overrides its objective.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string' },
          instruction: { type: 'string', description: 'Optional task for this run only.' },
        },
        required: ['agent_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'control_loop',
      description: 'Start or stop the automatic improvement loop, change its interval, or cancel the running agent.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'cancel_current'] },
          interval_seconds: { type: 'integer', description: 'Optional: set the tick interval (min 30).' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_proposals',
      description: 'List proposals, newest first. Filter by status to find what needs review.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['verifying', 'verified', 'failed', 'approved', 'rejected', 'applied', 'stale'],
          },
          agent_id: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_proposal',
      description: 'Full detail for one proposal: rationale, diff, and the verification output.',
      parameters: {
        type: 'object',
        properties: { proposal_id: { type: 'integer' } },
        required: ['proposal_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'approve_proposal',
      description:
        'APPROVE AND LAND a proposal. This writes code (commits it to a branch, or to the working tree). ' +
        'Only ever call this when the operator explicitly asked you to approve that exact proposal.',
      parameters: {
        type: 'object',
        properties: { proposal_id: { type: 'integer' }, note: { type: 'string' } },
        required: ['proposal_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reject_proposal',
      description: 'Reject a proposal with a reason. Safe — nothing is written.',
      parameters: {
        type: 'object',
        properties: { proposal_id: { type: 'integer' }, reason: { type: 'string' } },
        required: ['proposal_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reverify_proposal',
      description: 'Re-run lint and tests for a proposal in a fresh sandbox. Use after the base branch has moved.',
      parameters: {
        type: 'object',
        properties: { proposal_id: { type: 'integer' } },
        required: ['proposal_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recent_activity',
      description: 'The last few agent runs and what they concluded.',
      parameters: { type: 'object', properties: { limit: { type: 'integer' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_project_context',
      description: 'What the active project IS: profile (purpose, objective, stack, key flows), documentation status, and any open onboarding questions.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_code_composition',
      description: 'The languages in the project and their share of the code (files and lines), including proprietary languages like ABAP.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: 'Semantic search over the whole codebase (files + key symbols) AND the fleet\'s learned lessons. Use it to answer "where is X handled?", "which files touch Y?", or to ground any answer about the code in the actual architecture, ranked by relevance.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Natural-language description of what to find.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_compliance',
      description: 'Best-practice compliance: score, open violations by language, and the top findings.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_compliance_check',
      description: 'Audit the project code against best practices for every language it uses. Runs in the background.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_research',
      description: 'Search the web for the best features to add to this kind of project and land ideas in the backlog. Background.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build_context',
      description: 'Re-analyse the project documentation and rebuild the context profile and onboarding questions. Background.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_reliability',
      description: 'Fleet reliability: error clusters, anomalies and open improvement signals.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_shipped_summary',
      description: 'What has actually landed: committed improvements with totals (files, churn, score).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_projects',
      description: 'All projects ISL manages, and which one is active.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_project',
      description: 'Change the ACTIVE project (re-points the whole runtime). Refused while an iteration is running. Only when explicitly asked.',
      parameters: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
    },
  },
];

const J = (v) => JSON.stringify(v, null, 1);

const HANDLERS = {
  get_status: () => J(controller.state()),

  list_agents: () =>
    J(
      listAgents().map((a) => ({
        id: a.id,
        name: a.name,
        enabled: a.enabled,
        objective: a.objective,
        include: a.scope.include,
        exclude: a.scope.exclude,
        maxProposals: a.maxProposals,
      })),
    ),

  configure_agent: ({ agent_id, objective, enabled, include_globs, exclude_globs, max_proposals }) => {
    if (!getAgent(agent_id)) return `Unknown agent: ${agent_id}`;
    const patch = {};
    if (objective !== undefined) patch.objective = objective;
    if (enabled !== undefined) patch.enabled = !!enabled;
    if (max_proposals !== undefined) patch.maxProposals = Math.min(5, Math.max(1, max_proposals));
    if (include_globs || exclude_globs) {
      patch.scope = {};
      if (include_globs) patch.scope.include = include_globs;
      if (exclude_globs) patch.scope.exclude = exclude_globs;
    }
    if (!Object.keys(patch).length) return 'Nothing to change — no fields supplied.';
    const a = updateAgent(agent_id, patch);
    return `Updated. ${J({ id: a.id, enabled: a.enabled, objective: a.objective, scope: a.scope, maxProposals: a.maxProposals })}`;
  },

  run_agent: ({ agent_id, instruction }) => {
    if (!getAgent(agent_id)) return `Unknown agent: ${agent_id}`;
    const r = orchestrator.enqueue(agent_id, { trigger: 'chat', instruction: instruction || null });
    return `Queued ${agent_id} at position ${r.position}.${instruction ? ` Instruction: "${instruction}"` : ''}`;
  },

  // One loop, one switch — this drives the unified pipeline, not a second engine.
  control_loop: ({ action, interval_seconds }) => {
    if (interval_seconds) controller.setInterval(interval_seconds);
    if (action === 'start') return J(controller.start());
    if (action === 'stop') return J(controller.stop());
    if (action === 'cancel_current') return J(controller.cancel());
    return `Unknown action: ${action}`;
  },

  list_proposals: ({ status, agent_id }) => {
    const rows = listProposals({ status, agentId: agent_id, limit: 25 });
    if (!rows.length) return 'No proposals match.';
    return J(
      rows.map((p) => ({
        id: p.id,
        agent: p.agentId,
        status: p.status,
        severity: p.severity,
        title: p.title,
        files: p.paths,
        churn: `+${p.additions}/-${p.deletions}`,
      })),
    );
  },

  get_proposal: ({ proposal_id }) => {
    const p = getProposal(proposal_id);
    if (!p) return `No such proposal: ${proposal_id}`;
    const v = p.verification;
    return J({
      id: p.id,
      agent: p.agentId,
      status: p.status,
      severity: p.severity,
      title: p.title,
      rationale: p.rationale,
      files: p.paths,
      churn: `+${p.additions}/-${p.deletions}`,
      verification: v
        ? { ok: v.ok, skipped: v.skipped ?? false, checks: v.checks?.map((c) => ({ name: c.name, ok: c.ok })) }
        : null,
      failureOutput: v?.checks?.find((c) => !c.ok)?.output?.slice(-1500) ?? null,
      diff: p.diff.length > 6000 ? `${p.diff.slice(0, 6000)}\n…[diff truncated, open it in the dashboard]` : p.diff,
    });
  },

  approve_proposal: ({ proposal_id, note }) => {
    const p = getProposal(proposal_id);
    if (!p) return `No such proposal: ${proposal_id}`;
    try {
      const r = approveProposal(proposal_id, { note: note || 'approved via chat' });
      return `Approved and landed #${proposal_id} → ${r.apply.ref} (mode: ${r.apply.mode}).`;
    } catch (err) {
      return `Could not approve #${proposal_id}: ${err.message}`;
    }
  },

  reject_proposal: ({ proposal_id, reason }) => {
    if (!getProposal(proposal_id)) return `No such proposal: ${proposal_id}`;
    rejectProposal(proposal_id, reason || 'rejected via chat');
    return `Rejected #${proposal_id}.`;
  },

  reverify_proposal: async ({ proposal_id }) => {
    if (!getProposal(proposal_id)) return `No such proposal: ${proposal_id}`;
    const v = await verifyProposal(proposal_id);
    return `Re-verified #${proposal_id}: ${v.ok ? 'PASS' : 'FAIL'}. ${J(v.checks?.map((c) => ({ [c.name]: c.ok })) ?? [])}`;
  },

  recent_activity: ({ limit = 8 }) =>
    J(
      listRuns(Math.min(20, limit)).map((r) => ({
        run: r.id,
        agent: r.agentId,
        status: r.status,
        trigger: r.trigger,
        steps: r.steps,
        summary: r.summary?.slice(0, 300),
      })),
    ),

  get_project_context: () => {
    const s = onboardingStatus();
    return J({
      profile: s.profile,
      documents: s.documents,
      pendingQuestions: s.pending,
      openQuestions: s.questions.filter((q) => !q.answer).map((q) => q.question),
    });
  },

  search_knowledge: async ({ query }) => {
    if (!query || !String(query).trim()) return 'query is required';
    const { results, mode } = await queryIndex(String(query), { k: 8 });
    if (!results?.length) return `No matches for "${query}".`;
    return J({
      mode,
      results: results.map((r) => ({
        kind: r.kind,
        title: r.title,
        symbols: r.symbols?.slice(0, 6),
        snippet: r.kind === 'memory' ? r.snippet : undefined,
        score: r.score,
      })),
    });
  },

  get_code_composition: () => {
    const cs = getCodeStats();
    if (!cs) return 'No code scan yet — run build_context first.';
    return J({
      files: cs.totalFiles,
      lines: cs.totalLines,
      languages: cs.byLanguage.filter((l) => l.pct != null).map((l) => ({ language: l.lang, pct: l.pct, lines: l.lines })),
    });
  },

  get_compliance: () => {
    const r = complianceReport();
    return J({
      score: r.lastRun?.score ?? null,
      openViolations: r.openViolations,
      byLanguage: r.byLanguage,
      top: r.findings.slice(0, 8).map((f) => ({ language: f.language, severity: f.severity, title: f.title, file: f.relPath })),
    });
  },

  run_compliance_check: () => {
    runComplianceCheck({}).catch((e) => log.error('chat', `compliance check failed: ${e.message}`));
    return 'Started a best-practice compliance check across the project languages. It runs in the background; ask get_compliance shortly.';
  },

  run_research: () => {
    researchProposals({ count: 8 }).catch((e) => log.error('chat', `research failed: ${e.message}`));
    return 'Started online feature research (incl. similar apps, frontend & backend). Idea proposals will appear on the Proposals page shortly.';
  },

  build_context: () => {
    buildContext({ force: true }).catch((e) => log.error('chat', `context build failed: ${e.message}`));
    return 'Rebuilding the project context from its documentation. Ask get_project_context shortly.';
  },

  get_reliability: () => {
    const r = reliabilityReport();
    return J({
      errors24h: r.errors24h,
      clusters: r.clusters.slice(0, 6).map((c) => ({ count: c.count, sample: c.sample?.slice(0, 100) })),
      anomalies: r.anomalies.slice(0, 6).map((a) => ({ kind: a.kind, message: a.message })),
      signals: r.signals.slice(0, 6).map((s) => s.recommendation),
    });
  },

  get_shipped_summary: () => {
    const { commits, totals } = landedCommits({ limit: 60 });
    return J({
      totals,
      recent: commits.slice(0, 10).map((c) => ({ sha: c.sha, title: c.title, score: c.score, churn: `+${c.additions}/-${c.deletions}` })),
    });
  },

  list_projects: () =>
    J({
      active: getActiveProject()?.project?.id ?? null,
      projects: listProjects({ includeArchived: false }).map((p) => ({ id: p.id, name: p.name, path: p.codePath, contextReady: p.contextReady })),
    }),

  switch_project: ({ project_id }) => {
    if (!getProject(project_id)) return `Unknown project: ${project_id}`;
    if (controller.state().running) return 'An iteration is running — cancel it before switching projects.';
    const wasRunning = controller.desiredRunning === true || controller.state().looping;
    controller.stop({ persist: false }); // incidental stop for the DB swap, not an operator stop
    const active = activateProject(project_id);
    if (wasRunning) controller.start();
    return `Switched active project to ${active.project.name} (${active.config.repoRoot}).`;
  },
};

/**
 * Handle one operator turn. Streams assistant tokens through `onToken` and
 * surfaces each tool call through `onTool` so the UI can show what it did.
 */
export async function handleChatTurn(userText, { images = [], onToken, onTool, signal } = {}) {
  addMessage('user', userText, images.length ? { images: images.length } : {});

  // Replay a SHORT recent history — enough for continuity, small enough to keep
  // the prompt (and therefore the first-token latency) low. Alfred is a fast
  // command surface, not a long conversation.
  const history = listMessages(10)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  const ctx = projectContextBlurb();
  const messages = [{ role: 'system', content: ctx ? `${SYSTEM}\n\n${ctx}` : SYSTEM }, ...history];

  // Attach imported images to the current (last) user message. Ollama expects
  // raw base64 (no data: prefix). Only vision-capable chat models will use them.
  if (images.length) {
    const stripped = images.map((s) => String(s).replace(/^data:[^;]+;base64,/, ''));
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        messages[i] = { ...messages[i], images: stripped };
        break;
      }
    }
  }
  const usedTools = [];

  for (let step = 0; step < 6; step++) {
    const { content, toolCalls } = await ollamaChat({
      messages,
      tools: TOOLS,
      model: ollama.chatModel,
      think: false, // the operator wants an answer, not a monologue
      temperature: 0.4,
      // Alfred's turns are short and tool-driven; a small context window makes
      // prompt processing markedly faster than the 32k the iteration engine uses.
      numCtx: 4096,
      signal,
      onToken: (t, kind) => kind === 'content' && onToken?.(t),
    });

    messages.push({ role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });

    if (!toolCalls.length) {
      const answer = content.trim();
      addMessage('assistant', answer, { tools: usedTools });
      return { content: answer, tools: usedTools };
    }

    for (const call of toolCalls) {
      const name = call.function?.name;
      const args = toolArgs(call);
      onTool?.({ name, args });
      usedTools.push({ name, args });

      let result;
      try {
        result = HANDLERS[name] ? await HANDLERS[name](args) : `Unknown tool: ${name}`;
      } catch (err) {
        result = `Error: ${err.message}`;
      }
      messages.push({ role: 'tool', tool_name: name, content: String(result) });
    }
  }

  const fallback = 'I hit the tool-call limit for this turn. Ask me again, more narrowly.';
  addMessage('assistant', fallback, { tools: usedTools });
  return { content: fallback, tools: usedTools };
}

export { TOOLS as CHAT_TOOLS };
