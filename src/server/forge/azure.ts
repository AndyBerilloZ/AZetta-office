// Azure DevOps as a forge: Boards work items as the issues, Repos pull requests as the PRs, through
// the Azure CLI (`az`, signed in with `az login` on the office's machine; the azure-devops extension).
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GhCloseReason, GhComment, GhIssue, GhIssueDetail, GhLabel, GhMergeMethod, GhPull, GhPullDetail, GhRepoInfo, GhReviewComment, GhState } from '../../shared/protocol.js';
import { WIN, resolveCommand } from '../workers/process.js';
import type { Forge, ForgePr } from './types.js';

/** Work item states that count as closed on the board; everything else is open. */
const CLOSED_STATES = new Set(['closed', 'done', 'removed', 'resolved', 'completed']);
/** States an assigned item is still queued in, not in progress. */
const WAITING_STATES = new Set(['new', 'to do', 'proposed', 'approved', 'backlog']);
/** Work item types worth a note on the board (not test cases, feedback or shared steps). */
const ITEM_TYPES = ['User Story', 'Task', 'Bug', 'Feature', 'Epic', 'Issue', 'Product Backlog Item', 'Requirement'];
const TAG_COLOR = '#6c757d';
const LABELS_MS = 60_000;

/** An Azure DevOps repository, as its origin URL names it. */
export interface AzureRemote {
  /** https://dev.azure.com/<org> */
  org: string;
  project: string;
  repo: string;
}

/**
 * The organization, project and repository in an Azure DevOps remote, in any of its spellings:
 * https://[user@]dev.azure.com/org/project/_git/repo, https://org.visualstudio.com/project/_git/repo,
 * or git@ssh.dev.azure.com:v3/org/project/repo. Undefined for anything else.
 */
export function azureRemote(url: string): AzureRemote | undefined {
  let m = /^(?:https?:\/\/)(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i.exec(url);
  if (m) return { org: `https://dev.azure.com/${m[1]}`, project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]).replace(/\.git$/, '') };
  m = /^(?:https?:\/\/)(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i.exec(url);
  if (m) return { org: `https://dev.azure.com/${m[1]}`, project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]).replace(/\.git$/, '') };
  m = /^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com:(?:\/)?v3\/([^/]+)\/([^/]+)\/([^/?#]+)/i.exec(url);
  if (m) return { org: `https://dev.azure.com/${m[1]}`, project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };
  return undefined;
}

/** Turns az's stderr into something a person standing at the board can act on, keeping what az said. */
function friendly(raw: string): string {
  const said = raw.replace(/^ERROR:\s*/i, '');
  if (/az login|AADSTS|not logged in|TF400813/i.test(said)) return `az isn't signed in to Azure DevOps on the office's machine — run \`az login\` there (${said})`;
  if (/azure-devops.*extension|not in the 'az' command group|is misspelled or not recognized/i.test(said)) return `The Azure CLI needs its azure-devops extension: \`az extension add --name azure-devops\` (${said})`;
  if (/TF401019/i.test(said)) return `az can't find this repository on Azure DevOps — check the remote and your access (${said})`;
  return said;
}

/** How to start az: the executable and the arguments that go before az's own. */
interface Launcher {
  file: string;
  pre: string[];
  /** Windows: the arguments are one command line for cmd.exe, quoted here (see winQuote). */
  verbatim?: boolean;
}

let launcher: Launcher | null | undefined;

/**
 * Where az is. On Windows it's az.cmd, which Node won't start on its own: the MSI's one runs
 * `python.exe -IBm azure.cli`, which is started directly; any other .cmd goes through cmd.exe.
 */
function azLauncher(): Launcher | null {
  const p = resolveCommand('az');
  if (!p) return null;
  if (!WIN || !/\.(cmd|bat)$/i.test(p)) return { file: p, pre: [] };
  try {
    const m = /"%~dp0\\?\.\.\\python\.exe"\s+-IBm\s+azure\.cli/i.exec(readFileSync(p, 'utf8'));
    const python = path.resolve(path.dirname(p), '..', 'python.exe');
    // -X utf8: piped, Python would write the console's code page, and "ó" in a title comes out as "�".
    if (m && existsSync(python)) return { file: python, pre: ['-I', '-B', '-X', 'utf8', '-m', 'azure.cli'] };
  } catch {
    // not the MSI's
  }
  // A command line for cmd.exe can't carry a newline: an argument with one (a PR description) loses it here.
  return { file: process.env.COMSPEC || 'cmd.exe', pre: ['/d', '/s', '/c', p], verbatim: true };
}

/** An argument for a program started through cmd.exe, as CommandLineToArgvW reads it back; in quotes, so cmd's own metacharacters stay literal. */
function winQuote(a: string): string {
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** Runs az (as the office: az keeps its own sign-in, so `env` only carries the caller's locale and the like). */
function az(args: string[], cwd: string, timeout = 60_000): Promise<string> {
  // Found once; again if it's gone (az reinstalled elsewhere, or a test's fake az tidied away).
  if (launcher && !existsSync(launcher.verbatim ? launcher.pre[3] : launcher.file)) launcher = undefined;
  launcher ??= azLauncher();
  return new Promise((resolve, reject) => {
    const l = launcher;
    if (!l) return reject(new Error('Azure CLI (az) is not installed on the server'));
    const all = [...args, '-o', 'json'];
    const argv = l.verbatim ? [...l.pre.slice(0, 3), `"${[winQuote(l.pre[3]), ...all.map(winQuote)].join(' ')}"`] : [...l.pre, ...all];
    execFile(l.file, argv, { cwd, maxBuffer: 32 * 1024 * 1024, timeout, windowsVerbatimArguments: !!l.verbatim, env: { ...process.env, AZURE_CORE_ONLY_SHOW_ERRORS: 'true' } }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
        reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'Azure CLI (az) is not installed on the server' : friendly(msg)));
      } else resolve(stdout);
    });
  });
}

const json = (out: string): any => (out.trim() ? JSON.parse(out) : null);
const ref = (r: string | undefined) => String(r ?? '').replace(/^refs\/heads\//, '');
const who = (identity: any): string => String(identity?.displayName ?? identity?.uniqueName ?? '');
/** Work item descriptions are HTML; the board shows text. */
const text = (html: unknown): string =>
  String(html ?? '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
const tags = (raw: unknown): GhLabel[] =>
  String(raw ?? '')
    .split(';')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((name) => ({ name, color: TAG_COLOR }));
/** Work items a description names: AB#4341, #4341 or a /_workitems/edit/4341 link. */
const workItems = (body: string): number[] => [...new Set([...body.matchAll(/(?:\bAB)?#(\d{2,})\b|_workitems\/edit\/(\d+)/gi)].map((m) => Number(m[1] ?? m[2])).filter((n) => n > 0))];

export class AzureDevOps implements Forge {
  readonly kind = 'azure';
  issues: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: false };
  pulls: GhState<GhPull> = { items: [], fetchedAt: 0, loading: false };
  readonly remote: AzureRemote;
  private login?: Promise<string>;
  private labelList?: { at: number; list: Promise<GhLabel[]> };

  constructor(
    private dir: string,
    originUrl: string,
    private onIssues: (s: GhState<GhIssue>) => void,
    private onPulls: (s: GhState<GhPull>) => void,
  ) {
    this.remote = azureRemote(originUrl) ?? { org: '', project: '', repo: '' };
  }

  stop() {}

  async refresh() {
    await Promise.all([this.refreshIssues(), this.refreshPulls()]);
  }

  /** The project's page on Azure DevOps. */
  private get web(): string {
    return `${this.remote.org}/${encodeURIComponent(this.remote.project)}`;
  }

  pullUrl(n: number): string {
    return `${this.web}/_git/${encodeURIComponent(this.remote.repo)}/pullrequest/${n}`;
  }

  issueUrl(n: number): string {
    return `${this.web}/_workitems/edit/${n}`;
  }

  /** `--organization` and `--project`: never left to `az devops configure` defaults, which may point elsewhere. */
  private scope(): string[] {
    return ['--organization', this.remote.org, '--project', this.remote.project];
  }

  private pr(args: string[], timeout?: number): Promise<any> {
    return az(['repos', 'pr', ...args, '--organization', this.remote.org], this.dir, timeout).then(json);
  }

  /** A REST call az has no command for: `az devops invoke`, with route parameters and an optional JSON body. */
  private async invoke(area: string, resource: string, route: Record<string, string | number>, opts: { method?: string; body?: unknown; version?: string; query?: Record<string, string> } = {}): Promise<any> {
    const args = ['devops', 'invoke', '--organization', this.remote.org, '--area', area, '--resource', resource, '--api-version', opts.version ?? '7.1', '--route-parameters', ...Object.entries(route).map(([k, v]) => `${k}=${v}`)];
    if (opts.query) args.push('--query-parameters', ...Object.entries(opts.query).map(([k, v]) => `${k}=${v}`));
    if (opts.method) args.push('--http-method', opts.method);
    let file: string | undefined;
    if (opts.body !== undefined) {
      file = path.join(tmpdir(), `agent-office-az-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(file, JSON.stringify(opts.body), { mode: 0o600 });
      args.push('--in-file', file);
    }
    try {
      return json(await az(args, this.dir));
    } finally {
      if (file) {
        try {
          unlinkSync(file);
        } catch {
          // left in tmp
        }
      }
    }
  }

  repoInfo(): Promise<GhRepoInfo> {
    return Promise.resolve({ nameWithOwner: `${this.remote.project}/${this.remote.repo}`, methods: ['squash', 'merge', 'rebase'] });
  }

  viewer(): Promise<string> {
    this.login ??= az(['account', 'show'], this.dir).then((out) => String(json(out)?.user?.name ?? ''));
    this.login.catch(() => (this.login = undefined));
    return this.login.catch(() => '');
  }

  private pullOf(p: any): GhPull {
    const votes: number[] = (p.reviewers ?? []).map((r: any) => Number(r.vote ?? 0));
    const body = String(p.description ?? '');
    return {
      number: Number(p.pullRequestId),
      title: String(p.title ?? ''),
      state: p.status === 'completed' ? 'MERGED' : p.status === 'abandoned' ? 'CLOSED' : 'OPEN',
      isDraft: !!p.isDraft,
      url: this.pullUrl(Number(p.pullRequestId)),
      author: who(p.createdBy),
      labels: (p.labels ?? []).map((l: any) => ({ name: String(l.name), color: TAG_COLOR })),
      reviewDecision: votes.some((v) => v < 0) ? 'CHANGES_REQUESTED' : votes.some((v) => v >= 5) ? 'APPROVED' : '',
      headRefName: ref(p.sourceRefName),
      headRefOid: typeof p.lastMergeSourceCommit?.commitId === 'string' ? p.lastMergeSourceCommit.commitId : undefined,
      baseRefName: ref(p.targetRefName),
      createdAt: String(p.creationDate ?? ''),
      updatedAt: String(p.closedDate ?? p.creationDate ?? ''),
      additions: 0,
      deletions: 0,
      checks: 'none',
      body: body.slice(0, 4000),
      closes: workItems(body),
    };
  }

  private issueOf(f: Record<string, any>): GhIssue {
    const state = String(f['System.State'] ?? '');
    const assignee = who(f['System.AssignedTo']);
    return {
      number: Number(f['System.Id']),
      title: String(f['System.Title'] ?? ''),
      state: CLOSED_STATES.has(state.toLowerCase()) ? 'CLOSED' : 'OPEN',
      url: this.issueUrl(Number(f['System.Id'])),
      author: who(f['System.CreatedBy']),
      labels: [{ name: String(f['System.WorkItemType'] ?? 'Work item'), color: '#0078d4' }, { name: state, color: TAG_COLOR }, ...tags(f['System.Tags'])],
      // The board's In progress column goes by assignees: an item still waiting in New isn't in progress, assigned or not.
      assignees: assignee && !WAITING_STATES.has(state.toLowerCase()) ? [assignee] : [],
      createdAt: String(f['System.CreatedDate'] ?? ''),
      updatedAt: String(f['System.ChangedDate'] ?? ''),
      body: text(f['System.Description']).slice(0, 4000),
      comments: Number(f['System.CommentCount'] ?? 0),
    };
  }

  async pullDetail(n: number, me?: string): Promise<GhPullDetail> {
    const [p, threads, repo, viewer] = await Promise.all([this.pr(['show', '--id', String(n)]), this.threads(n), this.repoInfo(), me ?? this.viewer()]);
    const pull = this.pullOf(p);
    const comments: GhComment[] = [];
    const reviewComments: GhReviewComment[] = [];
    for (const t of threads) {
      const file = t.threadContext?.filePath;
      const first = t.comments?.[0]?.id;
      for (const c of t.comments ?? []) {
        if (c.commentType && c.commentType !== 'text') continue;
        if (c.isDeleted) continue;
        if (file) reviewComments.push({ id: Number(c.id), replyTo: c.id === first ? undefined : Number(first), author: who(c.author), body: String(c.content ?? ''), createdAt: String(c.publishedDate ?? ''), url: pull.url, path: String(file).replace(/^\//, ''), line: t.threadContext?.rightFileStart?.line ?? t.threadContext?.leftFileStart?.line ?? null, side: t.threadContext?.rightFileStart ? 'RIGHT' : 'LEFT' });
        else comments.push({ id: String(c.id), author: who(c.author), body: String(c.content ?? ''), createdAt: String(c.publishedDate ?? ''), url: pull.url });
      }
    }
    const reviews: GhComment[] = (p.reviewers ?? [])
      .filter((r: any) => Number(r.vote ?? 0) !== 0)
      .map((r: any) => ({ id: String(r.id), author: who(r), body: '', createdAt: '', state: Number(r.vote) < 0 ? 'CHANGES_REQUESTED' : Number(r.vote) >= 5 ? 'APPROVED' : 'COMMENTED' }));
    return {
      number: pull.number,
      body: String(p.description ?? ''),
      state: pull.state,
      isDraft: pull.isDraft,
      reviewDecision: pull.reviewDecision,
      headRefName: pull.headRefName,
      baseRefName: pull.baseRefName,
      mergeable: p.mergeStatus === 'succeeded' ? 'MERGEABLE' : p.mergeStatus === 'conflicts' ? 'CONFLICTING' : 'UNKNOWN',
      mergeStateStatus: pull.state !== 'OPEN' ? 'UNKNOWN' : p.mergeStatus === 'succeeded' ? 'CLEAN' : p.mergeStatus === 'conflicts' ? 'DIRTY' : 'UNKNOWN',
      commits: 0,
      comments,
      reviews,
      reviewComments,
      checks: [],
      repo,
      viewer,
    };
  }

  private async threads(n: number): Promise<any[]> {
    const r = await this.invoke('git', 'pullRequestThreads', { project: this.remote.project, repositoryId: this.remote.repo, pullRequestId: n });
    return r?.value ?? [];
  }

  /** The PR's diff, from the branches as origin has them: fetched first, so it's what Azure shows. */
  async pullDiff(n: number): Promise<string> {
    const p = await this.pr(['show', '--id', String(n)]);
    const src = ref(p.sourceRefName);
    const tgt = ref(p.targetRefName);
    const git = (args: string[]) =>
      new Promise<string>((resolve, reject) => execFile('git', args, { cwd: this.dir, encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, out, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n').pop() ?? 'git failed')) : resolve(out))));
    await git(['fetch', '--quiet', '--no-tags', 'origin', src, tgt]).catch(() => undefined);
    return git(['diff', '--no-color', `origin/${tgt}...origin/${src}`]);
  }

  async issueDetail(n: number, me?: string): Promise<GhIssueDetail> {
    const [item, viewer] = await Promise.all([az(['boards', 'work-item', 'show', '--id', String(n), '--organization', this.remote.org], this.dir).then(json), me ?? this.viewer()]);
    const f = item?.fields ?? {};
    // Still a preview API; az's invoke takes the version as "7.1-preview", not "7.1-preview.4".
    const comments = await this.invoke('wit', 'comments', { project: this.remote.project, workItemId: n }, { version: '7.1-preview' })
      .then((r: any) => (r?.comments ?? []).map((c: any): GhComment => ({ id: String(c.id), author: who(c.createdBy), body: text(c.text), createdAt: String(c.createdDate ?? ''), url: this.issueUrl(n) })))
      .catch(() => [] as GhComment[]);
    return { number: n, state: CLOSED_STATES.has(String(f['System.State'] ?? '').toLowerCase()) ? 'CLOSED' : 'OPEN', body: text(f['System.Description']), comments, viewer };
  }

  async comment(kind: 'issue' | 'pull', n: number, body: string): Promise<{ comment?: GhComment; error?: string }> {
    try {
      if (kind === 'pull') {
        const t = await this.invoke('git', 'pullRequestThreads', { project: this.remote.project, repositoryId: this.remote.repo, pullRequestId: n }, { method: 'POST', body: { comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: 1 } });
        const c = t?.comments?.[0];
        void this.refreshPulls();
        return { comment: { id: String(c?.id ?? ''), author: who(c?.author), body, createdAt: String(c?.publishedDate ?? new Date().toISOString()), url: this.pullUrl(n) } };
      }
      await az(['boards', 'work-item', 'update', '--id', String(n), '--discussion', body, '--organization', this.remote.org], this.dir);
      void this.refreshIssues();
      return { comment: { id: `${n}-${Date.now()}`, author: await this.viewer(), body, createdAt: new Date().toISOString(), url: this.issueUrl(n) } };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  async review(n: number, file: string): Promise<string> {
    const body = readFileSync(file, 'utf8');
    await this.invoke('git', 'pullRequestThreads', { project: this.remote.project, repositoryId: this.remote.repo, pullRequestId: n }, { method: 'POST', body: { comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: 1 } });
    void this.refreshPulls();
    return this.pullUrl(n);
  }

  async merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean): Promise<string | undefined> {
    try {
      const args = ['update', '--id', String(n), '--squash', String(method === 'squash'), '--delete-source-branch', String(deleteBranch), '--transition-work-items', 'true'];
      if (auto) args.push('--auto-complete', 'true');
      else args.push('--status', 'completed');
      await this.pr(args, 90_000);
    } catch (err) {
      return (err as Error).message;
    }
    void this.refreshPulls();
    return undefined;
  }

  async close(kind: 'issue' | 'pull', n: number, opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }): Promise<string | undefined> {
    try {
      if (kind === 'pull') {
        if (opts.comment) await this.comment('pull', n, opts.comment);
        await this.pr(['update', '--id', String(n), '--status', 'abandoned']);
      } else {
        const args = ['boards', 'work-item', 'update', '--id', String(n), '--state', opts.reason === 'not planned' ? 'Removed' : 'Closed', '--organization', this.remote.org];
        if (opts.comment) args.push('--discussion', opts.comment);
        await az(args, this.dir).catch(async (err) => {
          // Not every process has Removed: Closed then, with why in the discussion.
          if (opts.reason !== 'not planned') throw err;
          await az(['boards', 'work-item', 'update', '--id', String(n), '--state', 'Closed', '--discussion', `Closed as not planned${opts.comment ? `: ${opts.comment}` : ''}`, '--organization', this.remote.org], this.dir);
        });
      }
    } catch (err) {
      return (err as Error).message;
    }
    void (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
    return undefined;
  }

  /** The project's tags, for the label picker. Asked again after a minute (or a failure). */
  repoLabels(): Promise<GhLabel[]> {
    if (!this.labelList || Date.now() - this.labelList.at > LABELS_MS) {
      const list = this.invoke('wit', 'tags', { project: this.remote.project }).then((r: any) => (r?.value ?? []).map((t: any) => ({ name: String(t.name), color: TAG_COLOR })));
      this.labelList = { at: Date.now(), list };
      list.catch(() => this.labelList?.list === list && (this.labelList = undefined));
    }
    return this.labelList.list;
  }

  async setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[]): Promise<{ labels?: GhLabel[]; error?: string }> {
    try {
      if (kind === 'issue') {
        const item = json(await az(['boards', 'work-item', 'show', '--id', String(n), '--organization', this.remote.org], this.dir));
        const now = tags(item?.fields?.['System.Tags']).map((t) => t.name).filter((t) => !remove.includes(t));
        for (const a of add) if (!now.includes(a)) now.push(a);
        await az(['boards', 'work-item', 'update', '--id', String(n), '--fields', `System.Tags=${now.join('; ')}`, '--organization', this.remote.org], this.dir);
        void this.refreshIssues();
        return { labels: now.map((name) => ({ name, color: TAG_COLOR })) };
      }
      const route = { project: this.remote.project, repositoryId: this.remote.repo, pullRequestId: n };
      for (const a of add) await this.invoke('git', 'pullRequestLabels', route, { method: 'POST', body: { name: a } });
      for (const r of remove) await this.invoke('git', 'pullRequestLabels', { ...route, labelIdOrName: r }, { method: 'DELETE' }).catch(() => undefined);
      const list = await this.invoke('git', 'pullRequestLabels', route);
      void this.refreshPulls();
      return { labels: (list?.value ?? []).map((l: any) => ({ name: String(l.name), color: TAG_COLOR })) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /** Assigns the work item to whoever az is signed in as; the board shows it in progress once it leaves New. */
  async claim(issue: number): Promise<string | undefined> {
    try {
      const me = await this.viewer();
      if (!me) return "az isn't signed in to Azure DevOps on the office's machine — run `az login` there";
      await az(['boards', 'work-item', 'update', '--id', String(issue), '--assigned-to', me, '--organization', this.remote.org], this.dir);
    } catch (err) {
      return (err as Error).message;
    }
    void this.refreshIssues();
    return undefined;
  }

  // --- Pull requests for a worker's branch ---

  async findOpenPr(branch: string, cwd: string): Promise<ForgePr | undefined> {
    const list = await this.pr(['list', '--repository', this.remote.repo, '--project', this.remote.project, '--source-branch', branch, '--status', 'active', '--top', '1']);
    const p = Array.isArray(list) ? list[0] : undefined;
    return p ? { number: Number(p.pullRequestId), url: this.pullUrl(Number(p.pullRequestId)) } : undefined;
  }

  async createPr(branch: string, base: string | undefined, title: string, body: string, _cwd: string): Promise<ForgePr> {
    const args = ['create', '--repository', this.remote.repo, '--project', this.remote.project, '--source-branch', branch, '--title', title, '--description', body];
    if (base) args.push('--target-branch', base);
    const p = await this.pr(args, 90_000);
    const n = Number(p?.pullRequestId);
    if (!n) throw new Error('az did not return a pull request');
    void this.refreshPulls();
    return { number: n, url: this.pullUrl(n) };
  }

  async pullBody(url: string): Promise<string> {
    const p = await this.pr(['show', '--id', String(this.numberOf(url))]);
    return String(p?.description ?? '');
  }

  async setPullBody(url: string, body: string): Promise<void> {
    await this.pr(['update', '--id', String(this.numberOf(url)), '--description', body]);
  }

  /** Azure DevOps doesn't link a PR by name in another's description: its URL does. */
  prRef(url: string): string {
    return url;
  }

  private numberOf(url: string): number {
    return Number(/\/pullrequest\/(\d+)/.exec(url)?.[1] ?? 0);
  }

  private async refreshIssues() {
    if (this.issues.loading) return;
    this.issues = { ...this.issues, loading: true };
    this.onIssues(this.issues);
    try {
      const fields = ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo', 'System.CreatedBy', 'System.CreatedDate', 'System.ChangedDate', 'System.Tags', 'System.CommentCount', 'System.Description'];
      // --project scopes the query; a [System.TeamProject] clause on top of it comes back empty.
      const wiql = `SELECT ${fields.map((f) => `[${f}]`).join(',')} FROM WorkItems WHERE [System.WorkItemType] IN (${ITEM_TYPES.map((t) => `'${t}'`).join(',')}) ORDER BY [System.ChangedDate] DESC`;
      const items: any[] = json(await az(['boards', 'query', '--wiql', wiql, ...this.scope()], this.dir, 90_000)) ?? [];
      const all = items.map((i) => this.issueOf(i.fields ?? {}));
      // Open and closed separately, so old open items are never crowded out by recent closed ones.
      const fetched = [...all.filter((i) => i.state === 'OPEN').slice(0, 300), ...all.filter((i) => i.state !== 'OPEN').slice(0, 40)];
      this.issues = { items: fetched, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.issues = { ...this.issues, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onIssues(this.issues);
  }

  private async refreshPulls() {
    if (this.pulls.loading) return;
    this.pulls = { ...this.pulls, loading: true };
    this.onPulls(this.pulls);
    try {
      const list: any[] = (await this.pr(['list', '--repository', this.remote.repo, '--project', this.remote.project, '--status', 'all', '--top', '200'], 90_000)) ?? [];
      const all = list.map((p) => this.pullOf(p));
      const fetched = [...all.filter((p) => p.state === 'OPEN').slice(0, 150), ...all.filter((p) => p.state === 'MERGED').slice(0, 30), ...all.filter((p) => p.state === 'CLOSED').slice(0, 40)];
      this.pulls = { items: fetched, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.pulls = { ...this.pulls, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onPulls(this.pulls);
  }
}
