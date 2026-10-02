import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Windshift } from '../src/server/forge/windshift.js';
import type { GhIssue, GhState } from '../src/shared/protocol.js';

// Windshift as a floor's issues: a workspace's items on the issues board, and what the office does
// to one, against a fake Windshift (its REST API v1, as the real one answered on 2026-10-01).

const STATUSES = [
  { id: 1, name: 'Open', category_id: 1, category_name: 'To Do' },
  { id: 2, name: 'In Progress', category_id: 2, category_name: 'In Progress' },
  { id: 3, name: 'Done', category_id: 3, category_name: 'Done', is_completed: true },
];

function item(id: number, status: number, extra: Record<string, unknown> = {}) {
  return { id: id + 100, workspace_id: 2, workspace_key: 'BI', key: `BI-${id}`, workspace_item_number: id, title: `Item ${id}`, description: `## Hola\n\nmundo ${id}`, status: STATUSES[status - 1], priority: { id: 4, name: 'Low', color: '#16a34a' }, item_type: { id: 4, name: 'Task' }, creator: { id: 2, full_name: 'Andres Berillo' }, created_at: '2026-09-30T22:01:09Z', updated_at: '2026-10-01T10:00:00Z', labels: [], comments: [], ...extra };
}

interface Fake {
  url: string;
  items: ReturnType<typeof item>[];
  calls: { method: string; path: string; body?: any }[];
  close(): void;
}

/** A fake Windshift: the routes the forge uses, with the items in memory. */
function fake(items: ReturnType<typeof item>[]): Promise<Fake> {
  const calls: Fake['calls'] = [];
  const labels = [{ id: 7, name: 'urgente', color: '#dc2626' }, { id: 8, name: 'backend', color: '#2563eb' }];
  let nextComment = 500;
  const read = (req: IncomingMessage) => new Promise<any>((resolve) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => resolve(s ? JSON.parse(s) : undefined));
  });
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const path = url.pathname.replace(/^\/rest\/api\/v1/, '');
    const body = await read(req);
    calls.push({ method: req.method!, path: path + url.search, body });
    const send = (code: number, data: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== 'Bearer crw_test') return send(401, { error: 'unauthorized' });
    const byId = (id: string) => items.find((i) => i.id === Number(id));
    let m: RegExpExecArray | null;
    if (path === '/workspaces') return send(200, { data: [{ id: 3, key: 'ANDRES' }, { id: 2, key: 'BI', name: 'Bipea' }], pagination: { has_more: false } });
    if (path === '/workspaces/2/statuses') return send(200, STATUSES);
    if (path === '/workspaces/2/statuses/completed') return send(200, STATUSES.filter((s) => s.is_completed));
    if (path === '/workspaces/2/labels') return send(200, { items: labels });
    if (path === '/users/me') return send(200, { id: 2, username: 'andy', full_name: 'Andres Berillo' });
    if (path === '/items') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const slice = items.slice((page - 1) * limit, page * limit);
      return send(200, { data: slice, pagination: { page, has_more: page * limit < items.length } });
    }
    if ((m = /^\/workspaces\/BI\/items\/(\d+)$/.exec(path))) {
      const it = items.find((i) => i.workspace_item_number === Number(m![1]));
      return it ? send(200, it) : send(404, { error: 'no such item' });
    }
    if ((m = /^\/items\/(\d+)$/.exec(path)) && req.method === 'GET') return send(200, byId(m[1]));
    if ((m = /^\/items\/(\d+)$/.exec(path)) && req.method === 'PUT') {
      const it = byId(m[1])!;
      if (body.assignee_id) (it as any).assignee = { id: body.assignee_id, full_name: 'Andres Berillo' };
      return send(200, it);
    }
    if ((m = /^\/items\/(\d+)\/comments$/.exec(path)) && req.method === 'GET') return send(200, byId(m[1])!.comments);
    if ((m = /^\/items\/(\d+)\/comments$/.exec(path)) && req.method === 'POST') {
      const c = { id: nextComment++, content: body.content, author: { full_name: 'Andres Berillo' }, created_at: '2026-10-01T12:00:00Z' };
      (byId(m[1])!.comments as any[]).push(c);
      return send(201, c);
    }
    if ((m = /^\/items\/(\d+)\/transitions$/.exec(path))) {
      const it = byId(m[1])!;
      return send(200, STATUSES.filter((s) => s.id !== it.status.id).map((s) => ({ to_status_id: s.id, to_status: s })));
    }
    if ((m = /^\/items\/(\d+)\/transition$/.exec(path))) {
      byId(m[1])!.status = STATUSES[body.to_status_id - 1];
      return send(200, {});
    }
    if ((m = /^\/items\/(\d+)\/labels$/.exec(path)) && req.method === 'POST') {
      (byId(m[1])!.labels as any[]).push(labels.find((l) => l.id === body.label_id));
      return send(200, { items: byId(m[1])!.labels });
    }
    if ((m = /^\/items\/(\d+)\/labels\/(\d+)$/.exec(path)) && req.method === 'DELETE') {
      const it = byId(m[1])!;
      it.labels = (it.labels as any[]).filter((l) => l.id !== Number(m![2]));
      return send(204, '');
    }
    send(404, { error: `no route for ${req.method} ${path}` });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, items, calls, close: () => server.close() }));
  });
}

async function source(t: { after(fn: () => void): void }, items: ReturnType<typeof item>[]): Promise<{ f: Fake; ws: Windshift; state(): GhState<GhIssue> }> {
  const f = await fake(items);
  const saved = process.env.WINDSHIFT_TOKEN;
  process.env.WINDSHIFT_TOKEN = 'crw_test';
  t.after(() => {
    if (saved === undefined) delete process.env.WINDSHIFT_TOKEN;
    else process.env.WINDSHIFT_TOKEN = saved;
    f.close();
  });
  let state: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: false };
  const ws = new Windshift({ kind: 'windshift', url: f.url, workspace: 'bi' }, (s) => (state = s));
  return { f, ws, state: () => state };
}

test('the issues board shows a Windshift workspace as issues, in GitHub terms', async (t) => {
  const { ws, state } = await source(t, [item(83, 1), item(70, 2, { assignee: { full_name: 'Andres Berillo' }, labels: [{ id: 7, name: 'urgente', color: '#dc2626' }] }), item(63, 3, { assignee: { full_name: 'Andres Berillo' } }), item(10, 1, { assignee: { full_name: 'Andres Berillo' } })]);
  assert.equal(ws.kind, 'windshift');
  await ws.refreshIssues();
  const s = state();
  assert.equal(s.error, undefined, s.error);
  // Open first, the closed one last; assigned but still Open isn't in progress.
  assert.deepEqual(s.items.map((i) => [i.number, i.state, i.assignees]), [[83, 'OPEN', []], [70, 'OPEN', ['Andres Berillo']], [10, 'OPEN', []], [63, 'CLOSED', []]]);
  assert.deepEqual(s.items[1].labels.map((l) => l.name), ['Task', 'In Progress', 'Low', 'urgente']);
  assert.equal(s.items[0].url, `${ws['base']}/workspaces/2/items/183`);
  assert.equal(s.items[0].author, 'Andres Berillo');
  assert.equal(s.items[0].body, '## Hola\n\nmundo 83');
  assert.equal(await ws.viewer(), 'Andres Berillo');
});

test('the board pages through a big workspace', async (t) => {
  const many = Array.from({ length: 230 }, (_, i) => item(i + 1, 1));
  const { ws, state, f } = await source(t, many);
  await ws.refreshIssues();
  assert.equal(state().items.length, 230);
  assert.deepEqual(f.calls.filter((c) => c.path.startsWith('/items?')).map((c) => new URL(c.path, 'http://x').searchParams.get('page')), ['1', '2', '3']);
});

test('an issue in full, a comment, labels, taking it and closing it all go to Windshift', async (t) => {
  const { ws, f } = await source(t, [item(63, 1, { comments: [{ id: 1, content: 'first', author: { full_name: 'Juan' }, created_at: '2026-09-30T00:00:00Z' }] })]);
  const d = await ws.issueDetail(63);
  assert.equal(d.state, 'OPEN');
  assert.deepEqual(d.comments.map((c) => [c.author, c.body]), [['Juan', 'first']]);
  const c = await ws.comment(63, 'Mergeado a main.');
  assert.equal(c.comment?.body, 'Mergeado a main.');
  assert.deepEqual(f.calls.find((x) => x.method === 'POST' && x.path === '/items/163/comments')?.body, { content: 'Mergeado a main.' });
  assert.deepEqual((await ws.repoLabels()).map((l) => l.name), ['urgente', 'backend']);
  const labeled = await ws.setLabels(63, ['backend'], []);
  assert.deepEqual(labeled.labels?.map((l) => l.name), ['backend']);
  assert.deepEqual(f.calls.find((x) => x.method === 'POST' && x.path === '/items/163/labels')?.body, { label_id: 8 });
  assert.match((await ws.setLabels(63, ['nope'], [])).error ?? '', /no label "nope"/);
  // Taking it assigns it and moves it from Open to In Progress.
  assert.equal(await ws.claim(63), undefined);
  assert.deepEqual(f.calls.find((x) => x.method === 'PUT' && x.path === '/items/163')?.body, { assignee_id: 2 });
  assert.deepEqual(f.calls.find((x) => x.path === '/items/163/transition')?.body, { to_status_id: 2 });
  assert.equal(f.items[0].status.name, 'In Progress');
  // Closing takes the one transition to Done, with the reason as a comment.
  assert.equal(await ws.close(63, { reason: 'not planned', comment: 'duplicado' }), undefined);
  assert.equal(f.items[0].status.name, 'Done');
  assert.equal(f.items[0].comments.at(-1)?.content, 'Closed as not planned: duplicado');
  assert.equal(await ws.close(63, {}), undefined, 'closing a closed item is nothing to do');
});

test('a token Windshift refuses, or a workspace it hasn’t got, is said plainly', async (t) => {
  const { ws, state } = await source(t, [item(1, 1)]);
  process.env.WINDSHIFT_TOKEN = 'crw_wrong';
  await ws.refreshIssues();
  assert.match(state().error ?? '', /refused the office's token \(401\)/);
  process.env.WINDSHIFT_TOKEN = 'crw_test';
  const other = new Windshift({ kind: 'windshift', url: ws['base'], workspace: 'NOPE' }, () => {});
  await other.refreshIssues();
  assert.match(other.issues.error ?? '', /no workspace with the key NOPE/);
});
