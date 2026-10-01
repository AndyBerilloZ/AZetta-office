// A workspace floor's checkouts (see FloorDef.repos): the floor is a folder holding several projects
// side by side rather than one checkout, and its workers get a worktree of each.
import path from 'node:path';
import { normalizeRepo } from '../shared/floors.js';

/** One checkout inside a workspace floor. */
export interface SubRepo {
  /** Its folder's name, as the worker sees it in its workspace ("specs"). */
  name: string;
  /** owner/name on GitHub, when it's there. */
  repo?: string;
  /** The checkout, absolute. */
  dir: string;
  /** The branch worktrees are cut from and pull requests go to ("develop"); else the one the checkout is on. */
  base?: string;
}

/** The checkout a floor's branch and worktrees come from: the floor itself, or a workspace floor's first project. */
export function primaryDir(def: { dir: string; repos?: SubRepo[] }): string {
  return def.repos?.[0]?.dir ?? def.dir;
}

/** The checkouts of a workspace floor as floors.json names them, dropping anything that isn't a folder of its own. */
export function validSubRepos(raw: unknown, floorDir: string): SubRepo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const repos: SubRepo[] = [];
  for (const r of raw) {
    const dir = typeof r?.dir === 'string' && r.dir ? path.resolve(floorDir, r.dir) : undefined;
    const name = typeof r?.name === 'string' && r.name ? r.name.slice(0, 64) : dir && path.basename(dir);
    if (!dir || !name || seen.has(name.toLowerCase()) || path.resolve(dir) === path.resolve(floorDir)) continue;
    seen.add(name.toLowerCase());
    const base = typeof r.base === 'string' && /^[\w./-]{1,200}$/.test(r.base) && !r.base.startsWith('-') ? r.base : undefined;
    repos.push({ name, repo: normalizeRepo(r.repo), dir, base });
  }
  return repos.length ? repos : undefined;
}
