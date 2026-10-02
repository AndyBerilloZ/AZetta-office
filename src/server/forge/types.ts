// A forge: where a project's issues and pull requests live (GitHub, Azure DevOps…). Every floor has
// one, found from its checkout's origin (see forge/index.ts), and the boards, the PR and issue windows,
// O at a desk and the Changes window all go through it, so the client never knows which it is.
import type { GhCloseReason, GhComment, GhIssue, GhIssueDetail, GhLabel, GhMergeMethod, GhPull, GhPullDetail, GhRepoInfo, GhState } from '../../shared/protocol.js';
import type { GhAs } from '../signins.js';

export type ForgeKind = 'github' | 'azure';

/** A pull request a forge opened, or found open, for a branch. */
export interface ForgePr {
  number: number;
  url: string;
}

/**
 * What the office does with a project's forge. The item shapes are GitHub's (Gh*), which the client
 * renders: another forge maps its own onto them (states OPEN/CLOSED/MERGED, review decisions…).
 */
export interface Forge {
  readonly kind: ForgeKind;
  issues: GhState<GhIssue>;
  pulls: GhState<GhPull>;
  stop(): void;
  refresh(): Promise<void>;
  repoInfo(): Promise<GhRepoInfo>;
  /** Who the office acts as on the forge ('' when it can't say). */
  viewer(): Promise<string>;
  pullDetail(n: number, me?: string): Promise<GhPullDetail>;
  pullDiff(n: number): Promise<string>;
  issueDetail(n: number, me?: string): Promise<GhIssueDetail>;
  comment(kind: 'issue' | 'pull', n: number, body: string, as?: GhAs): Promise<{ comment?: GhComment; error?: string }>;
  /** Posts a review that only comments, its body read from `file`; resolves to its URL. */
  review(n: number, file: string, as?: GhAs): Promise<string>;
  merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean, as?: GhAs): Promise<string | undefined>;
  close(kind: 'issue' | 'pull', n: number, opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }, as?: GhAs): Promise<string | undefined>;
  repoLabels(): Promise<GhLabel[]>;
  setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[], as?: GhAs): Promise<{ labels?: GhLabel[]; error?: string }>;
  /** Takes the issue for whoever asks, which moves it to In progress on the board. */
  claim(issue: number, as?: GhAs): Promise<string | undefined>;

  // --- Pull requests for a worker's branch (see workers/pr.ts and changes.ts), run in `cwd`: a worktree of the project ---
  /** The open pull request for `branch`, if there is one. */
  findOpenPr(branch: string, cwd: string, as?: GhAs): Promise<ForgePr | undefined>;
  /** Opens a pull request for the pushed `branch` into `base` (the forge's default branch when undefined). */
  createPr(branch: string, base: string | undefined, title: string, body: string, cwd: string, as?: GhAs): Promise<ForgePr>;
  pullBody(url: string, cwd: string, as?: GhAs): Promise<string>;
  setPullBody(url: string, body: string, cwd: string, as?: GhAs): Promise<void>;
  /** How a pull request is named in another's description: owner/name#12 on GitHub (which links it), else its URL. */
  prRef(url: string): string;
}
