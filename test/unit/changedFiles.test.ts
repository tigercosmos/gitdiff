import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// `changedFilesProvider.ts` imports `vscode` at module load time (for
// EventEmitter, Uri, etc.). Stub it before requiring the module — same
// pattern as the other unit tests.
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') {
    return require.resolve('./_vscode-stub-full');
  }
  return originalResolve.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { filterFiles, computeWorktreeExclusion } = require('../../src/changedFilesProvider');

type ChangedFile = {
  relPath: string;
  absPath: string;
  status: 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';
};

const blankFilter = {
  search: '',
  include: '',
  exclude: '',
  matchCase: false,
  matchWholeWord: false,
  useRegex: false,
};

function file(relPath: string, status: ChangedFile['status'] = 'M'): ChangedFile {
  return { relPath, absPath: '/absent/' + relPath, status };
}

describe('filterFiles (path-only)', () => {
  it('returns everything when no filter is set', async () => {
    const out = await filterFiles(
      [file('a.ts'), file('b.ts'), file('docs/c.md')],
      blankFilter,
    );
    assert.strictEqual(out.files.length, 3);
  });

  it('applies include glob to the path', async () => {
    const out = await filterFiles(
      [file('a.ts'), file('docs/c.md'), file('b.tsx')],
      { ...blankFilter, include: '**/*.ts,**/*.tsx' },
    );
    const paths = out.files.map((f: ChangedFile) => f.relPath).sort();
    assert.deepStrictEqual(paths, ['a.ts', 'b.tsx']);
  });

  it('applies exclude glob to the path', async () => {
    const out = await filterFiles(
      [file('src/a.ts'), file('node_modules/lib.js'), file('vendor/b.ts')],
      { ...blankFilter, exclude: 'node_modules' },
    );
    const paths = out.files.map((f: ChangedFile) => f.relPath).sort();
    assert.deepStrictEqual(paths, ['src/a.ts', 'vendor/b.ts']);
  });

  it('include and exclude can combine', async () => {
    const out = await filterFiles(
      [file('src/a.ts'), file('src/a.test.ts'), file('lib/b.ts')],
      { ...blankFilter, include: 'src/', exclude: '**/*.test.ts' },
    );
    const paths = out.files.map((f: ChangedFile) => f.relPath).sort();
    assert.deepStrictEqual(paths, ['src/a.ts']);
  });
});

describe('filterFiles (content search)', () => {
  let tmp: string;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdiff-cf-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function realFile(name: string, content: string): ChangedFile {
    const p = path.join(tmp, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return { relPath: name, absPath: p, status: 'M' };
  }

  it('filters files by content with literal text', async () => {
    const a = realFile('a.ts', 'export const hello = 1;\n');
    const b = realFile('b.ts', 'export const world = 2;\n');
    const out = await filterFiles([a, b], { ...blankFilter, search: 'hello' });
    assert.deepStrictEqual(out.files.map((f: ChangedFile) => f.relPath), ['a.ts']);
  });

  it('honors matchCase', async () => {
    const a = realFile('case.ts', 'HELLO world\n');
    const insensitive = await filterFiles([a], { ...blankFilter, search: 'hello' });
    assert.strictEqual(insensitive.files.length, 1);
    const sensitive = await filterFiles([a], {
      ...blankFilter,
      search: 'hello',
      matchCase: true,
    });
    assert.strictEqual(sensitive.files.length, 0);
  });

  it('honors matchWholeWord', async () => {
    const a = realFile('w.ts', 'catalog of cats\n');
    const partial = await filterFiles([a], { ...blankFilter, search: 'cat' });
    assert.strictEqual(partial.files.length, 1);
    const whole = await filterFiles([a], {
      ...blankFilter,
      search: 'cat',
      matchWholeWord: true,
    });
    assert.strictEqual(whole.files.length, 0);
  });

  it('honors useRegex', async () => {
    const a = realFile('r.ts', 'foo 123 bar\n');
    const out = await filterFiles([a], {
      ...blankFilter,
      search: '\\d+',
      useRegex: true,
    });
    assert.strictEqual(out.files.length, 1);
  });

  it('reports an invalid regex via the error field but still returns path matches', async () => {
    const a = realFile('e.ts', 'x\n');
    const out = await filterFiles([a], {
      ...blankFilter,
      search: '[unterminated',
      useRegex: true,
    });
    assert.ok(out.error);
    // path filters still applied; content filter skipped on error.
    assert.strictEqual(out.files.length, 1);
  });

  it('skips deleted files entirely (no working-tree content to scan)', async () => {
    const out = await filterFiles(
      [{ relPath: 'gone.ts', absPath: path.join(tmp, 'gone.ts'), status: 'D' }],
      { ...blankFilter, search: 'anything' },
    );
    assert.strictEqual(out.files.length, 0);
  });

  it('honors the isCancelled option to stop a content scan early', async () => {
    // Generate many candidate files so the content scan loop has actual work
    // to be cancelled from underneath.
    const files: ChangedFile[] = [];
    for (let i = 0; i < 200; i++) {
      const rel = `bulk/f${i}.txt`;
      const abs = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'needle present\n');
      files.push({ relPath: rel, absPath: abs, status: 'M' });
    }
    let cancelAfter = 0;
    const isCancelled = () => ++cancelAfter > 4; // cancel almost immediately

    const out = await filterFiles(
      files,
      { ...blankFilter, search: 'needle' },
      { isCancelled },
    );
    // Cancellation can produce a partial set; the key assertion is that we
    // did NOT scan all 200 files (i.e. we returned early). The set must be
    // a strict subset of the full pathOk set.
    assert.ok(out.files.length < files.length, 'cancellation should short-circuit');
  });

  it('combines include + exclude + case-sensitive whole-word content search in one pass', async () => {
    const candidates = [
      realFile('pipe/src/match.ts', 'const Needle = 1;\n'), // ✓ all filters
      realFile('pipe/src/case.ts', 'const needle = 1;\n'), // ✗ case
      realFile('pipe/src/word.ts', 'const Needles = 1;\n'), // ✗ whole word
      realFile('pipe/src/skip.md', 'Needle\n'), // ✗ include glob
      realFile('pipe/src/gen/out.ts', 'Needle\n'), // ✗ exclude glob
    ];
    const out = await filterFiles(candidates, {
      search: 'Needle',
      include: '**/*.ts',
      exclude: '**/gen/**',
      matchCase: true,
      matchWholeWord: true,
      useRegex: false,
    });
    assert.deepStrictEqual(
      out.files.map((f: ChangedFile) => f.relPath),
      ['pipe/src/match.ts'],
    );
  });

  it('regex search composes with path filters and matches across lines with ^/$', async () => {
    const candidates = [
      realFile('re/a.ts', 'import x from "y";\nexport default x;\n'),
      realFile('re/b.ts', 'const s = "export default x";\n'), // ✗ mid-line, ^ anchor misses
      realFile('re/c.md', 'export default x\n'), // excluded by include glob
    ];
    const out = await filterFiles(candidates, {
      ...blankFilter,
      include: '**/*.ts',
      search: '^export default',
      useRegex: true,
    });
    assert.deepStrictEqual(
      out.files.map((f: ChangedFile) => f.relPath),
      ['re/a.ts'],
    );
  });

  it('skips files above the size cap instead of reading them', async () => {
    // 5 MB cap + 1 byte: must be skipped even though the needle is inside.
    const big = realFile('big/huge.txt', 'needle' + 'x'.repeat(5 * 1024 * 1024));
    const small = realFile('big/small.txt', 'needle\n');
    const out = await filterFiles([big, small], { ...blankFilter, search: 'needle' });
    assert.deepStrictEqual(
      out.files.map((f: ChangedFile) => f.relPath),
      ['big/small.txt'],
    );
  });

  it('unreadable candidates are dropped without failing the scan', async () => {
    const ok = realFile('err/ok.txt', 'needle\n');
    const missing: ChangedFile = {
      relPath: 'err/vanished.txt',
      absPath: path.join(tmp, 'err/vanished.txt'), // never created
      status: 'M',
    };
    const dir: ChangedFile = {
      relPath: 'err/adir',
      absPath: path.join(tmp, 'err/adir'),
      status: 'M',
    };
    fs.mkdirSync(dir.absPath, { recursive: true });
    const out = await filterFiles([missing, dir, ok], { ...blankFilter, search: 'needle' });
    assert.deepStrictEqual(
      out.files.map((f: ChangedFile) => f.relPath),
      ['err/ok.txt'],
    );
  });

  it('non-ASCII content and paths survive the pipeline', async () => {
    const target = realFile('uni/café/檔案.ts', 'const 変数 = "ütf-8";\n');
    const other = realFile('uni/plain.ts', 'nothing here\n');
    const out = await filterFiles([target, other], {
      ...blankFilter,
      include: 'uni/',
      search: '変数',
    });
    assert.deepStrictEqual(
      out.files.map((f: ChangedFile) => f.relPath),
      ['uni/café/檔案.ts'],
    );
  });
});

describe('computeWorktreeExclusion', () => {
  let tmp: string;

  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitdiff-wt-')));
    fs.mkdirSync(path.join(tmp, 'wt-feature'), { recursive: true });
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns prefixes only for nested sibling worktrees', () => {
    const otherOutside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gitdiff-out-')),
    );
    try {
      const prefixes: string[] = computeWorktreeExclusion(tmp, [
        tmp,
        path.join(tmp, 'wt-feature'),
        otherOutside,
      ]);
      assert.strictEqual(prefixes.length, 1);
      assert.ok(prefixes[0].endsWith(path.sep));
      assert.ok(prefixes[0].includes('wt-feature'));
    } finally {
      fs.rmSync(otherOutside, { recursive: true, force: true });
    }
  });

  it('excludes the main repo itself', () => {
    const prefixes: string[] = computeWorktreeExclusion(tmp, [tmp]);
    assert.deepStrictEqual(prefixes, []);
  });

  it('treats a worktree outside the repo as not-nested', () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitdiff-other-')));
    try {
      const prefixes: string[] = computeWorktreeExclusion(tmp, [tmp, other]);
      assert.deepStrictEqual(prefixes, []);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
