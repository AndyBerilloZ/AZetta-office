// Windshift (a self-hosted work tracker, REST API v1) as a floor's issues: one of its workspaces
// ("BI") fills the issues board, as GitHub issues would. The token comes from WINDSHIFT_TOKEN on
// the office's machine (or the user's registry on Windows) and is never shown or logged.
import { execFileSync } from 'node:child_process';
import type { GhCloseReason, GhComment, GhIssue, GhIssueDetail, GhLabel, GhState } from '../../shared/protocol.js';
import type { IssueSource } from './types.js';

/** A floor's issues on Windshift, as floors.json names them (see FloorDef.issues). */
export interface WindshiftConfig {
  kind: 'windshift';
  /** The instance, like https://jira.example.com; else WINDSHIFT_URL. */
  url?: string;
  /** The workspace's key ("BI"). */
  workspace: string;
}

const PAGE = 100;
const MAX_PAGES = 10;
const LABELS_MS = 60_000;
const TAG_COLOR = '#6c757d';

interface WsStatus {
  id: number;
  name: string;
  category_name?: string;
  is_completed?: boolean;
}

interface WsItem {
  id: number;
  key?: string;
  workspace_item_number: number;
  title: string;
  description?: string;
  status?: { id: number; name: string };
  priority?: { name: string; color?: string };
  item_type?: { name: string };
  creator?: { full_name?: string; username?: string };
  assignee?: { full_name?: string; username?: string };
  labels?: { id: number; name: string; color?: string }[];
  comments?: unknown[];
  created_at?: string;
  updated_at?: string;
}

/** The token, from the environment or (Windows) the user's registry, where a variable set after the office started still is. */
function token(): string | undefined {
  let t = process.env.WINDSHIFT_TOKEN;
  if (!t && process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'WINDSHIFT_TOKEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      t = /WINDSHIFT_TOKEN\s+REG_\w+\s+(\S+)/.exec(out)?.[1];
    } catch {
      // not set
    }
  }
  return t || undefined;
}

const who = (u: WsItem['creator']): string => String(u?.full_name || u?.username || '');

export class Windshift implements IssueSource {
  readonly kind = 'windshift';
  issues: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: false };
  private readonly base: string;
  private ws?: Promise<{ id: number; key: string }>;
  private statuses?: Promise<Map<number, WsStatus>>;
  private me?: Promise<{ id: number; name: string }>;
  private labelList?: { at: number; list: Promise<{ id: number; name: string; color?: string }[]> };

  constructor(
    private cfg: WindshiftConfig,
    private onIssues: (s: GhState<GhIssue>) => void,
  ) {
    this.base = (cfg.url || process.env.WINDSHIFT_URL || '').replace(/\/+$/, '');
  }

  stop() {}

  private async api(method: string, route: string, body?: unknown): Promise<any> {
    if (!this.base) throw new Error('Windshift has no URL: set "url" on the floor in floors.json, or WINDSHIFT_URL');
    const t = token();
    if (!t) throw new Error("No Windshift token on the office's machine: set WINDSHIFT_TOKEN there");
    const r = await fetch(`${this.base}/rest/api/v1${route}`, {
      method,
      headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!r.ok) {
      const said = typeof data === 'string' ? data.slice(0, 200) : String(data?.error ?? data?.message ?? JSON.stringify(data)).slice(0, 200);
      if (r.status === 401 || r.status === 403) throw new Error(`Windshift refused the office's token (${r.status}): it needs items:read, items:write and workspaces:read (${said})`);
      throw new Error(`Windshift: ${method} ${route} → ${r.status} ${said}`);
    }
    return data;
  }

  /** The workspace by its key, asked once. */
  private workspace(): Promise<{ id: number; key: string }> {
    this.ws ??= this.api('GET', '/workspaces?limit=100').then((r) => {
      const key = this.cfg.workspace.toUpperCase();
      const w = (r?.data ?? []).find((x: any) => String(x.key).toUpperCase() === key);
      if (!w) throw new Error(`Windshift has no workspace with the key ${key} that this token can see`);
      return { id: Number(w.id), key };
    });
    this.ws.catch(() => (this.ws = undefined));
    return this.ws;
  }

  private statusMap(): Promise<Map<number, WsStatus>> {
    this.statuses ??= this.workspace().then(async (w) => {
      const list: WsStatus[] = await this.api('GET', `/workspaces/${w.id}/statuses`);
      const done = new Set<number>(((await this.api('GET', `/workspaces/${w.id}/statuses/completed`)) as WsStatus[]).map((s) => Number(s.id)));
      return new Map(list.map((s) => [Number(s.id), { ...s, is_completed: s.is_completed || done.has(Number(s.id)) }]));
    });
    this.statuses.catch(() => (this.statuses = undefined));
    return this.statuses;
  }

  private itemUrl(it: WsItem, wsId: number): string {
    return `${this.base}/workspaces/${wsId}/items/${it.id}`;
  }

  private issueOf(it: WsItem, wsId: number, statuses: Map<number, WsStatus>): GhIssue {
    const status = it.status && statuses.get(Number(it.status.id));
    const closed = !!status?.is_completed;
    const waiting = !status || /to do|backlog|open/i.test(status.category_name ?? '') || status.category_name === undefined;
    const assignee = who(it.assignee);
    return {
      number: Number(it.workspace_item_number),
      title: String(it.title ?? ''),
      state: closed ? 'CLOSED' : 'OPEN',
      url: this.itemUrl(it, wsId),
      author: who(it.creator),
      labels: [
        ...(it.item_type?.name ? [{ name: it.item_type.name, color: '#0078d4' }] : []),
        ...(it.status?.name ? [{ name: it.status.name, color: TAG_COLOR }] : []),
        ...(it.priority?.name ? [{ name: it.priority.name, color: it.priority.color || TAG_COLOR }] : []),
        ...(it.labels ?? []).map((l) => ({ name: String(l.name), color: l.color || TAG_COLOR })),
      ],
      // The board's In progress column goes by assignees: an item still waiting in Open, or done, isn't in progress, assigned or not.
      assignees: assignee && !waiting && !closed ? [assignee] : [],
      createdAt: String(it.created_at ?? ''),
      updatedAt: String(it.updated_at ?? it.created_at ?? ''),
      body: String(it.description ?? '').slice(0, 4000),
      comments: Array.isArray(it.comments) ? it.comments.length : 0,
    };
  }

  async refreshIssues() {
    if (this.issues.loading) return;
    this.issues = { ...this.issues, loading: true };
    this.onIssues(this.issues);
    try {
      const [w, statuses] = await Promise.all([this.workspace(), this.statusMap()]);
      const all: GhIssue[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await this.api('GET', `/items?workspace_id=${w.id}&limit=${PAGE}&page=${page}&sort=updated_at&order=desc`);
        for (const it of r?.data ?? []) all.push(this.issueOf(it, w.id, statuses));
        if (!r?.pagination?.has_more) break;
      }
      // Open and closed separately, so old open items are never crowded out by recent closed ones.
      const items = [...all.filter((i) => i.state === 'OPEN').slice(0, 300), ...all.filter((i) => i.state !== 'OPEN').slice(0, 40)];
      this.issues = { items, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.issues = { ...this.issues, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onIssues(this.issues);
  }

  viewer(): Promise<string> {
    return this.whoami()
      .then((m) => m.name)
      .catch(() => '');
  }

  private whoami(): Promise<{ id: number; name: string }> {
    this.me ??= this.api('GET', '/users/me').then((u) => ({ id: Number(u.id), name: String(u.full_name || u.username || u.email || '') }));
    this.me.catch(() => (this.me = undefined));
    return this.me;
  }

  /** BI-63 → the item, by the number the board shows. */
  private async item(n: number): Promise<WsItem> {
    const w = await this.workspace();
    return this.api('GET', `/workspaces/${w.key}/items/${n}`);
  }

  async issueDetail(n: number, me?: string): Promise<GhIssueDetail> {
    const [it, statuses, viewer] = await Promise.all([this.item(n), this.statusMap(), me ?? this.viewer()]);
    const comments: any[] = await this.api('GET', `/items/${it.id}/comments?limit=100`).catch(() => []);
    const status = it.status && statuses.get(Number(it.status.id));
    return {
      number: n,
      state: status?.is_completed ? 'CLOSED' : 'OPEN',
      body: String(it.description ?? ''),
      comments: (Array.isArray(comments) ? comments : []).map((c) => ({ id: String(c.id), author: who(c.author), body: String(c.content ?? ''), createdAt: String(c.created_at ?? '') })),
      viewer,
    };
  }

  async comment(n: number, body: string): Promise<{ comment?: GhComment; error?: string }> {
    try {
      const it = await this.item(n);
      const c = await this.api('POST', `/items/${it.id}/comments`, { content: body });
      void this.refreshIssues();
      return { comment: { id: String(c?.id ?? Date.now()), author: who(c?.author) || (await this.viewer()), body, createdAt: String(c?.created_at ?? new Date().toISOString()) } };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /** Moves the item to the workspace's completed status, by the one transition that gets there. */
  async close(n: number, opts: { comment?: string; reason?: GhCloseReason }): Promise<string | undefined> {
    try {
      const [it, statuses] = await Promise.all([this.item(n), this.statusMap()]);
      const transitions: any[] = await this.api('GET', `/items/${it.id}/transitions`);
      const closing = transitions.filter((t) => statuses.get(Number(t.to_status_id))?.is_completed);
      if (!(it.status && statuses.get(Number(it.status.id))?.is_completed)) {
        if (closing.length !== 1) return closing.length ? `Windshift offers more than one closing status from "${it.status?.name}": close it there` : `No transition closes BI-${n} from "${it.status?.name}" on Windshift`;
        await this.api('POST', `/items/${it.id}/transition`, { to_status_id: closing[0].to_status_id });
      }
      const note = opts.reason === 'not planned' ? `Closed as not planned${opts.comment ? `: ${opts.comment}` : ''}` : opts.comment;
      if (note) await this.api('POST', `/items/${it.id}/comments`, { content: note });
    } catch (err) {
      return (err as Error).message;
    }
    void this.refreshIssues();
    return undefined;
  }

  private labels(): Promise<{ id: number; name: string; color?: string }[]> {
    if (!this.labelList || Date.now() - this.labelList.at > LABELS_MS) {
      const list = this.workspace().then(async (w) => (((await this.api('GET', `/workspaces/${w.id}/labels`))?.items ?? []) as { id: number; name: string; color?: string }[]));
      this.labelList = { at: Date.now(), list };
      list.catch(() => this.labelList?.list === list && (this.labelList = undefined));
    }
    return this.labelList.list;
  }

  async repoLabels(): Promise<GhLabel[]> {
    return (await this.labels()).map((l) => ({ name: String(l.name), color: l.color || TAG_COLOR }));
  }

  async setLabels(n: number, add: string[], remove: string[]): Promise<{ labels?: GhLabel[]; error?: string }> {
    try {
      const [it, all] = await Promise.all([this.item(n), this.labels()]);
      const byName = new Map(all.map((l) => [l.name.toLowerCase(), l]));
      for (const name of add) {
        const l = byName.get(name.toLowerCase());
        if (!l) return { error: `Windshift has no label "${name}" in this workspace` };
        if (!(it.labels ?? []).some((x) => Number(x.id) === Number(l.id))) await this.api('POST', `/items/${it.id}/labels`, { label_id: l.id });
      }
      for (const name of remove) {
        const l = (it.labels ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? byName.get(name.toLowerCase());
        if (l) await this.api('DELETE', `/items/${it.id}/labels/${l.id}`).catch(() => undefined);
      }
      const now: WsItem = await this.api('GET', `/items/${it.id}`);
      void this.refreshIssues();
      return { labels: (now.labels ?? []).map((l) => ({ name: String(l.name), color: l.color || TAG_COLOR })) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /** Assigns the item to whoever the token is, and takes it into progress when one transition does. */
  async claim(issue: number): Promise<string | undefined> {
    try {
      const [it, me, statuses] = await Promise.all([this.item(issue), this.whoami(), this.statusMap()]);
      await this.api('PUT', `/items/${it.id}`, { assignee_id: me.id });
      const status = it.status && statuses.get(Number(it.status.id));
      if (status && /to do|backlog|open/i.test(status.category_name ?? status.name)) {
        const transitions: any[] = await this.api('GET', `/items/${it.id}/transitions`);
        const forward = transitions.filter((t) => /in progress|doing/i.test(statuses.get(Number(t.to_status_id))?.category_name ?? ''));
        if (forward.length === 1) await this.api('POST', `/items/${it.id}/transition`, { to_status_id: forward[0].to_status_id });
      }
    } catch (err) {
      return (err as Error).message;
    }
    void this.refreshIssues();
    return undefined;
  }
}
