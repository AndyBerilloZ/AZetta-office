import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AzureDevOps, azureRemote } from '../src/server/forge/azure.js';
import { forgeFor, forgeKindOfUrl } from '../src/server/forge/index.js';
import type { GhIssue, GhPull, GhState } from '../src/shared/protocol.js';

// Azure DevOps as a forge: Boards work items on the issues board, Repos pull requests on the PR
// board, and pull requests for a worker's branch, all through a fake `az` that records what it was asked.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A fake az: answers from $AZ_ANSWERS (a JSON object keyed by "area verb"), and logs every call to $AZ_LOG. */
const fakeAz = `
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.AZ_LOG, JSON.stringify(a) + '\\n');
const answers = JSON.parse(fs.readFileSync(process.env.AZ_ANSWERS, 'utf8'));
const key = a.slice(0, 3).join(' ');
const hit = Object.keys(answers).find((k) => key.startsWith(k));
if (!hit) { process.stderr.write('ERROR: no answer for ' + key + '\\n'); process.exit(1); }
process.stdout.write(JSON.stringify(answers[hit]));
`;

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-office-azure-')));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'az.js'), fakeAz);
  // A shell script for Unix, and a .cmd for Windows, where resolveCommand goes by PATHEXT.
  writeFileSync(path.join(bin, 'az'), `#!/bin/sh\nexec node "$(dirname "$0")/az.js" "$@"\n`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'az.cmd'), `@node "%~dp0az.js" %*\r\n`);
  const log = path.join(root, 'az.log');
  writeFileSync(log, '');
  const answers = path.join(root, 'answers.json');
  writeFileSync(answers, '{}');
  const saved = { PATH: process.env.PATH, AZ_LOG: process.env.AZ_LOG, AZ_ANSWERS: process.env.AZ_ANSWERS };
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`;
  process.env.AZ_LOG = log;
  process.env.AZ_ANSWERS = answers;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'backend');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'develop');
  git(dir, 'remote', 'add', 'origin', 'https://woolkadevops@dev.azure.com/woolkadevops/SFN%20Forge/_git/Forge.Backend');
  return {
    dir,
    answer: (a: Record<string, unknown>) => writeFileSync(answers, JSON.stringify(a)),
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]),
  };
}

const pr = (id: number, status: string, extra: Record<string, unknown> = {}) => ({
  pullRequestId: id, title: `PR ${id}`, status, isDraft: false, sourceRefName: `refs/heads/office/pip-${id}`, targetRefName: 'refs/heads/develop',
  createdBy: { displayName: 'Tomas', uniqueName: 't@example.com' }, creationDate: '2026-09-30T15:24:15Z', description: `Part of AB#4341\n\nCloses #12`, reviewers: [], lastMergeSourceCommit: { commitId: 'abc' }, ...extra,
});

const item = (id: number, state: string, type = 'User Story', assigned?: string) => ({
  id,
  fields: { 'System.Id': id, 'System.Title': `Item ${id}`, 'System.State': state, 'System.WorkItemType': type, 'System.AssignedTo': assigned ? { displayName: assigned } : undefined, 'System.CreatedBy': { displayName: 'alejo' }, 'System.CreatedDate': '2026-05-12T17:39:15Z', 'System.ChangedDate': '2026-07-27T23:42:23Z', 'System.Tags': 'backend; urgente', 'System.CommentCount': 2, 'System.Description': '<div>Hola <b>mundo</b><br>otra línea</div>' },
});

test('an Azure DevOps remote names its organization, project and repository in every spelling', () => {
  for (const url of ['https://woolkadevops@dev.azure.com/woolkadevops/SFN%20Forge/_git/Forge.Backend', 'https://dev.azure.com/woolkadevops/SFN%20Forge/_git/Forge.Backend.git', 'https://woolkadevops.visualstudio.com/SFN%20Forge/_git/Forge.Backend', 'git@ssh.dev.azure.com:v3/woolkadevops/SFN%20Forge/Forge.Backend']) {
    assert.deepEqual(azureRemote(url), { org: 'https://dev.azure.com/woolkadevops', project: 'SFN Forge', repo: 'Forge.Backend' }, url);
    assert.equal(forgeKindOfUrl(url), 'azure');
  }
  assert.equal(azureRemote('https://github.com/acme/web.git'), undefined);
  assert.equal(forgeKindOfUrl('https://github.com/acme/web.git'), 'github');
  assert.equal(forgeKindOfUrl(undefined), 'github');
});

test('the boards show work items as issues and pull requests as PRs, in GitHub terms', async (t) => {
  const f = fixture(t);
  f.answer({
    'boards query': [item(4341, 'Closed', 'Epic'), item(4350, 'Active', 'User Story', 'alejo'), item(4351, 'New', 'Task', 'alejo'), item(4352, 'Pending Validation', 'User Story')],
    'repos pr list': [pr(2924, 'completed'), pr(2925, 'active', { reviewers: [{ vote: 10 }], isDraft: true }), pr(2926, 'active', { reviewers: [{ vote: -10 }, { vote: 10 }] }), pr(2927, 'abandoned')],
  });
  const states: { issues?: GhState<GhIssue>; pulls?: GhState<GhPull> } = {};
  const forge = new AzureDevOps(f.dir, 'https://dev.azure.com/woolkadevops/SFN%20Forge/_git/Forge.Backend', (s) => (states.issues = s), (s) => (states.pulls = s));
  assert.equal(forge.kind, 'azure');
  await forge.refresh();
  assert.equal(states.issues?.error, undefined, states.issues?.error);
  assert.equal(states.pulls?.error, undefined, states.pulls?.error);
  const issues = states.issues!.items;
  // Open ones first, then the closed; the work item's type and state ride along as labels, with its tags.
  assert.deepEqual(issues.map((i) => [i.number, i.state, i.assignees]), [[4350, 'OPEN', ['alejo']], [4351, 'OPEN', []], [4352, 'OPEN', []], [4341, 'CLOSED', []]]);
  assert.deepEqual(issues[0].labels.map((l) => l.name), ['User Story', 'Active', 'backend', 'urgente']);
  assert.equal(issues[0].url, 'https://dev.azure.com/woolkadevops/SFN%20Forge/_workitems/edit/4350');
  assert.equal(issues[0].body, 'Hola mundo\notra línea');
  assert.equal(issues[0].comments, 2);
  const wiql = f.calls().find((c) => c[0] === 'boards')!;
  assert.ok(wiql.includes('--organization') && wiql.includes('https://dev.azure.com/woolkadevops') && wiql.includes('SFN Forge'), wiql.join(' '));
  const pulls = states.pulls!.items;
  assert.deepEqual(pulls.map((p) => [p.number, p.state, p.isDraft, p.reviewDecision, p.headRefName, p.baseRefName]), [
    [2925, 'OPEN', true, 'APPROVED', 'office/pip-2925', 'develop'],
    [2926, 'OPEN', false, 'CHANGES_REQUESTED', 'office/pip-2926', 'develop'],
    [2924, 'MERGED', false, '', 'office/pip-2924', 'develop'],
    [2927, 'CLOSED', false, '', 'office/pip-2927', 'develop'],
  ]);
  assert.equal(pulls[0].url, 'https://dev.azure.com/woolkadevops/SFN%20Forge/_git/Forge.Backend/pullrequest/2925');
  assert.deepEqual(pulls[0].closes, [4341, 12]);
  assert.equal(pulls[2].headRefOid, 'abc');
});

test("a worker's branch gets its pull request on Azure DevOps, found again when it's already open", async (t) => {
  const f = fixture(t);
  const forge = forgeFor(f.dir);
  assert.equal(forge.kind, 'azure');
  f.answer({ 'repos pr list': [], 'repos pr create': pr(2930, 'active'), 'repos pr show': pr(2930, 'active', { description: 'body' }), 'repos pr update': pr(2930, 'active') });
  assert.equal(await forge.findOpenPr('office/pip-1', f.dir), undefined);
  const made = await forge.createPr('office/pip-1', 'develop', 'Stock mínimo', 'The task', f.dir);
  assert.deepEqual(made, { number: 2930, url: 'https://dev.azure.com/woolkadevops/SFN%20Forge/_git/Forge.Backend/pullrequest/2930' });
  const create = f.calls().find((c) => c[2] === 'create')!;
  for (const [flag, value] of [['--repository', 'Forge.Backend'], ['--project', 'SFN Forge'], ['--source-branch', 'office/pip-1'], ['--target-branch', 'develop'], ['--title', 'Stock mínimo'], ['--description', 'The task']]) assert.equal(create[create.indexOf(flag) + 1], value, flag);
  assert.equal(forge.prRef(made.url), made.url, 'Azure links by URL');
  assert.equal(await forge.pullBody(made.url, f.dir), 'body');
  // One line: on Windows the fake az.cmd goes through cmd.exe, whose command line can't carry a newline (the MSI's az doesn't).
  await forge.setPullBody(made.url, 'body — and the "related" list', f.dir);
  const update = f.calls().find((c) => c[2] === 'update')!;
  assert.equal(update[update.indexOf('--id') + 1], '2930');
  assert.equal(update[update.indexOf('--description') + 1], 'body — and the "related" list');
  f.answer({ 'repos pr list': [pr(2930, 'active')] });
  assert.deepEqual(await forge.findOpenPr('office/pip-1', f.dir), made);
});

test('a GitHub checkout gets the GitHub forge, and a checkout with no remote too', (t) => {
  const f = fixture(t);
  const gh = path.join(path.dirname(f.dir), 'web');
  mkdirSync(gh);
  git(gh, 'init', '-q', '-b', 'main');
  git(gh, 'remote', 'add', 'origin', 'https://github.com/acme/web.git');
  assert.equal(forgeFor(gh).kind, 'github');
  const none = path.join(path.dirname(f.dir), 'local');
  mkdirSync(none);
  git(none, 'init', '-q', '-b', 'main');
  assert.equal(forgeFor(none).kind, 'github');
});
