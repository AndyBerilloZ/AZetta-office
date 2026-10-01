import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Building, primaryDir } from '../src/server/building.js';
import { excludeFromGit } from '../src/server/config.js';
import { projectInfo } from '../src/server/floor.js';
import { Ledger } from '../src/server/usage.js';
import { WorkerManager, type RepoSource, type WorkerEvents } from '../src/server/workers.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

// A workspace floor (FloorDef.repos): a folder holding several checkouts rather than one. A worker
// hired there in its own worktree gets a worktree of each, as a worker across floors does.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A checkout of github.com/acme/<name> in `parent`, whose pushes land in a local bare repository instead. */
function project(root: string, parent: string, name: string): string {
  const bare = path.join(root, 'remotes', `${name}.git`);
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const dir = path.join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  git(dir, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`);
  git(dir, 'config', `url.${bare}.pushInsteadOf`, `https://github.com/acme/${name}.git`);
  git(dir, 'push', '-q', 'origin', 'main');
  excludeFromGit(dir);
  return dir;
}

/** Records where it was started, then waits. */
const fakeAgent = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ cwd: process.cwd() }) + '\\n');
setInterval(() => {}, 1000);
`;

/** Pull requests kept in $GH_STATE: list, create, view (the body) and edit (the body). */
const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const file = process.env.GH_STATE;
const st = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { prs: [] };
const a = process.argv.slice(2);
const opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const repo = () => execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim().replace(/^https:\\/\\/github\\.com\\//, '').replace(/\\.git$/, '');
const done = (out, code = 0) => { fs.writeFileSync(file, JSON.stringify(st)); process.stdout.write(out); process.exit(code); };
if (a[0] === 'pr' && a[1] === 'list') done(JSON.stringify(st.prs.filter((p) => p.repo === repo() && p.head === opt('--head') && p.state === 'OPEN').slice(0, 1).map((p) => ({ number: p.number, url: p.url }))));
if (a[0] === 'pr' && a[1] === 'create') {
  const r = repo();
  const number = st.prs.filter((p) => p.repo === r).length + 1;
  const url = 'https://github.com/' + r + '/pull/' + number;
  st.prs.push({ repo: r, number, url, head: opt('--head'), base: opt('--base'), title: opt('--title'), body: opt('--body'), state: 'OPEN' });
  done(url + '\\n');
}
const pr = st.prs.find((p) => p.url === a[2]);
if (a[0] === 'pr' && a[1] === 'view' && pr) done(pr.body + '\\n');
if (a[0] === 'pr' && a[1] === 'edit' && pr) { pr.body = opt('--body'); done(''); }
done('', 1);
`;

interface Fixture {
  root: string;
  /** The workspace floor: a plain folder with `specs` and `api` in it. */
  floor: string;
  specs: string;
  api: string;
  agent: string;
  starts(): { cwd: string }[];
  prs(): { repo: string; number: number; url: string; head: string; base?: string; title: string; body: string }[];
}

function fixture(t: { after(fn: () => void): void }): Fixture {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-office-workspace-')));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const agent = path.join(bin, 'fake-agent');
  writeFileSync(agent, fakeAgent, { mode: 0o755 });
  writeFileSync(path.join(bin, 'gh'), fakeGh, { mode: 0o755 });
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const log = path.join(root, 'starts.jsonl');
  writeFileSync(log, '');
  const ghState = path.join(root, 'gh.json');
  const saved = { PATH: process.env.PATH, FAKE_AGENT_LOG: process.env.FAKE_AGENT_LOG, GH_STATE: process.env.GH_STATE };
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`;
  process.env.FAKE_AGENT_LOG = log;
  process.env.GH_STATE = ghState;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const floor = path.join(root, 'bipea');
  mkdirSync(floor);
  return {
    root,
    floor,
    specs: project(root, floor, 'specs'),
    api: project(root, floor, 'api'),
    agent,
    starts: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    prs: () => (existsSync(ghState) ? JSON.parse(readFileSync(ghState, 'utf8')).prs : []),
  };
}

const events: WorkerEvents = { update() {}, remove() {}, data() {}, screen() {}, toast() {} };

/** The floor's workers, with `specs` as its main project and `api` beside it, as Floor builds them. */
function manager(f: Fixture, t: { after(fn: () => void): void }): WorkerManager {
  const data = path.join(f.floor, '.agent-office');
  mkdirSync(data, { recursive: true });
  const workers = new WorkerManager(f.floor, data, f.agent, [], { url: 'http://127.0.0.1:1', token: '' }, events, new Ledger(data, { pauseHiring: false }, () => {}, () => {}), undefined, undefined, undefined, undefined, [{ dir: f.specs }, { dir: f.api }]);
  t.after(() => workers.shutdown());
  return workers;
}

/** What Floor.subRepos() hands the manager for `api`: no floor of its own. */
const apiSource = (f: Fixture): RepoSource => ({ floor: 'bipea:api', name: 'api', repo: 'acme/api', dir: f.api });

async function waitFor<T>(read: () => T, ok: (v: T) => boolean, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  let v = read();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    v = read();
  }
  assert.ok(ok(v), 'timed out');
  return v;
}

test('floors.json names the checkouts of a workspace floor, and the floor takes its branch from the first', (t) => {
  const f = fixture(t);
  const data = path.join(f.root, 'office');
  mkdirSync(data);
  writeFileSync(path.join(data, 'floors.json'), JSON.stringify([
    { id: 'bipea', name: 'Bipea', dir: f.floor, repos: [{ name: 'specs', dir: f.specs, repo: 'acme/specs' }, { dir: 'api' }, { dir: f.floor }, { name: 'specs', dir: f.specs }], palette: 0, addedBy: 't', addedAt: 1 },
    { id: 'plain', name: 'Plain', dir: f.specs, palette: 1, addedBy: 't', addedAt: 1 },
  ]));
  const [bipea, plain] = new Building(data, path.join(f.root, 'projects')).list();
  // A relative dir is under the floor; the floor itself, and a name used twice, are dropped.
  assert.deepEqual(bipea.repos, [{ name: 'specs', repo: 'acme/specs', dir: f.specs }, { name: 'api', repo: undefined, dir: f.api }]);
  assert.equal(plain.repos, undefined);
  assert.equal(primaryDir(bipea), f.specs);
  assert.equal(primaryDir(plain), f.specs);
  const info = projectInfo(bipea, 'claude', []);
  assert.equal(info.dir, f.floor);
  assert.equal(info.branch, 'main');
  assert.equal(info.remote, 'https://github.com/acme/specs.git');
  assert.deepEqual(info.repos, ['specs', 'api']);
  assert.equal(projectInfo(plain, 'claude', []).repos, undefined);
});

test('a worker on a workspace floor gets a worktree of each checkout, in the floor, on one branch', async (t) => {
  const f = fixture(t);
  const workers = manager(f, t);
  assert.equal(workers.repoDir, f.specs);
  const w = workers.spawn('desk-1', 'Cody', undefined, true, 'agent', undefined, undefined, undefined, undefined, undefined, [apiSource(f)]);
  assert.equal(typeof w, 'object', String(w));
  if (typeof w === 'string') return;
  const slug = w.worktree!.branch.replace(/^office\//, '');
  const ws = path.join(f.floor, '.agent-office', 'worktrees', slug);
  // Both worktrees are in the floor's folder, not in specs' own .agent-office.
  assert.equal(w.worktree!.path, path.join('.agent-office', 'worktrees', slug, 'specs'));
  assert.deepEqual(w.repos!.map((r) => [r.floor, r.name, r.path, r.branch, r.from]), [['bipea:api', 'api', path.join('.agent-office', 'worktrees', slug, 'api'), w.worktree!.branch, 'main']]);
  assert.ok(!existsSync(path.join(f.specs, '.agent-office', 'worktrees')), 'nothing under the checkout itself');
  for (const [name, dir] of [['specs', f.specs], ['api', f.api]]) {
    assert.equal(git(path.join(ws, name), 'rev-parse', '--abbrev-ref', 'HEAD'), w.worktree!.branch);
    assert.equal(realpathSync(path.resolve(path.join(ws, name), git(path.join(ws, name), 'rev-parse', '--git-common-dir'))), realpathSync(path.join(dir, '.git')));
  }
  // The brief names the main project after its checkout, not the floor's folder.
  const brief = readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8');
  for (const line of ["`specs/`: acme/specs, cut from main (this floor's project)", '`api/`: acme/api, cut from main', 'acme/specs#12']) assert.ok(brief.includes(line), line);
  assert.ok(!brief.includes('bipea#'), brief);
  // It starts in the workspace, and comes back with both after a restart.
  const [start] = await waitFor(() => f.starts(), (s) => s.length === 1);
  assert.equal(realpathSync(start.cwd), ws);
  workers.shutdown();
  const again = manager(f, t);
  assert.deepEqual(again.get(w.id)?.repos?.map((r) => r.name), ['api']);
  // What it holds, and sending it home, go by both worktrees.
  writeFileSync(path.join(ws, 'api', 'wip.js'), 'wip\n');
  const state = await again.inspectWorktree(w.id);
  assert.deepEqual(state?.repos?.map((r) => [r.name, r.state.dirty]), [['specs', 0], ['api', 1]]);
  const done = await again.kill(w.id, 'all');
  assert.match(done.note ?? '', /Deleted .*worktrees and branch office\/\S+ in specs, api/);
  assert.equal(existsSync(ws), false);
  assert.equal(git(f.specs, 'branch', '--list', w.worktree!.branch), '');
  assert.equal(git(f.api, 'branch', '--list', w.worktree!.branch), '');
});

test('O on a workspace floor opens a pull request in each checkout with commits', async (t) => {
  const f = fixture(t);
  const workers = manager(f, t);
  const w = workers.spawn('desk-1', 'Cody', 'Work on GitHub issue #12: "Stock mínimo".', true, 'agent', undefined, undefined, undefined, undefined, undefined, [apiSource(f)]) as WorkerInfo;
  const ws = path.join(f.floor, '.agent-office', 'worktrees', w.worktree!.branch.slice('office/'.length));
  await waitFor(() => workers.get(w.id)?.status, (s) => s !== 'starting');
  for (const name of ['specs', 'api']) {
    writeFileSync(path.join(ws, name, 'stock.md'), `# ${name}\n`);
    git(path.join(ws, name), 'add', '-A');
    git(path.join(ws, name), 'commit', '-q', '-m', `Stock in ${name}`);
  }
  (workers as any).workers.get(w.id).info.status = 'done';
  const r = await workers.openPr(w.id, 'Cody');
  assert.equal(typeof r, 'object', String(r));
  if (typeof r === 'string') return;
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.prs.map((p) => [p.repo, p.number, p.existed]), [['specs', 1, false], ['api', 1, false]]);
  const specs = f.prs().find((p) => p.repo === 'acme/specs')!;
  const api = f.prs().find((p) => p.repo === 'acme/api')!;
  assert.equal(specs.base, 'main');
  assert.equal(specs.title, 'Stock mínimo');
  // The issue is the main project's: its PR closes it, api's only points at it.
  assert.match(specs.body, /\nCloses #12\n/);
  assert.match(api.body, /\nPart of acme\/specs#12\n/);
  for (const p of [specs, api]) assert.match(p.body, /One change across 2 repositories/);
  for (const name of ['specs', 'api']) assert.ok(git(path.join(f.root, 'remotes', `${name}.git`), 'rev-parse', w.worktree!.branch));
});
