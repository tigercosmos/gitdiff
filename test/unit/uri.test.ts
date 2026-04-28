import * as assert from 'assert';
import {
  partsToPathAndQuery,
  pathAndQueryToParts,
  GitdiffParts,
} from '../../src/util/uri';

describe('gitdiff URI codec', () => {
  const cases: GitdiffParts[] = [
    { ref: 'main', repoRoot: '/Users/me/proj', relPath: 'src/index.ts' },
    { ref: 'feature/x', repoRoot: '/Users/me/proj', relPath: 'a/b.ts' },
    { ref: 'origin/main', repoRoot: '/Users/me/proj', relPath: 'a.ts' },
    { ref: 'a1b2c3d', repoRoot: '/Users/me/proj', relPath: 'src/x.ts' },
    { ref: 'feature?#&%x', repoRoot: '/Users/me/proj', relPath: 'src/x.ts' },
    { ref: 'main', repoRoot: '/Users/me/with space/proj', relPath: 'a.ts' },
    { ref: 'main', repoRoot: '/Users/me/proj', relPath: 'src/file with space.ts' },
    { ref: '日本語', repoRoot: '/Users/me/proj', relPath: 'src/файл.ts' },
  ];

  for (const c of cases) {
    it(`round-trips ${JSON.stringify(c)}`, () => {
      const { path, query } = partsToPathAndQuery(c);
      assert.deepStrictEqual(pathAndQueryToParts(path, query), c);
    });
  }

  it('throws on missing ref/repo', () => {
    assert.throws(() => pathAndQueryToParts('/a.ts', 'ref=main'));
    assert.throws(() => pathAndQueryToParts('/a.ts', 'repo=/x'));
    assert.throws(() => pathAndQueryToParts('/a.ts', ''));
  });

  it('round-trips a parts object with a branch field', () => {
    const parts: GitdiffParts = {
      ref: 'a1b2c3d4e5f6',
      repoRoot: '/Users/me/proj',
      relPath: 'src/x.ts',
      branch: 'feature/x',
    };
    const { path, query } = partsToPathAndQuery(parts);
    assert.deepStrictEqual(pathAndQueryToParts(path, query), parts);
  });

  it('preserves a branch with special characters', () => {
    const parts: GitdiffParts = {
      ref: 'deadbeef',
      repoRoot: '/r',
      relPath: 'a.ts',
      branch: 'release/v1.0?#&%',
    };
    const { path, query } = partsToPathAndQuery(parts);
    assert.deepStrictEqual(pathAndQueryToParts(path, query), parts);
  });

  it('omits the branch field entirely when not provided', () => {
    const { query } = partsToPathAndQuery({ ref: 'main', repoRoot: '/r', relPath: 'a.ts' });
    assert.ok(!query.includes('branch='), `expected no branch in ${query}`);
  });

  it('omits the branch field when set to an empty string', () => {
    // Empty string is falsy in `if (parts.branch)`, so the encoder skips it.
    const { query } = partsToPathAndQuery({
      ref: 'main',
      repoRoot: '/r',
      relPath: 'a.ts',
      branch: '',
    });
    assert.ok(!query.includes('branch='), `expected no branch in ${query}`);
  });

  it('decodes a path that lacks a leading slash', () => {
    const parts = pathAndQueryToParts('a/b.ts', 'ref=main&repo=/r');
    assert.strictEqual(parts.relPath, 'a/b.ts');
  });

  it('encodes a relPath that already has a leading slash without doubling it', () => {
    const { path } = partsToPathAndQuery({ ref: 'main', repoRoot: '/r', relPath: '/a.ts' });
    assert.strictEqual(path, '/a.ts');
  });

  it('round-trips a deeply nested relPath', () => {
    const parts: GitdiffParts = {
      ref: 'main',
      repoRoot: '/r',
      relPath: 'a/b/c/d/e/f/g.ts',
    };
    const { path, query } = partsToPathAndQuery(parts);
    assert.deepStrictEqual(pathAndQueryToParts(path, query), parts);
  });

  it('preserves a + sign in the ref (URLSearchParams pitfall)', () => {
    const parts: GitdiffParts = {
      ref: 'v1.0+build.5',
      repoRoot: '/r',
      relPath: 'a.ts',
    };
    const { path, query } = partsToPathAndQuery(parts);
    assert.deepStrictEqual(pathAndQueryToParts(path, query), parts);
  });
});
