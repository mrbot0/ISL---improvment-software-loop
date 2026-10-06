import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, WORKTREE_DIR, autonomy } from './config.js';
import { emit } from './bus.js';
import { getProposal, getSetting, setProposalStatus } from './db.js';
import { git, headCommit, removeWorktree } from './sandbox/worktree.js';
import { log } from './logger.js';

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'change';

export const applyMode = () => getSetting('applyMode', autonomy.applyMode);

/**
 * Land an approved proposal.
 *
 * `branch` (default) commits onto a dedicated branch via a throwaway worktree, so
 * the user's working tree and current branch are never disturbed. `direct` writes
 * straight into the working tree and leaves the change uncommitted.
 */
export function applyProposal(proposalId, { mode = applyMode() } = {}) {
  const p = getProposal(proposalId, { withFiles: true });
  if (!p) throw new Error(`No such proposal: ${proposalId}`);
  if (p.status !== 'approved') throw new Error(`Proposal ${proposalId} is '${p.status}', expected 'approved'`);

  try {
    const ref = mode === 'direct' ? applyDirect(p) : applyOnBranch(p);
    setProposalStatus(proposalId, 'applied', { appliedRef: ref });
    emit('proposal.applied', { proposalId, agentId: p.agentId, title: p.title, ref, mode });
    log.info('apply', `landed #${proposalId} "${p.title}" → ${ref} (${mode})`, { agentId: p.agentId });
    return { ok: true, ref, mode };
  } catch (err) {
    setProposalStatus(proposalId, 'apply_failed', { reviewNote: err.message });
    emit('proposal.apply_failed', { proposalId, agentId: p.agentId, error: err.message });
    log.error('apply', `could not land #${proposalId}: ${err.message}`, { agentId: p.agentId });
    throw err;
  }
}

function applyDirect(p) {
  for (const f of p.files) {
    const target = path.join(REPO_ROOT, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.newContent, 'utf8');
  }
  return 'working-tree';
}

function applyOnBranch(p) {
  const branch = `agents/${p.agentId}-${p.id}-${slug(p.title)}`;
  const base = p.baseCommit || headCommit();
  const dir = path.join(WORKTREE_DIR, `apply-${p.id}-${Date.now()}`);

  fs.mkdirSync(WORKTREE_DIR, { recursive: true });
  git(['worktree', 'add', '--quiet', '-b', branch, dir, base]);
  try {
    for (const f of p.files) {
      const target = path.join(dir, f.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.newContent, 'utf8');
    }
    git(['add', '--', ...p.files.map((f) => f.path)], dir);

    const body = [
      p.title,
      '',
      p.rationale,
      '',
      `Proposed by the ${p.agentId} agent (proposal #${p.id}), verified against the test suite.`,
      '',
      'Co-Authored-By: RentAll Agents <agents@rentall.local>',
    ].join('\n');
    git(['commit', '--quiet', '-m', body], dir);
  } catch (err) {
    removeWorktree(dir);
    try {
      git(['branch', '-D', branch]); // don't leave a half-made branch behind
    } catch {
      /* branch may not exist yet */
    }
    throw err;
  }
  removeWorktree(dir);
  return branch;
}

export function rejectProposal(proposalId, note = '') {
  const p = setProposalStatus(proposalId, 'rejected', { reviewNote: note });
  emit('proposal.rejected', { proposalId, agentId: p.agentId, title: p.title, note });
  return p;
}

export function approveProposal(proposalId, { note = '', autoApply = true } = {}) {
  const cur = getProposal(proposalId);
  if (!cur) throw new Error(`No such proposal: ${proposalId}`);
  if (!['verified', 'failed'].includes(cur.status)) {
    throw new Error(`Proposal ${proposalId} is '${cur.status}' and cannot be approved`);
  }
  setProposalStatus(proposalId, 'approved', { reviewNote: note });
  emit('proposal.approved', { proposalId, agentId: cur.agentId, title: cur.title, note, wasVerified: cur.status === 'verified' });
  return autoApply ? { ...getProposal(proposalId), apply: applyProposal(proposalId) } : getProposal(proposalId);
}
