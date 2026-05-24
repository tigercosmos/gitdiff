import * as assert from 'assert';
import { compileSearch, escapeRegex } from '../../src/util/search';

function isCompiled(r: any): r is { regex: RegExp } {
  return r && r.regex instanceof RegExp;
}

describe('compileSearch', () => {
  it('returns undefined for an empty query', () => {
    assert.strictEqual(
      compileSearch({
        query: '',
        matchCase: false,
        matchWholeWord: false,
        useRegex: false,
      }),
      undefined,
    );
  });

  it('escapes a literal query when useRegex is off', () => {
    const r = compileSearch({
      query: 'a.b',
      matchCase: true,
      matchWholeWord: false,
      useRegex: false,
    });
    assert.ok(isCompiled(r));
    assert.strictEqual(r.regex.test('a.b'), true);
    assert.strictEqual(r.regex.test('axb'), false);
  });

  it('applies the i flag when matchCase is off', () => {
    const r = compileSearch({
      query: 'FOO',
      matchCase: false,
      matchWholeWord: false,
      useRegex: false,
    });
    assert.ok(isCompiled(r));
    assert.strictEqual(r.regex.test('FOO'), true);
    assert.strictEqual(r.regex.test('foo'), true);
  });

  it('respects matchCase when on', () => {
    const r = compileSearch({
      query: 'FOO',
      matchCase: true,
      matchWholeWord: false,
      useRegex: false,
    });
    assert.ok(isCompiled(r));
    assert.strictEqual(r.regex.test('FOO'), true);
    assert.strictEqual(r.regex.test('foo'), false);
  });

  it('wraps in word boundaries when matchWholeWord is on', () => {
    const r = compileSearch({
      query: 'cat',
      matchCase: true,
      matchWholeWord: true,
      useRegex: false,
    });
    assert.ok(isCompiled(r));
    assert.strictEqual(r.regex.test('the cat sat'), true);
    assert.strictEqual(r.regex.test('catalog'), false);
    assert.strictEqual(r.regex.test('scatter'), false);
  });

  it('parses a regex when useRegex is on', () => {
    const r = compileSearch({
      query: 'foo|bar',
      matchCase: true,
      matchWholeWord: false,
      useRegex: true,
    });
    assert.ok(isCompiled(r));
    assert.strictEqual(r.regex.test('foo'), true);
    assert.strictEqual(r.regex.test('bar'), true);
    assert.strictEqual(r.regex.test('baz'), false);
  });

  it('returns an error object when useRegex is on with an invalid regex', () => {
    const r = compileSearch({
      query: '[invalid',
      matchCase: true,
      matchWholeWord: false,
      useRegex: true,
    });
    assert.ok(r && 'error' in r);
    assert.match((r as { error: string }).error, /./);
  });

  it('uses the m flag so ^/$ match line by line', () => {
    const r = compileSearch({
      query: '^hello$',
      matchCase: true,
      matchWholeWord: false,
      useRegex: true,
    });
    assert.ok(isCompiled(r));
    assert.strictEqual(r.regex.test('first line\nhello\nthird'), true);
  });

  it('escapes regex meta characters', () => {
    assert.strictEqual(escapeRegex('a.b+c*'), 'a\\.b\\+c\\*');
    assert.strictEqual(escapeRegex('()[]{}|^$\\'), '\\(\\)\\[\\]\\{\\}\\|\\^\\$\\\\');
  });

  it('whole-word matches queries that start or end with non-word characters', () => {
    // `\b` only fires at a word/non-word transition, so `\b.env\b` would
    // never match standalone `.env`. We use lookarounds instead.
    const dotEnv = compileSearch({
      query: '.env',
      matchCase: true,
      matchWholeWord: true,
      useRegex: false,
    });
    assert.ok(isCompiled(dotEnv));
    assert.strictEqual(dotEnv.regex.test('open the .env file'), true);
    assert.strictEqual(dotEnv.regex.test('.env'), true);
    assert.strictEqual(dotEnv.regex.test('my.envfile'), false);
    assert.strictEqual(dotEnv.regex.test('x.envvar'), false);

    const cpp = compileSearch({
      query: 'C++',
      matchCase: true,
      matchWholeWord: true,
      useRegex: false,
    });
    assert.ok(isCompiled(cpp));
    assert.strictEqual(cpp.regex.test('use C++ here'), true);
    assert.strictEqual(cpp.regex.test('C++'), true);
    assert.strictEqual(cpp.regex.test('C++abc'), false);

    const fooDot = compileSearch({
      query: 'foo.',
      matchCase: true,
      matchWholeWord: true,
      useRegex: false,
    });
    assert.ok(isCompiled(fooDot));
    assert.strictEqual(fooDot.regex.test('the foo. word'), true);
    assert.strictEqual(fooDot.regex.test('foo.bar'), false);
  });

  it('whole-word + regex alternation respects boundaries on every branch', () => {
    // `\bfoo|bar\b` would let `foobar` slip in: \b only attaches to `foo`
    // on the left and `bar` on the right. The non-capturing wrap fixes that.
    const r = compileSearch({
      query: 'foo|bar',
      matchCase: true,
      matchWholeWord: true,
      useRegex: true,
    });
    assert.ok(isCompiled(r));
    assert.strictEqual(r.regex.test('foo bar'), true);
    assert.strictEqual(r.regex.test('plain foo here'), true);
    assert.strictEqual(r.regex.test('xfoox'), false);
    assert.strictEqual(r.regex.test('foobar'), false);
    assert.strictEqual(r.regex.test('xbarx'), false);
  });
});
