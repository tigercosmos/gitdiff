import * as assert from 'assert';

// refPicker imports `vscode` at module load; alias it to the stub first.
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') {
    return require.resolve('./_vscode-stub-full');
  }
  return originalResolve.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildTargetChoiceItems } = require('../../src/refPicker');

describe('buildTargetChoiceItems', () => {
  it('offers only Branch…/Commit… when nothing is typed', () => {
    const items = buildTargetChoiceItems('');
    assert.deepStrictEqual(
      items.map((i: any) => i.choice),
      ['branch', 'commit'],
    );
    assert.ok(items.every((i: any) => i.typed === undefined));
  });

  it('synthesizes a direct-compare row at the top when text is typed', () => {
    const items = buildTargetChoiceItems('origin/main');
    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[0].typed, 'origin/main');
    assert.ok(items[0].alwaysShow, 'typed row must survive QuickPick filtering');
    assert.ok(items[0].label.includes('origin/main'));
    assert.deepStrictEqual(
      items.slice(1).map((i: any) => i.choice),
      ['branch', 'commit'],
    );
  });

  it('trims whitespace around the typed text', () => {
    const items = buildTargetChoiceItems('  v1.2.3  ');
    assert.strictEqual(items[0].typed, 'v1.2.3');
  });

  it('whitespace-only input gets no typed row', () => {
    const items = buildTargetChoiceItems('   ');
    assert.strictEqual(items.length, 2);
  });

  it('refuses to build a typed row for leading-dash input (option injection)', () => {
    for (const bad of ['-', '--all', '-D main', ' --force']) {
      const items = buildTargetChoiceItems(bad);
      assert.strictEqual(
        items.find((i: any) => i.typed !== undefined),
        undefined,
        `expected no typed row for ${JSON.stringify(bad)}`,
      );
    }
  });

  it('accepts revision expressions like HEAD~2 and sha prefixes verbatim', () => {
    for (const rev of ['HEAD~2', 'deadbeef', 'main@{yesterday}', 'release/1.x']) {
      const items = buildTargetChoiceItems(rev);
      assert.strictEqual(items[0].typed, rev);
    }
  });
});
