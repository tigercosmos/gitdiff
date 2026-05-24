import * as assert from 'assert';
import { compilePatterns } from '../../src/util/glob';

describe('compilePatterns', () => {
  it('returns undefined for empty / whitespace input', () => {
    assert.strictEqual(compilePatterns(undefined), undefined);
    assert.strictEqual(compilePatterns(''), undefined);
    assert.strictEqual(compilePatterns('   '), undefined);
    assert.strictEqual(compilePatterns(',,'), undefined);
  });

  it('matches a bare segment anywhere in the tree', () => {
    const m = compilePatterns('node_modules')!;
    assert.ok(m);
    assert.strictEqual(m.test('node_modules'), true);
    assert.strictEqual(m.test('foo/node_modules'), true);
    assert.strictEqual(m.test('node_modules/sub/x'), true);
    assert.strictEqual(m.test('a/node_modules/b.ts'), true);
    assert.strictEqual(m.test('vendor/lib.ts'), false);
  });

  it('matches a bare filename anywhere in the tree', () => {
    const m = compilePatterns('README.md')!;
    // README.md has a '.' but no '/' and no '*' so it qualifies as bare.
    assert.strictEqual(m.test('README.md'), true);
    assert.strictEqual(m.test('docs/README.md'), true);
    assert.strictEqual(m.test('README.txt'), false);
  });

  it('expands trailing slash into a recursive folder match', () => {
    const m = compilePatterns('src/')!;
    assert.strictEqual(m.test('src/a.ts'), true);
    assert.strictEqual(m.test('src/deep/nested/file.ts'), true);
    assert.strictEqual(m.test('other/src/a.ts'), false);
    assert.strictEqual(m.test('src'), false);
  });

  it('uses patterns with / or * verbatim', () => {
    const m = compilePatterns('**/*.ts')!;
    assert.strictEqual(m.test('a.ts'), true);
    assert.strictEqual(m.test('src/a.ts'), true);
    assert.strictEqual(m.test('deep/nested/x.ts'), true);
    assert.strictEqual(m.test('a.js'), false);
  });

  it('treats a slashless wildcard like a basename match across folders (VSCode semantics)', () => {
    // `*.ts` should match `src/foo.ts` the way VSCode Search does — without
    // matchBase the user gets surprising "no results" for the most common
    // include input. Same for `*.test.ts`.
    const m = compilePatterns('*.ts')!;
    assert.strictEqual(m.test('a.ts'), true);
    assert.strictEqual(m.test('src/foo.ts'), true);
    assert.strictEqual(m.test('deep/sub/x.ts'), true);
    assert.strictEqual(m.test('a.js'), false);
    const t = compilePatterns('*.test.ts')!;
    assert.strictEqual(t.test('a.test.ts'), true);
    assert.strictEqual(t.test('src/foo.test.ts'), true);
    assert.strictEqual(t.test('src/foo.ts'), false);
  });

  it('treats comma-separated patterns as a union', () => {
    const m = compilePatterns('*.ts, *.tsx,**/*.md')!;
    assert.strictEqual(m.test('a.ts'), true);
    assert.strictEqual(m.test('Component.tsx'), true);
    assert.strictEqual(m.test('docs/note.md'), true);
    assert.strictEqual(m.test('image.png'), false);
  });

  it('keeps commas inside brace alternation intact', () => {
    // `*.{ts,tsx}` is a single brace-alt pattern. A naïve `split(',')` would
    // wreck this; we must only split at the top level.
    const m = compilePatterns('*.{ts,tsx}')!;
    assert.strictEqual(m.test('a.ts'), true);
    assert.strictEqual(m.test('Component.tsx'), true);
    assert.strictEqual(m.test('src/deep/x.ts'), true);
    assert.strictEqual(m.test('a.js'), false);
  });

  it('handles nested braces and escaped commas', () => {
    const m = compilePatterns('src/{a,b}.{ts,tsx}, docs/x.md')!;
    assert.strictEqual(m.test('src/a.ts'), true);
    assert.strictEqual(m.test('src/b.tsx'), true);
    assert.strictEqual(m.test('docs/x.md'), true);
    assert.strictEqual(m.test('src/c.ts'), false);
  });

  it('matches dotfiles when dot:true is on', () => {
    const m = compilePatterns('.env')!;
    assert.strictEqual(m.test('.env'), true);
    assert.strictEqual(m.test('config/.env'), true);
  });

  it('skips an unparseable pattern but still applies others', () => {
    // Pattern starting with `[` and never closing is invalid minimatch.
    const m = compilePatterns('[invalid, *.ts');
    assert.ok(m);
    assert.strictEqual(m!.test('a.ts'), true);
  });
});
