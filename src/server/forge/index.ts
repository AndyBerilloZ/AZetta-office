// Which forge a checkout is on, from its origin remote, and a forge for it.
import { execFileSync } from 'node:child_process';
import type { GhIssue, GhPull, GhState } from '../../shared/protocol.js';
import { GitHub } from '../github.js';
import { AzureDevOps, azureRemote } from './azure.js';
import { CompositeForge } from './composite.js';
import type { Forge, ForgeKind } from './types.js';
import { Windshift, type WindshiftConfig } from './windshift.js';

export type { Forge, ForgeKind, ForgePr, IssueSource } from './types.js';

/** Where a floor's issues live when not on its checkout's forge (see FloorDef.issues). */
export type IssuesConfig = WindshiftConfig;

/** The forge a remote URL points at: Azure DevOps for dev.azure.com and *.visualstudio.com, GitHub for everything else (gh is the office's default). */
export function forgeKindOfUrl(url: string | undefined): ForgeKind {
  return url && azureRemote(url) ? 'azure' : 'github';
}

/** The forge the checkout in `dir` is on, by its origin. */
export function forgeKindOf(dir: string): ForgeKind {
  return forgeKindOfUrl(originUrl(dir));
}

export function originUrl(dir: string): string | undefined {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const quiet = () => {};

/**
 * A floor's forge: its boards tell `onIssues` and `onPulls` whenever they change. With `issues`,
 * the issues board comes from that tracker instead, and the pull requests from the checkout's forge.
 */
export function openForge(dir: string, onIssues: (s: GhState<GhIssue>) => void, onPulls: (s: GhState<GhPull>) => void, issues?: IssuesConfig): Forge {
  const url = originUrl(dir);
  const prs = forgeKindOfUrl(url) === 'azure' ? new AzureDevOps(dir, url!, issues ? quiet : onIssues, onPulls) : new GitHub(dir, issues ? quiet : onIssues, onPulls);
  if (!issues) return prs;
  return new CompositeForge(prs, new Windshift(issues, onIssues));
}

const plain = new Map<string, Forge>();

/**
 * A forge for a checkout that isn't a floor's own (another repository of a worker across
 * repositories, a worktree in the Changes window): for pull requests only, with no boards to tell.
 */
export function forgeFor(dir: string): Forge {
  const url = originUrl(dir);
  const key = `${forgeKindOfUrl(url)}:${url ?? dir}`;
  let f = plain.get(key);
  if (!f) {
    f = forgeKindOfUrl(url) === 'azure' ? new AzureDevOps(dir, url!, quiet, quiet) : new GitHub(dir, quiet, quiet);
    plain.set(key, f);
  }
  return f;
}
