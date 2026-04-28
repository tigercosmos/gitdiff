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
});
