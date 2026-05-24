import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { commit, git, makeRepo, settle } from './helpers';
import { filterFiles } from '../../../src/changedFilesProvider';
import type { GitDiffExports } from '../../../src/extension';

async function getApi(): Promise<GitDiffExports> {
  const ext = vscode.extensions.getExtension('tigercosmos.gitdiff');
  assert.ok(ext, 'extension not found');
  if (!ext!.isActive) {
    await ext!.activate();
  }
  return ext!.exports as GitDiffExports;
}

describe('changedFiles provider (e2e)', function () {
  this.timeout(30000);

  it('exports the provider via extension API', async () => {
    const api = await getApi();
    assert.ok(api.changedFiles, 'changedFiles provider must be exposed');
    assert.strictEqual(typeof api.changedFiles.setTarget, 'function');
    assert.strictEqual(typeof api.changedFiles.refresh, 'function');
    assert.strictEqual(typeof api.changedFiles.getAllFiles, 'function');
  });

  it('lists working-tree changes against a target after setTarget', async () => {
    const api = await getApi();
    const root = makeRepo();
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'b.ts'), 'export const b = 2;\n');
    commit(root, 'baseline');
    // Working-tree changes.
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 99;\n');
    fs.writeFileSync(path.join(root, 'c.md'), 'untracked doc\n');
    const headFull = git(root, ['rev-parse', 'HEAD']).trim();

    await api.changedFiles.setTarget(
      { ref: headFull, display: headFull.slice(0, 8) },
      fs.realpathSync(root),
    );
    await settle(50);

    const files = api.changedFiles.getAllFiles();
    const byPath = new Map(files.map((f) => [f.relPath, f.status]));
    assert.strictEqual(byPath.get('a.ts'), 'M');
    assert.strictEqual(byPath.get('c.md'), '?');
    assert.ok(!byPath.has('b.ts'));

    await api.changedFiles.clearTarget();
  });

  it('excludes files inside a sibling worktree nested in the main repo', async () => {
    const api = await getApi();
    const root = makeRepo();
    fs.writeFileSync(path.join(root, 'main.ts'), 'main\n');
    commit(root, 'baseline');
    // Create a linked worktree at root/wt-feature pointing at a new branch.
    git(root, ['branch', 'feature']);
    git(root, ['worktree', 'add', '-q', path.join(root, 'wt-feature'), 'feature']);
    // Touch files in BOTH worktrees.
    fs.writeFileSync(path.join(root, 'main.ts'), 'main changed\n');
    fs.writeFileSync(path.join(root, 'wt-feature', 'inside.txt'), 'wt-only\n');
    // Also an untracked file in the main worktree.
    fs.writeFileSync(path.join(root, 'untracked-main.txt'), 'main-untracked\n');
    const headFull = git(root, ['rev-parse', 'HEAD']).trim();

    await api.changedFiles.setTarget(
      { ref: headFull, display: headFull.slice(0, 8) },
      fs.realpathSync(root),
    );
    await settle(50);

    const files = api.changedFiles.getAllFiles();
    const paths = files.map((f) => f.relPath);
    assert.ok(paths.includes('main.ts'), 'main.ts must be listed');
    assert.ok(
      paths.includes('untracked-main.txt'),
      'main-worktree untracked file must be listed',
    );
    // The sibling worktree's untracked file must NOT appear.
    assert.ok(
      !paths.some((p) => p.startsWith('wt-feature/')),
      `nested worktree files should be excluded, got ${JSON.stringify(paths)}`,
    );

    await api.changedFiles.clearTarget();
  });

  it('filterFiles narrows the list by search content (literal, case-insensitive default)', async () => {
    const api = await getApi();
    const root = makeRepo();
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const TARGET = 1;\n');
    fs.writeFileSync(path.join(root, 'b.ts'), 'export const other = 2;\n');
    fs.writeFileSync(path.join(root, 'c.ts'), 'target appears in this comment\n');
    commit(root, 'init');
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const TARGET = 99;\n');
    fs.writeFileSync(path.join(root, 'b.ts'), 'export const other = 22;\n');
    fs.writeFileSync(path.join(root, 'c.ts'), 'target appears here too\n');
    const headFull = git(root, ['rev-parse', 'HEAD']).trim();

    await api.changedFiles.setTarget(
      { ref: headFull, display: headFull.slice(0, 8) },
      fs.realpathSync(root),
    );
    await settle(50);
    const files = api.changedFiles.getAllFiles();

    const all = await filterFiles(files, {
      search: 'target',
      include: '',
      exclude: '',
      matchCase: false,
      matchWholeWord: false,
      useRegex: false,
    });
    const matched = all.files.map((f) => f.relPath).sort();
    assert.deepStrictEqual(matched, ['a.ts', 'c.ts']);

    const sensitive = await filterFiles(files, {
      search: 'target',
      include: '',
      exclude: '',
      matchCase: true,
      matchWholeWord: false,
      useRegex: false,
    });
    assert.deepStrictEqual(
      sensitive.files.map((f) => f.relPath).sort(),
      ['c.ts'],
      'case-sensitive should drop a.ts which only has TARGET in caps',
    );

    await api.changedFiles.clearTarget();
  });

  it('filterFiles applies include/exclude glob patterns to paths', async () => {
    const api = await getApi();
    const root = makeRepo();
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'test'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a\n');
    fs.writeFileSync(path.join(root, 'src', 'a.test.ts'), 'test\n');
    fs.writeFileSync(path.join(root, 'test', 'b.test.ts'), 'test\n');
    fs.writeFileSync(path.join(root, 'README.md'), 'doc\n');
    commit(root, 'init');
    // Modify all so they show up as changed.
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a2\n');
    fs.writeFileSync(path.join(root, 'src', 'a.test.ts'), 'test2\n');
    fs.writeFileSync(path.join(root, 'test', 'b.test.ts'), 'test2\n');
    fs.writeFileSync(path.join(root, 'README.md'), 'doc2\n');
    const headFull = git(root, ['rev-parse', 'HEAD']).trim();

    await api.changedFiles.setTarget(
      { ref: headFull, display: headFull.slice(0, 8) },
      fs.realpathSync(root),
    );
    await settle(50);
    const files = api.changedFiles.getAllFiles();

    const onlyTs = await filterFiles(files, {
      search: '',
      include: '**/*.ts',
      exclude: '**/*.test.ts',
      matchCase: false,
      matchWholeWord: false,
      useRegex: false,
    });
    assert.deepStrictEqual(
      onlyTs.files.map((f) => f.relPath).sort(),
      ['src/a.ts'],
    );

    await api.changedFiles.clearTarget();
  });

  it('does not leak stale files when target changes mid-refresh', async () => {
    const api = await getApi();
    const rootA = makeRepo();
    fs.writeFileSync(path.join(rootA, 'only-in-A.ts'), 'a\n');
    commit(rootA, 'init A');
    fs.writeFileSync(path.join(rootA, 'only-in-A.ts'), 'a2\n');
    const shaA = git(rootA, ['rev-parse', 'HEAD']).trim();

    const rootB = makeRepo();
    fs.writeFileSync(path.join(rootB, 'only-in-B.ts'), 'b\n');
    commit(rootB, 'init B');
    fs.writeFileSync(path.join(rootB, 'only-in-B.ts'), 'b2\n');
    const shaB = git(rootB, ['rev-parse', 'HEAD']).trim();

    // Kick off refresh A, then immediately replace with target B. Even if the
    // git call for A resolves later, the post-await guard must drop its result.
    const pA = api.changedFiles.setTarget(
      { ref: shaA, display: shaA.slice(0, 8) },
      fs.realpathSync(rootA),
    );
    const pB = api.changedFiles.setTarget(
      { ref: shaB, display: shaB.slice(0, 8) },
      fs.realpathSync(rootB),
    );
    await Promise.all([pA, pB]);
    await settle(80);

    const paths = api.changedFiles.getAllFiles().map((f) => f.relPath);
    assert.ok(
      paths.includes('only-in-B.ts'),
      `final state should reflect target B, got ${JSON.stringify(paths)}`,
    );
    assert.ok(
      !paths.includes('only-in-A.ts'),
      `stale target A file must not leak into target B, got ${JSON.stringify(paths)}`,
    );

    await api.changedFiles.clearTarget();
  });

  it('filterFiles regex mode handles a valid pattern and surfaces an error for an invalid one', async () => {
    const api = await getApi();
    const root = makeRepo();
    fs.writeFileSync(path.join(root, 'r.ts'), 'value: 1234\n');
    commit(root, 'init');
    fs.writeFileSync(path.join(root, 'r.ts'), 'value: 5678\n');
    const headFull = git(root, ['rev-parse', 'HEAD']).trim();

    await api.changedFiles.setTarget(
      { ref: headFull, display: headFull.slice(0, 8) },
      fs.realpathSync(root),
    );
    await settle(50);
    const files = api.changedFiles.getAllFiles();

    const valid = await filterFiles(files, {
      search: 'value:\\s*\\d+',
      include: '',
      exclude: '',
      matchCase: false,
      matchWholeWord: false,
      useRegex: true,
    });
    assert.strictEqual(valid.files.length, 1);
    assert.strictEqual(valid.error, undefined);

    const invalid = await filterFiles(files, {
      search: '[bad',
      include: '',
      exclude: '',
      matchCase: false,
      matchWholeWord: false,
      useRegex: true,
    });
    assert.ok(invalid.error, 'invalid regex should produce an error');
    // Path filters were no-ops; everything passes path filter.
    assert.strictEqual(invalid.files.length, files.length);

    await api.changedFiles.clearTarget();
  });
});
