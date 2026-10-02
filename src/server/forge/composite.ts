// A forge whose issues come from somewhere else (see IssueSource): the issues board and everything
// done to an issue go to the tracker, the pull requests and everything else to the checkout's forge.
import type { GhCloseReason, GhComment, GhIssue, GhIssueDetail, GhLabel, GhMergeMethod, GhPull, GhPullDetail, GhRepoInfo, GhState } from '../../shared/protocol.js';
import type { GhAs } from '../signins.js';
import type { Forge, ForgePr, IssueSource } from './types.js';

export class CompositeForge implements Forge {
  constructor(
    private prs: Forge,
    private tracker: IssueSource,
  ) {}

  get kind() {
    return this.prs.kind;
  }

  get issues(): GhState<GhIssue> {
    return this.tracker.issues;
  }

  set issues(s: GhState<GhIssue>) {
    this.tracker.issues = s;
  }

  get pulls(): GhState<GhPull> {
    return this.prs.pulls;
  }

  set pulls(s: GhState<GhPull>) {
    this.prs.pulls = s;
  }

  stop() {
    this.prs.stop();
    this.tracker.stop();
  }

  async refresh() {
    // The forge's own issues aren't shown: only its pull requests are asked for.
    await Promise.all([this.tracker.refreshIssues(), this.prs.refresh()]);
  }

  repoInfo(): Promise<GhRepoInfo> {
    return this.prs.repoInfo();
  }

  viewer(): Promise<string> {
    return this.prs.viewer();
  }

  pullDetail(n: number, me?: string): Promise<GhPullDetail> {
    return this.prs.pullDetail(n, me);
  }

  pullDiff(n: number): Promise<string> {
    return this.prs.pullDiff(n);
  }

  issueDetail(n: number, me?: string): Promise<GhIssueDetail> {
    return this.tracker.issueDetail(n, me);
  }

  comment(kind: 'issue' | 'pull', n: number, body: string, as?: GhAs): Promise<{ comment?: GhComment; error?: string }> {
    return kind === 'issue' ? this.tracker.comment(n, body) : this.prs.comment(kind, n, body, as);
  }

  review(n: number, file: string, as?: GhAs): Promise<string> {
    return this.prs.review(n, file, as);
  }

  merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean, as?: GhAs): Promise<string | undefined> {
    return this.prs.merge(n, method, deleteBranch, auto, as);
  }

  close(kind: 'issue' | 'pull', n: number, opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }, as?: GhAs): Promise<string | undefined> {
    return kind === 'issue' ? this.tracker.close(n, opts) : this.prs.close(kind, n, opts, as);
  }

  /** The label picker is the issues board's: the tracker's labels. */
  repoLabels(): Promise<GhLabel[]> {
    return this.tracker.repoLabels();
  }

  setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[], as?: GhAs): Promise<{ labels?: GhLabel[]; error?: string }> {
    return kind === 'issue' ? this.tracker.setLabels(n, add, remove) : this.prs.setLabels(kind, n, add, remove, as);
  }

  claim(issue: number): Promise<string | undefined> {
    return this.tracker.claim(issue);
  }

  findOpenPr(branch: string, cwd: string, as?: GhAs): Promise<ForgePr | undefined> {
    return this.prs.findOpenPr(branch, cwd, as);
  }

  createPr(branch: string, base: string | undefined, title: string, body: string, cwd: string, as?: GhAs): Promise<ForgePr> {
    return this.prs.createPr(branch, base, title, body, cwd, as);
  }

  pullBody(url: string, cwd: string, as?: GhAs): Promise<string> {
    return this.prs.pullBody(url, cwd, as);
  }

  setPullBody(url: string, body: string, cwd: string, as?: GhAs): Promise<void> {
    return this.prs.setPullBody(url, body, cwd, as);
  }

  prRef(url: string): string {
    return this.prs.prRef(url);
  }
}
