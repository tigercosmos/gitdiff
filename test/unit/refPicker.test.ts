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
const { buildTargetChoiceItems, choiceRowKey } = require('../../src/refPicker');

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

  describe('recent-commit rows', () => {
    const commits = [
      {
        fullSha: 'a'.repeat(40),
        shortSha: 'aaaaaaa',
        subject: 'newest change',
        isoDate: new Date().toISOString(),
        author: 'Ada',
      },
      {
        fullSha: 'b'.repeat(40),
        shortSha: 'bbbbbbb',
        subject: 'middle change',
        isoDate: new Date().toISOString(),
        author: 'Bob',
      },
      {
        fullSha: 'c'.repeat(40),
        shortSha: 'ccccccc',
        subject: 'oldest change',
        isoDate: new Date().toISOString(),
        author: 'Cy',
      },
    ];

    it('appends a separator plus one row per commit after Branch…/Commit…', () => {
      const items = buildTargetChoiceItems('', commits);
      assert.strictEqual(items.length, 6);
      assert.deepStrictEqual(
        items.slice(0, 2).map((i: any) => i.choice),
        ['branch', 'commit'],
      );
      assert.strictEqual(items[2].kind, -1, 'separator row');
      assert.strictEqual(items[2].label, 'Recent commits');
      assert.deepStrictEqual(
        items.slice(3).map((i: any) => i.ref),
        commits.map((c) => c.fullSha),
      );
      assert.deepStrictEqual(
        items.slice(3).map((i: any) => i.shortSha),
        commits.map((c) => c.shortSha),
      );
    });

    it('keeps commit order and shows sha, subject, author and full sha', () => {
      const items = buildTargetChoiceItems('', commits);
      const first = items[3];
      assert.ok(first.label.includes('aaaaaaa'));
      assert.ok(first.label.includes('newest change'));
      assert.ok(first.detail.includes('Ada'));
      assert.ok(first.detail.includes('a'.repeat(40)), 'full sha in detail for filtering');
      assert.strictEqual(first.choice, undefined);
      assert.strictEqual(first.typed, undefined);
    });

    it('places recent rows after the typed row and the fixed rows', () => {
      const items = buildTargetChoiceItems('v2.0', commits);
      assert.strictEqual(items[0].typed, 'v2.0');
      assert.deepStrictEqual(
        items.slice(1, 3).map((i: any) => i.choice),
        ['branch', 'commit'],
      );
      assert.strictEqual(items[3].kind, -1);
      assert.strictEqual(items[4].ref, 'a'.repeat(40));
    });

    it('omits the separator when there are no commits', () => {
      assert.strictEqual(buildTargetChoiceItems('', []).length, 2);
      assert.strictEqual(buildTargetChoiceItems('').length, 2);
    });
  });

  describe('default-target row', () => {
    const found = {
      kind: 'found',
      picked: { ref: 'f'.repeat(40), display: 'origin/main', branch: 'origin/main' },
    };

    it('is the first row when nothing is typed, so Enter picks it', () => {
      const items = buildTargetChoiceItems('', [], found);
      assert.strictEqual(items[0].label, '$(star-full) origin/main');
      assert.strictEqual(items[0].description, 'default target');
      assert.deepStrictEqual(items[0].defaultTarget, found.picked);
      assert.deepStrictEqual(
        items.slice(1).map((i: any) => i.choice),
        ['branch', 'commit'],
      );
    });

    it('comes right after the typed row', () => {
      const items = buildTargetChoiceItems('origin/ma', [], found);
      assert.strictEqual(items[0].typed, 'origin/ma');
      assert.deepStrictEqual(items[1].defaultTarget, found.picked);
    });

    // Not alwaysShow: typing something unrelated filters it out like any row.
    it('is filtered by what you type', () => {
      const items = buildTargetChoiceItems('', [], found);
      assert.ok(!items[0].alwaysShow);
    });

    it('says when the name in the setting does not resolve, and offers Settings', () => {
      const items = buildTargetChoiceItems('', [], { kind: 'missing', name: 'orgin/main' });
      assert.strictEqual(items[0].label, "$(warning) Default target 'orgin/main' not found");
      assert.strictEqual(items[0].openSettings, true);
      assert.strictEqual(items[0].defaultTarget, undefined);
    });

    it('is absent when there is no default', () => {
      const items = buildTargetChoiceItems('', []);
      assert.ok(items.every((i: any) => !i.defaultTarget && !i.openSettings));
    });
  });
});

// The chooser re-renders as rows load; this key keeps the highlight on the
// same row across those re-renders, which build new item objects.
describe('choiceRowKey', () => {
  const found = {
    kind: 'found',
    picked: { ref: 'f'.repeat(40), display: 'origin/main', branch: 'origin/main' },
  };
  const commits = [
    { fullSha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 's', isoDate: new Date().toISOString(), author: 'A' },
  ];

  it('matches the same row before and after late rows load', () => {
    const before = buildTargetChoiceItems('', []);
    const after = buildTargetChoiceItems('', commits, found);
    const commitRow = before.find((i: any) => i.choice === 'commit');
    const same = after.find((i: any) => choiceRowKey(i) === choiceRowKey(commitRow));
    assert.strictEqual(same.choice, 'commit');
  });

  it('gives every selectable row a distinct key, and separators none', () => {
    const items = buildTargetChoiceItems('v1', commits, found);
    const keys = items.map((i: any) => choiceRowKey(i));
    assert.deepStrictEqual(keys, ['typed:v1', 'default', 'choice:branch', 'choice:commit', undefined, `ref:${'a'.repeat(40)}`]);
  });
});
