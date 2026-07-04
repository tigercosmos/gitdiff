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
const {
  GitService,
  parseBlameLinePorcelain,
  parseNameStatusZ,
  unquoteGitPath,
} = require('../../src/gitService');

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
  // Pin LF on all platforms: Windows CI defaults core.autocrlf=true, which
  // makes `git checkout` write CRLF and breaks content assertions.
  git(root, ['config', 'core.autocrlf', 'false']);
  // Pin rename detection on so the rename-revert tests are deterministic
  // regardless of the host/CI `diff.renames` config (production relies on the
  // git default rather than forcing `-M`; see GitService.listChangedPaths).
  git(root, ['config', 'diff.renames', 'true']);
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
    assert.strictEqual(fs.realpathSync.native(r), fs.realpathSync.native(root));
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

  it('verifyRef accepts a tag and returns its commit SHA', async () => {
    git(root, ['tag', 'v1']);
    const tagSha = await sha('v1');
    const headSha = await sha('main');
    assert.strictEqual(tagSha, headSha);
  });

  it('verifyRef accepts a short SHA', async () => {
    const commits = await svc.listCommits(root, 1);
    const shortSha = commits[0].shortSha;
    const full = await sha(shortSha);
    assert.strictEqual(full, commits[0].fullSha);
  });

  it('verifyRef rejects empty and whitespace-only refs', async () => {
    await assert.rejects(sha(''));
    await assert.rejects(sha('   '));
  });

  it('listCommits respects the limit', async () => {
    const limited = await svc.listCommits(root, 1);
    assert.strictEqual(limited.length, 1);
  });

  it('parseBlameLinePorcelain returns author and commit summary', () => {
    const parsed = parseBlameLinePorcelain(
      [
        '0123456789abcdef0123456789abcdef01234567 3 1 1',
        'author Jane Doe',
        'author-mail <jane@example.com>',
        'author-time 1780759591',
        'author-tz +0800',
        'committer Someone Else',
        'summary Add useful feature',
        'filename a.txt',
        '\tline text',
      ].join('\n'),
    );

    assert.deepStrictEqual(parsed, {
      fullSha: '0123456789abcdef0123456789abcdef01234567',
      shortSha: '01234567',
      author: 'Jane Doe',
      summary: 'Add useful feature',
      authorTime: 1780759591,
      authorTz: '+0800',
      filename: 'a.txt',
    });
  });

  it('unquoteGitPath leaves an unquoted path untouched', () => {
    assert.strictEqual(unquoteGitPath('src/a.ts'), 'src/a.ts');
    assert.strictEqual(unquoteGitPath('dir/with spaces.txt'), 'dir/with spaces.txt');
  });

  it('unquoteGitPath decodes C-quoted octal UTF-8 (default core.quotePath)', () => {
    // git's quoting of `src/café-日.txt`
    assert.strictEqual(
      unquoteGitPath('"src/caf\\303\\251-\\346\\227\\245.txt"'),
      'src/café-日.txt',
    );
  });

  it('unquoteGitPath decodes simple escapes (\\t, \\", \\\\)', () => {
    assert.strictEqual(unquoteGitPath('"a\\tb"'), 'a\tb');
    assert.strictEqual(unquoteGitPath('"a\\"b"'), 'a"b');
    assert.strictEqual(unquoteGitPath('"a\\\\b"'), 'a\\b');
  });

  it('parseBlameLinePorcelain decodes a C-quoted filename', () => {
    const parsed = parseBlameLinePorcelain(
      [
        '0123456789abcdef0123456789abcdef01234567 1 1 1',
        'author Jane Doe',
        'author-time 1780759591',
        'author-tz +0800',
        'summary unicode path',
        'filename "src/caf\\303\\251.txt"',
        '\tline',
      ].join('\n'),
    );
    assert.strictEqual(parsed.filename, 'src/café.txt');
  });

  it('parseBlameLinePorcelain captures the filename at the blamed commit (rename case)', () => {
    const parsed = parseBlameLinePorcelain(
      [
        '0123456789abcdef0123456789abcdef01234567 3 1 1',
        'author Jane Doe',
        'author-time 1780759591',
        'author-tz +0800',
        'summary Pre-rename change',
        'filename old/path.txt',
        '\tline text',
      ].join('\n'),
    );
    // The line predates a rename: the path here is the file's *old* name, which
    // is what callers must use to open `sha:<filename>`.
    assert.strictEqual(parsed.filename, 'old/path.txt');
  });

  it('blameLine reports author and commit summary for a line at HEAD', async () => {
    const info = await svc.blameLine(root, 'a.txt', 1, 'HEAD');
    assert.ok(info);
    assert.strictEqual(info.author, 'Test');
    assert.strictEqual(info.summary, 'second');
    assert.match(info.fullSha, /^[0-9a-f]{40}$/);
  });

  it('blameLine reports author and commit summary for a line at a target ref', async () => {
    const commits = await svc.listCommits(root, 10);
    const first = commits.find((c: { subject: string }) => c.subject === 'first');
    assert.ok(first);

    const info = await svc.blameLine(root, 'b.txt', 1, first.fullSha);
    assert.ok(info);
    assert.strictEqual(info.author, 'Test');
    assert.strictEqual(info.summary, 'first');
    assert.strictEqual(info.fullSha, first.fullSha);
  });

  it('blameLineForContents maps blame to supplied unsaved contents', async () => {
    const info = await svc.blameLineForContents(
      root,
      'a.txt',
      2,
      'unsaved insertion\nhello world\n',
    );
    assert.ok(info);
    assert.strictEqual(info.author, 'Test');
    assert.strictEqual(info.summary, 'second');
  });

  it('listCommits rejects in an empty repo (no HEAD commits)', async () => {
    const empty = makeRepo();
    await assert.rejects(svc.listCommits(empty, 10));
  });

  it('relPath returns POSIX-style repo-relative path', async () => {
    // relPath canonicalizes the containing dir via realpathSync, so compare
    // against a canonicalized repo root (macOS /var ↔ /private/var).
    const canonRoot = fs.realpathSync.native(root);
    const rel = svc.relPath(canonRoot, path.join(root, 'a.txt'));
    assert.strictEqual(rel, 'a.txt');
  });

  it('relPath joins nested directories with forward slashes', async () => {
    const canonRoot = fs.realpathSync.native(root);
    const sub = path.join(root, 'sub', 'dir');
    fs.mkdirSync(sub, { recursive: true });
    const rel = svc.relPath(canonRoot, path.join(sub, 'nested.ts'));
    assert.strictEqual(rel, 'sub/dir/nested.ts');
  });

  it('relPath returns empty for the repo root directory itself', async () => {
    // The changed-files sidebar passes the workspace folder (a directory) when
    // no editor is active; equal-to-root must yield '' (no path filter), not a
    // bogus basename-appended pathspec.
    const canonRoot = fs.realpathSync.native(root);
    assert.strictEqual(svc.relPath(canonRoot, root), '');
  });

  it('relPath returns the subdir path for a directory inside the repo', async () => {
    const canonRoot = fs.realpathSync.native(root);
    const sub = path.join(root, 'sub', 'dir');
    fs.mkdirSync(sub, { recursive: true });
    assert.strictEqual(svc.relPath(canonRoot, sub), 'sub/dir');
  });

  it('relPath resolves a symlinked directory to its target (yields empty at root)', async () => {
    // A symlinked workspace folder: repoRoot resolves to git's realpath, so
    // relPath must canonicalize the *whole* directory (including the symlink
    // final component) to line up — otherwise it re-appends the unresolved
    // symlink basename and produces an outside-repo pathspec.
    const canonRoot = fs.realpathSync.native(root);
    const link = path.join(os.tmpdir(), `gitdiff-link-${path.basename(root)}`);
    try {
      fs.symlinkSync(root, link, 'dir');
    } catch {
      // Some platforms/CI restrict symlink creation; skip rather than fail.
      return;
    }
    try {
      assert.strictEqual(svc.relPath(canonRoot, link), '');
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it('listChangedPaths reports working-tree differences vs a ref', async () => {
    const wt = makeRepo();
    fs.writeFileSync(path.join(wt, 'kept.txt'), 'kept\n');
    fs.writeFileSync(path.join(wt, 'modify.txt'), 'before\n');
    fs.writeFileSync(path.join(wt, 'remove.txt'), 'gone soon\n');
    commit(wt, 'baseline');
    fs.writeFileSync(path.join(wt, 'modify.txt'), 'after\n');
    fs.writeFileSync(path.join(wt, 'added.txt'), 'new\n');
    git(wt, ['add', 'added.txt']);
    fs.unlinkSync(path.join(wt, 'remove.txt'));
    git(wt, ['rm', '--quiet', 'remove.txt']);

    const changes = await svc.listChangedPaths(wt, 'HEAD');
    const byPath = new Map<string, string>(
      changes.map((c: { relPath: string; status: string }) => [c.relPath, c.status]),
    );
    assert.strictEqual(byPath.get('modify.txt'), 'M');
    assert.strictEqual(byPath.get('added.txt'), 'A');
    assert.strictEqual(byPath.get('remove.txt'), 'D');
    assert.ok(!byPath.has('kept.txt'));
  });

  it('revertFileToRef restores a modified file to its content at the ref', async () => {
    const wt = makeRepo();
    fs.writeFileSync(path.join(wt, 'modify.txt'), 'before\n');
    commit(wt, 'baseline');
    fs.writeFileSync(path.join(wt, 'modify.txt'), 'after\n');

    await svc.revertFileToRef(wt, 'HEAD', 'modify.txt');
    assert.strictEqual(fs.readFileSync(path.join(wt, 'modify.txt'), 'utf8'), 'before\n');
    const changes = await svc.listChangedPaths(wt, 'HEAD');
    assert.ok(!changes.some((c: { relPath: string }) => c.relPath === 'modify.txt'));
  });

  it('revertFileToRef recreates a file deleted in the working tree', async () => {
    const wt = makeRepo();
    fs.writeFileSync(path.join(wt, 'remove.txt'), 'keepme\n');
    commit(wt, 'baseline');
    fs.unlinkSync(path.join(wt, 'remove.txt'));
    git(wt, ['rm', '--quiet', 'remove.txt']);

    await svc.revertFileToRef(wt, 'HEAD', 'remove.txt');
    assert.strictEqual(fs.readFileSync(path.join(wt, 'remove.txt'), 'utf8'), 'keepme\n');
  });

  it('revertFileToRef deletes a staged addition absent from the ref', async () => {
    const wt = makeRepo();
    fs.writeFileSync(path.join(wt, 'seed.txt'), 'seed\n');
    commit(wt, 'baseline');
    fs.writeFileSync(path.join(wt, 'added.txt'), 'new\n');
    git(wt, ['add', 'added.txt']);

    await svc.revertFileToRef(wt, 'HEAD', 'added.txt');
    assert.ok(!fs.existsSync(path.join(wt, 'added.txt')));
    const changes = await svc.listChangedPaths(wt, 'HEAD');
    assert.ok(!changes.some((c: { relPath: string }) => c.relPath === 'added.txt'));
  });

  it('revertFileToRef deletes an untracked file absent from the ref', async () => {
    const wt = makeRepo();
    fs.writeFileSync(path.join(wt, 'seed.txt'), 'seed\n');
    commit(wt, 'baseline');
    fs.writeFileSync(path.join(wt, 'untracked.txt'), 'y\n');

    await svc.revertFileToRef(wt, 'HEAD', 'untracked.txt');
    assert.ok(!fs.existsSync(path.join(wt, 'untracked.txt')));
  });

  it('revertFileToRef treats glob metacharacters in the path literally', async () => {
    const wt = makeRepo();
    // A file literally named with a bracket, plus a sibling a glob would catch.
    fs.writeFileSync(path.join(wt, 'a[1].txt'), 'orig\n');
    fs.writeFileSync(path.join(wt, 'a1.txt'), 'sibling\n');
    commit(wt, 'baseline');
    fs.writeFileSync(path.join(wt, 'a[1].txt'), 'changed\n');
    fs.writeFileSync(path.join(wt, 'a1.txt'), 'sibling changed\n');

    await svc.revertFileToRef(wt, 'HEAD', 'a[1].txt');
    // Only the literal target is reverted; the glob-adjacent sibling is left.
    assert.strictEqual(fs.readFileSync(path.join(wt, 'a[1].txt'), 'utf8'), 'orig\n');
    assert.strictEqual(fs.readFileSync(path.join(wt, 'a1.txt'), 'utf8'), 'sibling changed\n');
  });

  it('revertFileToRef deletes a metachar-named addition without harming a glob-adjacent sibling', async () => {
    const wt = makeRepo();
    // `a1.txt` is committed (a glob `a[1].txt` would match it); the literal
    // `a[1].txt` is a NEW working-tree addition absent from HEAD.
    fs.writeFileSync(path.join(wt, 'a1.txt'), 'committed\n');
    commit(wt, 'baseline');
    fs.writeFileSync(path.join(wt, 'a[1].txt'), 'new addition\n');

    // Existence gate must report the literal addition as absent (not confuse
    // it with the committed sibling), so revert takes the delete branch.
    assert.strictEqual(await svc.pathExistsAtRef(wt, 'HEAD', 'a[1].txt'), false);
    assert.strictEqual(await svc.pathExistsAtRef(wt, 'HEAD', 'a1.txt'), true);

    await svc.revertFileToRef(wt, 'HEAD', 'a[1].txt');
    assert.ok(!fs.existsSync(path.join(wt, 'a[1].txt')), 'the literal addition is deleted');
    assert.ok(fs.existsSync(path.join(wt, 'a1.txt')), 'the glob-adjacent sibling survives');
    assert.strictEqual(fs.readFileSync(path.join(wt, 'a1.txt'), 'utf8'), 'committed\n');
  });

  it('revertFileToRef removes a directory-shaped untracked entry absent from the ref', async () => {
    const wt = makeRepo();
    fs.writeFileSync(path.join(wt, 'seed.txt'), 'seed\n');
    commit(wt, 'baseline');
    // A directory git would surface as a single changed/untracked path (the
    // shape an embedded repo / added gitlink takes). fs.rm must recurse.
    fs.mkdirSync(path.join(wt, 'vendor'));
    fs.writeFileSync(path.join(wt, 'vendor', 'inner.txt'), 'x\n');

    await svc.revertFileToRef(wt, 'HEAD', 'vendor');
    assert.ok(!fs.existsSync(path.join(wt, 'vendor')), 'directory entry should be removed');
  });

  it('revertFileToRef of a rename restores the old name and removes the new one', async () => {
    const wt = makeRepo();
    fs.writeFileSync(path.join(wt, 'old.txt'), 'line1\nline2\nline3\nline4\nline5\n');
    commit(wt, 'baseline');
    // Rename old.txt -> new.txt and stage it (content unchanged so git detects
    // a rename, not add+delete). Staging is what makes `git diff HEAD` surface
    // an `R` row — an unstaged new file is untracked and excluded from diff.
    fs.renameSync(path.join(wt, 'old.txt'), path.join(wt, 'new.txt'));
    git(wt, ['add', '-A']);

    // Sanity: the diff vs HEAD surfaces a rename with old.txt as origPath.
    const changes = await svc.listChangedPaths(wt, 'HEAD');
    const rename = changes.find((c: { status: string }) => c.status === 'R');
    assert.ok(rename, 'expected a rename entry');
    assert.strictEqual(rename.relPath, 'new.txt');
    assert.strictEqual(rename.origPath, 'old.txt');

    await svc.revertFileToRef(wt, 'HEAD', 'new.txt', 'old.txt');
    assert.ok(!fs.existsSync(path.join(wt, 'new.txt')), 'new name should be gone');
    assert.ok(fs.existsSync(path.join(wt, 'old.txt')), 'old name should be restored');
    // Working tree now matches HEAD: no remaining differences.
    const after = await svc.listChangedPaths(wt, 'HEAD');
    assert.strictEqual(after.length, 0, `expected clean tree, got ${JSON.stringify(after)}`);
  });

  it('revertFileToRef of a case-only rename restores the target name and leaves a clean tree', async () => {
    const wt = makeRepo();
    fs.writeFileSync(path.join(wt, 'Foo.ts'), 'content\n');
    commit(wt, 'baseline');
    // Case-only rename. On a case-insensitive FS (default macOS/Windows) both
    // names share one inode; the revert must not delete the restored file.
    // `-f` because git otherwise refuses ("destination exists") when the
    // case-insensitive FS reports `foo.ts` as already present.
    git(wt, ['mv', '-f', 'Foo.ts', 'foo.ts']);
    const rename = (await svc.listChangedPaths(wt, 'HEAD')).find(
      (c: { status: string }) => c.status === 'R',
    );
    assert.ok(rename, 'expected a rename entry');

    await svc.revertFileToRef(wt, 'HEAD', rename.relPath, rename.origPath);
    assert.ok(fs.existsSync(path.join(wt, 'Foo.ts')), 'target-cased name must survive');
    assert.strictEqual(fs.readFileSync(path.join(wt, 'Foo.ts'), 'utf8'), 'content\n');
    const after = await svc.listChangedPaths(wt, 'HEAD');
    assert.strictEqual(after.length, 0, `expected clean tree, got ${JSON.stringify(after)}`);
  });

  it('revertFileToRef of a renamed symlink removes the new link (lstat, not stat)', async () => {
    const wt = makeRepo();
    fs.writeFileSync(path.join(wt, 'target.txt'), 'target\n');
    try {
      fs.symlinkSync('target.txt', path.join(wt, 'link-old'));
    } catch {
      // Some platforms/CI (Windows without privilege) restrict symlinks; skip.
      return;
    }
    commit(wt, 'baseline');
    // Rename the symlink. Old and new links point at the same target, so a
    // target-following stat would conflate them; lstat keeps them distinct.
    git(wt, ['mv', 'link-old', 'link-new']);
    const rename = (await svc.listChangedPaths(wt, 'HEAD')).find(
      (c: { status: string }) => c.status === 'R',
    );
    assert.ok(rename, 'expected a rename entry');
    assert.strictEqual(rename.relPath, 'link-new');

    await svc.revertFileToRef(wt, 'HEAD', rename.relPath, rename.origPath);
    assert.ok(!fs.existsSync(path.join(wt, 'link-new')), 'new link must be removed');
    assert.ok(fs.lstatSync(path.join(wt, 'link-old')).isSymbolicLink(), 'old link restored');
    const after = await svc.listChangedPaths(wt, 'HEAD');
    assert.strictEqual(after.length, 0, `expected clean tree, got ${JSON.stringify(after)}`);
  });

  it('revertFileToRef rejects refs beginning with "-"', async () => {
    await assert.rejects(svc.revertFileToRef(root, '-rf', 'a.txt'));
  });

  it('listUntrackedPaths returns only untracked files', async () => {
    const wt = makeRepo();
    fs.writeFileSync(path.join(wt, 'tracked.txt'), 'x\n');
    commit(wt, 'baseline');
    fs.writeFileSync(path.join(wt, 'untracked.txt'), 'y\n');
    fs.writeFileSync(path.join(wt, '.gitignore'), 'ignored.txt\n');
    fs.writeFileSync(path.join(wt, 'ignored.txt'), 'z\n');

    const untracked = await svc.listUntrackedPaths(wt);
    assert.ok(untracked.includes('untracked.txt'));
    assert.ok(!untracked.includes('tracked.txt'));
    assert.ok(!untracked.includes('ignored.txt'));
  });

  it('pathExistsAtRef rejects unknown SHAs', async () => {
    await assert.rejects(
      svc.pathExistsAtRef(root, '0000000000000000000000000000000000000000', 'a.txt'),
    );
  });

  // NOTE: these comparisons use fs.realpathSync.native (not plain
  // realpathSync). On Windows the legacy realpathSync preserves the input's
  // drive-letter case, so a git-sourced path ("C:\…") and an os.tmpdir()-
  // sourced path ("c:\…") fail to string-match even though they're the same
  // directory. .native canonicalizes the drive case (and is what the
  // "resolves repo root" test above already relies on).
  it('listWorktrees returns at least the main worktree path', async () => {
    const wts: string[] = await svc.listWorktrees(root);
    assert.ok(wts.length >= 1);
    const canon = wts.map((w: string) => fs.realpathSync.native(w));
    assert.ok(canon.some((p: string) => p === fs.realpathSync.native(root)));
  });

  it('listWorktrees returns both the main and linked nested worktrees', async () => {
    const wt = makeRepo();
    fs.writeFileSync(path.join(wt, 'seed.txt'), 'seed\n');
    commit(wt, 'seed');
    // Create a branch and add a linked worktree nested inside the main repo.
    git(wt, ['branch', 'feature']);
    git(wt, ['worktree', 'add', '-q', path.join(wt, 'wt-feature'), 'feature']);

    const wts: string[] = await svc.listWorktrees(wt);
    const canon = wts.map((w: string) => fs.realpathSync.native(w));
    assert.ok(canon.some((p: string) => p === fs.realpathSync.native(wt)));
    assert.ok(canon.some((p: string) => p === fs.realpathSync.native(path.join(wt, 'wt-feature'))));
  });

  it('listWorktrees skips prunable (stale) worktree records', async () => {
    const wt = makeRepo();
    fs.writeFileSync(path.join(wt, 'seed.txt'), 'seed\n');
    commit(wt, 'seed');
    git(wt, ['branch', 'feature']);
    const linkedPath = path.join(wt, 'wt-stale');
    git(wt, ['worktree', 'add', '-q', linkedPath, 'feature']);
    // Physically remove the worktree directory; `git worktree list` now
    // reports it as `prunable` until `git worktree prune` runs.
    fs.rmSync(linkedPath, { recursive: true, force: true });

    const wts: string[] = await svc.listWorktrees(wt);
    const canon = wts.map((w: string) => {
      try {
        return fs.realpathSync.native(w);
      } catch {
        return w;
      }
    });
    // Main repo is still listed; the stale linked path must NOT appear (else
    // computeWorktreeExclusion would hide a new dir with the same name).
    assert.ok(canon.some((p: string) => p === fs.realpathSync.native(wt)));
    assert.ok(
      !canon.some((p: string) => p.endsWith('wt-stale')),
      `prunable worktree must be dropped, got ${JSON.stringify(canon)}`,
    );
  });
});

describe('GitService.repoRoot worktree resolution', function () {
  this.timeout(20000);
  const svc = new GitService();

  // Regression: repoRoot() used to unconditionally path.dirname() its
  // argument, assuming it was a file. The changed-files sidebar hands it the
  // workspace *folder* (a directory) when no editor is active, so dirname()
  // climbed one level above the worktree — into the main repo for a nested
  // worktree, or a non-repo parent for a sibling. The fix uses a directory
  // argument as-is. These tests pin that behaviour against real worktrees.

  function setupMainWithWorktrees(): {
    main: string;
    nested: string;
    sibling: string;
  } {
    const main = makeRepo();
    fs.writeFileSync(path.join(main, 'seed.txt'), 'seed\n');
    commit(main, 'seed');
    git(main, ['branch', 'feat-nested']);
    git(main, ['branch', 'feat-sibling']);
    // Nested: lives inside the main repo's working tree — dirname() of this
    // path is the main repo root, which is what used to break resolution.
    const nested = path.join(main, 'nested-wt');
    git(main, ['worktree', 'add', '-q', nested, 'feat-nested']);
    // Sibling: lives next to the main repo (dirname() is a non-repo tmp dir).
    const sibling = path.join(main, '..', `sibling-wt-${path.basename(main)}`);
    git(main, ['worktree', 'add', '-q', sibling, 'feat-sibling']);
    return { main, nested, sibling };
  }

  it('resolves a nested worktree directory to itself, not the main repo', async () => {
    const { main, nested } = setupMainWithWorktrees();
    const resolved = await svc.repoRoot(nested);
    assert.strictEqual(
      fs.realpathSync.native(resolved),
      fs.realpathSync.native(nested),
      'nested worktree folder must resolve to the worktree, not the parent main repo',
    );
    assert.notStrictEqual(
      fs.realpathSync.native(resolved),
      fs.realpathSync.native(main),
    );
  });

  it('resolves a sibling worktree directory to itself', async () => {
    const { sibling } = setupMainWithWorktrees();
    const resolved = await svc.repoRoot(sibling);
    assert.strictEqual(
      fs.realpathSync.native(resolved),
      fs.realpathSync.native(sibling),
    );
  });

  it('resolves a file inside a nested worktree to that worktree', async () => {
    const { nested } = setupMainWithWorktrees();
    const file = path.join(nested, 'seed.txt');
    const resolved = await svc.repoRoot(file);
    assert.strictEqual(
      fs.realpathSync.native(resolved),
      fs.realpathSync.native(nested),
    );
  });

  it('resolves the main repo directory to the main repo root', async () => {
    const { main } = setupMainWithWorktrees();
    const resolved = await svc.repoRoot(main);
    assert.strictEqual(
      fs.realpathSync.native(resolved),
      fs.realpathSync.native(main),
    );
  });

  it('changed paths from a nested worktree reflect the worktree HEAD, not the main repo', async () => {
    const { nested } = setupMainWithWorktrees();
    // Modify a file in the worktree only; the main repo's tree is untouched.
    fs.writeFileSync(path.join(nested, 'seed.txt'), 'changed-in-worktree\n');
    const repoRoot = await svc.repoRoot(nested);
    const changes = await svc.listChangedPaths(repoRoot, 'HEAD');
    const paths = changes.map((c: { relPath: string }) => c.relPath);
    assert.ok(
      paths.includes('seed.txt'),
      `expected worktree edit to show as changed vs its own HEAD, got ${JSON.stringify(paths)}`,
    );
  });
});

describe('GitService.gitDir', function () {
  this.timeout(20000);
  const svc = new GitService();

  it('resolves the main repo gitdir to <root>/.git', async () => {
    const root = makeRepo();
    commit(root, 'seed');
    const dir = await svc.gitDir(root);
    assert.strictEqual(
      fs.realpathSync.native(dir),
      fs.realpathSync.native(path.join(root, '.git')),
    );
  });

  it("resolves a linked worktree to its own gitdir (where its HEAD/index live), not the main .git", async () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
    commit(root, 'seed');
    git(root, ['branch', 'feature']);
    const wt = path.join(root, 'wt-feature');
    git(root, ['worktree', 'add', '-q', wt, 'feature']);

    const dir = await svc.gitDir(wt);
    // The worktree's gitdir contains its own HEAD and index — the files the
    // auto-refresh watcher needs to observe for THIS worktree.
    assert.ok(fs.existsSync(path.join(dir, 'HEAD')), `no HEAD in ${dir}`);
    assert.notStrictEqual(
      fs.realpathSync.native(dir),
      fs.realpathSync.native(path.join(root, '.git')),
    );
    assert.match(dir.replace(/\\/g, '/'), /\/worktrees\//);
  });
});

describe('GitService.isBranch', function () {
  this.timeout(20000);
  const svc = new GitService();
  let root: string;
  let sha: string;

  before(() => {
    root = makeRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
    commit(root, 'init');
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    git(root, ['branch', 'feature/deep/name']);
    git(root, ['tag', 'v1.0']);
    // Simulate a remote-tracking branch without a network remote.
    git(root, ['update-ref', 'refs/remotes/origin/main', sha]);
  });

  it('true for a local branch', async () => {
    assert.strictEqual(await svc.isBranch(root, 'main'), true);
  });

  it('true for a local branch with slashes in the name', async () => {
    assert.strictEqual(await svc.isBranch(root, 'feature/deep/name'), true);
  });

  it('true for a remote-tracking branch', async () => {
    assert.strictEqual(await svc.isBranch(root, 'origin/main'), true);
  });

  it('false for a tag, even though it resolves to a commit', async () => {
    assert.strictEqual(await svc.isBranch(root, 'v1.0'), false);
  });

  it('false for a SHA and for relative revisions', async () => {
    assert.strictEqual(await svc.isBranch(root, sha), false);
    assert.strictEqual(await svc.isBranch(root, 'main~0'), false);
  });

  it('false for nonexistent names, empty input, and leading-dash input', async () => {
    assert.strictEqual(await svc.isBranch(root, 'no-such-branch'), false);
    assert.strictEqual(await svc.isBranch(root, ''), false);
    assert.strictEqual(await svc.isBranch(root, '   '), false);
    assert.strictEqual(await svc.isBranch(root, '--all'), false);
  });
});

describe('parseNameStatusZ', () => {
  it('returns [] for empty input', () => {
    assert.deepStrictEqual(parseNameStatusZ(''), []);
  });

  it('parses a single modified entry', () => {
    assert.deepStrictEqual(parseNameStatusZ('M\0a.txt\0'), [
      { relPath: 'a.txt', status: 'M' },
    ]);
  });

  it('parses adds and deletes', () => {
    const input = 'A\0added.txt\0D\0gone.txt\0';
    assert.deepStrictEqual(parseNameStatusZ(input), [
      { relPath: 'added.txt', status: 'A' },
      { relPath: 'gone.txt', status: 'D' },
    ]);
  });

  it('parses a rename, keeping the new path with status R and the old path as origPath', () => {
    // R<score>NUL<old>NUL<new>NUL
    const input = 'R100\0old/path.ts\0new/path.ts\0';
    assert.deepStrictEqual(parseNameStatusZ(input), [
      { relPath: 'new/path.ts', status: 'R', origPath: 'old/path.ts' },
    ]);
  });

  it('parses a copy, keeping the new path with status C and the source as origPath', () => {
    const input = 'C075\0src.ts\0copy.ts\0';
    assert.deepStrictEqual(parseNameStatusZ(input), [
      { relPath: 'copy.ts', status: 'C', origPath: 'src.ts' },
    ]);
  });

  it('parses type-change (T) and unmerged (U) statuses', () => {
    const input = 'T\0link.txt\0U\0conflict.txt\0';
    assert.deepStrictEqual(parseNameStatusZ(input), [
      { relPath: 'link.txt', status: 'T' },
      { relPath: 'conflict.txt', status: 'U' },
    ]);
  });

  it('mixes regular entries with a rename', () => {
    const input = 'M\0a.txt\0R090\0from.ts\0to.ts\0D\0d.txt\0';
    assert.deepStrictEqual(parseNameStatusZ(input), [
      { relPath: 'a.txt', status: 'M' },
      { relPath: 'to.ts', status: 'R', origPath: 'from.ts' },
      { relPath: 'd.txt', status: 'D' },
    ]);
  });

  it('handles input without a trailing NUL', () => {
    assert.deepStrictEqual(parseNameStatusZ('M\0a.txt'), [
      { relPath: 'a.txt', status: 'M' },
    ]);
  });

  it('normalizes unknown status letters to M', () => {
    // Defensive fallback for any future status code git introduces.
    assert.deepStrictEqual(parseNameStatusZ('X\0weird.txt\0'), [
      { relPath: 'weird.txt', status: 'M' },
    ]);
  });

  it('preserves filenames containing spaces and unicode', () => {
    const input = 'M\0src/файл with space.ts\0';
    assert.deepStrictEqual(parseNameStatusZ(input), [
      { relPath: 'src/файл with space.ts', status: 'M' },
    ]);
  });
});
