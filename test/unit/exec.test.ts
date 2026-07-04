import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { execGit, ExecError } from '../../src/util/exec';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdiff-exec-'));
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

describe('execGit', function () {
  this.timeout(20000);
  let root: string;

  before(() => {
    root = makeRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'first', '-q', '--allow-empty']);
  });

  it('resolves with stdout/stderr buffers and exit code 0 on success', async () => {
    const r = await execGit('git', ['--version'], root);
    assert.strictEqual(r.code, 0);
    assert.ok(Buffer.isBuffer(r.stdout));
    assert.ok(Buffer.isBuffer(r.stderr));
    assert.match(r.stdout.toString('utf8'), /^git version /);
  });

  it('rejects with ExecError on non-zero exit by default', async () => {
    await assert.rejects(
      execGit('git', ['rev-parse', '--verify', 'definitely-not-a-ref'], root),
      (err: unknown) => {
        assert.ok(err instanceof ExecError);
        assert.notStrictEqual(err.code, 0);
        assert.deepStrictEqual(err.args, ['rev-parse', '--verify', 'definitely-not-a-ref']);
        assert.strictEqual(err.name, 'ExecError');
        return true;
      },
    );
  });

  it('resolves with non-zero code when allowNonZero is true', async () => {
    const r = await execGit(
      'git',
      ['rev-parse', '--verify', 'still-not-a-ref'],
      root,
      { allowNonZero: true },
    );
    assert.notStrictEqual(r.code, 0);
    assert.ok(r.stderr.length > 0);
  });

  it('rejects with ExecError code -1 when the binary cannot be spawned', async () => {
    await assert.rejects(
      execGit('/no/such/git-binary-exists-here', ['--version'], root),
      (err: unknown) => {
        assert.ok(err instanceof ExecError);
        assert.strictEqual(err.code, -1);
        return true;
      },
    );
  });

  it('returns stdout as a Buffer (preserving raw bytes)', async () => {
    // git show emits the file contents verbatim — verify we get bytes, not a string.
    const r = await execGit('git', ['show', 'HEAD:a.txt'], root);
    assert.ok(Buffer.isBuffer(r.stdout));
    assert.strictEqual(r.stdout.toString('utf8'), 'hello\n');
  });

  it('passes args through verbatim (no shell interpretation)', async () => {
    // A literal '$(whoami)' arg would be expanded under a shell; execFile must not.
    // git treats it as a malformed pathspec / ref → non-zero exit, args preserved.
    await assert.rejects(
      execGit('git', ['rev-parse', '--verify', '$(whoami)'], root),
      (err: unknown) => {
        assert.ok(err instanceof ExecError);
        assert.deepStrictEqual(err.args, ['rev-parse', '--verify', '$(whoami)']);
        return true;
      },
    );
  });

  it('writes optional stdin input to the git process', async () => {
    const r = await execGit('git', ['hash-object', '--stdin'], root, {
      input: 'hello\n',
    });
    assert.strictEqual(
      r.stdout.toString('utf8').trim(),
      'ce013625030ba8dba906f756967f9e9ca394464a',
    );
  });

  it('spawns the child with GIT_OPTIONAL_LOCKS=0 while inheriting the parent env', async () => {
    // execGit runs whatever binary it's given — use node as a portable env
    // probe instead of relying on shell aliases (which differ on Windows).
    const r = await execGit(
      process.execPath,
      ['-e', 'console.log(JSON.stringify([process.env.GIT_OPTIONAL_LOCKS, !!process.env.PATH]))'],
      root,
    );
    const [locks, hasPath] = JSON.parse(r.stdout.toString('utf8'));
    assert.strictEqual(locks, '0');
    assert.strictEqual(hasPath, true);
  });
});

describe('ExecError', () => {
  it('exposes message, code, stderr, and args', () => {
    const e = new ExecError('boom', 128, 'fatal: nope\n', ['rev-parse', 'x']);
    assert.strictEqual(e.message, 'boom');
    assert.strictEqual(e.code, 128);
    assert.strictEqual(e.stderr, 'fatal: nope\n');
    assert.deepStrictEqual(e.args, ['rev-parse', 'x']);
    assert.strictEqual(e.name, 'ExecError');
    assert.ok(e instanceof Error);
  });
});
