import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// We must avoid pulling in `vscode` at import time — gitService.ts imports it
// only for `workspace.getConfiguration`. Stub the module before requiring.
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') {
    return require.resolve('./_vscode-stub');
  }
  return originalResolve.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GitService } = require('../../src/gitService');

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdiff-test-'));
  // Deterministic default branch across git versions / host configs.
  try {
    git(root, ['init', '-b', 'main', '-q']);
  } catch {
    git(root, ['init', '-q']);
    git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  return root;
}

function commit(root: string, message: string): void {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message, '-q', '--allow-empty']);
}

describe('GitService', function () {
  this.timeout(20000);
  let root: string;
  let svc: any;

  before(() => {
    root = makeRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'first\n');
    commit(root, 'first');
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello world\n');
    commit(root, 'second');
    git(root, ['checkout', '-q', '-b', 'feature/x']);
    fs.writeFileSync(path.join(root, 'c.txt'), 'feature\n');
    commit(root, 'on feature');
    git(root, ['checkout', '-q', 'main']);
    fs.unlinkSync(path.join(root, 'b.txt'));
    commit(root, 'delete b');
    svc = new GitService();
  });

  it('resolves repo root', async () => {
    const r = await svc.repoRoot(path.join(root, 'a.txt'));
    assert.strictEqual(fs.realpathSync(r), fs.realpathSync(root));
  });

  it('lists local branches', async () => {
    const branches = await svc.listBranchesLocal(root);
    const names = branches.map((b: { name: string }) => b.name).sort();
    assert.deepStrictEqual(names, ['feature/x', 'main']);
  });

  it('lists no remote branches in a fresh repo', async () => {
    const branches = await svc.listBranchesRemote(root);
    assert.deepStrictEqual(branches, []);
  });

  it('lists commits with NUL-parsed fields incl. full + short SHA', async () => {
    const commits = await svc.listCommits(root, 10);
    assert.ok(commits.length >= 3);
    assert.strictEqual(commits[0].subject, 'delete b');
    for (const c of commits) {
      assert.match(c.shortSha, /^[0-9a-f]+$/);
      assert.match(c.fullSha, /^[0-9a-f]{40}$/);
      assert.ok(c.fullSha.startsWith(c.shortSha));
      assert.match(c.isoDate, /^\d{4}-\d{2}-\d{2}T/);
      assert.strictEqual(c.author, 'Test');
    }
  });

  it('listCommits filters by path', async () => {
    const commits = await svc.listCommits(root, 10, 'b.txt');
    const subjects = commits.map((c: { subject: string }) => c.subject);
    assert.ok(subjects.includes('first'));
    assert.ok(subjects.includes('delete b'));
    assert.ok(!subjects.includes('on feature'));
  });

  async function sha(ref: string): Promise<string> {
    return svc.verifyRef(root, ref);
  }

  it('verifyRef returns full 40-char SHA for branch', async () => {
    const s = await sha('main');
    assert.match(s, /^[0-9a-f]{40}$/);
  });

  it('verifyRef rejects unknown refs', async () => {
    await assert.rejects(sha('nosuchref'));
  });

  it('verifyRef rejects refs starting with -', async () => {
    await assert.rejects(sha('--help'));
    await assert.rejects(sha('-foo'));
  });

  it('pathExistsAtRef true for present file', async () => {
    assert.strictEqual(await svc.pathExistsAtRef(root, await sha('main'), 'a.txt'), true);
  });

  it('pathExistsAtRef false for deleted file at HEAD', async () => {
    assert.strictEqual(await svc.pathExistsAtRef(root, await sha('main'), 'b.txt'), false);
  });

  it('pathExistsAtRef true for deleted file at older commit', async () => {
    const commits = await svc.listCommits(root, 10);
    const second = commits.find((c: { subject: string }) => c.subject === 'second');
    assert.ok(second);
    assert.strictEqual(await svc.pathExistsAtRef(root, await sha(second.shortSha), 'b.txt'), true);
  });

  it('showFileAtSha returns text content', async () => {
    const r = await svc.showFileAtSha(root, await sha('main'), 'a.txt');
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.kind, 'text');
    assert.strictEqual(r.bytes.toString('utf8'), 'hello world\n');
  });

  it('showFileAtSha marks missing file as not-exists', async () => {
    const r = await svc.showFileAtSha(root, await sha('main'), 'b.txt');
    assert.strictEqual(r.exists, false);
    assert.strictEqual(r.bytes.length, 0);
  });

  it('showFileAtSha detects binary content', async () => {
    fs.writeFileSync(
      path.join(root, 'bin.dat'),
      Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]),
    );
    commit(root, 'add binary');
    const r = await svc.showFileAtSha(root, await sha('main'), 'bin.dat');
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.kind, 'binary');
  });

  it('reads from feature branch with slash in name', async () => {
    const r = await svc.showFileAtSha(root, await sha('feature/x'), 'c.txt');
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.bytes.toString('utf8'), 'feature\n');
  });
});
