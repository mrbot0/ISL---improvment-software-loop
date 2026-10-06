import fs from 'node:fs';
import { pdb, audit } from './platformDb.js';
import { DEFAULT_PROJECT, projectDataDir } from '../config.js';

const now = () => Date.now();

/** Turn a name into a filesystem/URL-safe unique id. */
export function slugify(name) {
  const base =
    String(name || 'project')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project';
  let id = base;
  let n = 1;
  while (pdb.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) id = `${base}-${++n}`;
  return id;
}

const rowToProject = (r) =>
  r && {
    id: r.id,
    name: r.name,
    codePath: r.code_path,
    baseBranch: r.base_branch,
    description: r.description,
    color: r.color,
    archived: !!r.archived,
    contextReady: !!r.context_ready,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

export function listProjects({ includeArchived = false } = {}) {
  const rows = includeArchived
    ? pdb.prepare('SELECT * FROM projects ORDER BY created_at').all()
    : pdb.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY created_at').all();
  return rows.map(rowToProject);
}

export function getProject(id) {
  return rowToProject(pdb.prepare('SELECT * FROM projects WHERE id = ?').get(id));
}

export function createProject({ name, codePath, baseBranch = null, description = '', color = 'brand', createdBy = 'system' }) {
  if (!name?.trim()) throw new Error('Project name is required');
  if (!codePath?.trim()) throw new Error('Code path is required');
  const abs = codePath.trim();
  if (!fs.existsSync(abs)) throw new Error(`Code path does not exist: ${abs}`);
  if (!fs.statSync(abs).isDirectory()) throw new Error(`Code path is not a directory: ${abs}`);
  const id = slugify(name);
  pdb.prepare(
    `INSERT INTO projects (id, name, code_path, base_branch, description, color, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name.trim(), abs, baseBranch || null, description || '', color || 'brand', createdBy, now(), now());
  fs.mkdirSync(projectDataDir(id), { recursive: true });
  audit('project.created', { actor: createdBy, target: id, detail: { name, codePath: abs } });
  return getProject(id);
}

export function updateProject(id, patch = {}) {
  const cur = getProject(id);
  if (!cur) throw new Error(`Unknown project: ${id}`);
  if (patch.codePath) {
    if (!fs.existsSync(patch.codePath)) throw new Error(`Code path does not exist: ${patch.codePath}`);
  }
  const next = {
    name: patch.name ?? cur.name,
    code_path: patch.codePath ?? cur.codePath,
    base_branch: patch.baseBranch !== undefined ? patch.baseBranch : cur.baseBranch,
    description: patch.description ?? cur.description,
    color: patch.color ?? cur.color,
    archived: patch.archived !== undefined ? (patch.archived ? 1 : 0) : cur.archived ? 1 : 0,
    context_ready: patch.contextReady !== undefined ? (patch.contextReady ? 1 : 0) : cur.contextReady ? 1 : 0,
  };
  pdb.prepare(
    `UPDATE projects SET name = ?, code_path = ?, base_branch = ?, description = ?, color = ?,
       archived = ?, context_ready = ?, updated_at = ? WHERE id = ?`,
  ).run(next.name, next.code_path, next.base_branch, next.description, next.color, next.archived, next.context_ready, now(), id);
  audit('project.updated', { target: id, detail: patch });
  return getProject(id);
}

export function markContextReady(id, ready = true) {
  pdb.prepare('UPDATE projects SET context_ready = ?, updated_at = ? WHERE id = ?').run(ready ? 1 : 0, now(), id);
  return getProject(id);
}

export function archiveProject(id) {
  return updateProject(id, { archived: true });
}

/**
 * Ensure at least one project exists. On a fresh install we seed the default
 * project pointing at DEFAULT_PROJECT.codePath (see config.js: the folder named
 * by DEFAULT_PROJECT_PATH, otherwise the directory ISL was started from). If that
 * folder is missing we still create the row — the operator can repoint it — so the
 * app always boots with a selectable project.
 */
export function ensureDefaultProject() {
  const existing = listProjects({ includeArchived: true });
  if (existing.length) return existing[0];
  const codePath = fs.existsSync(DEFAULT_PROJECT.codePath) ? DEFAULT_PROJECT.codePath : process.cwd();
  const id = 'default';
  pdb.prepare(
    `INSERT INTO projects (id, name, code_path, base_branch, description, color, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, DEFAULT_PROJECT.name, codePath, null, 'Seeded default project', 'brand', 'system', now(), now());
  fs.mkdirSync(projectDataDir(id), { recursive: true });
  audit('project.seeded', { target: id, detail: { codePath } });
  return getProject(id);
}
