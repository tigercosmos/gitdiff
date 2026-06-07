import * as assert from 'assert';

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') {
    return require.resolve('./_vscode-stub-full');
  }
  return originalResolve.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { formatInlineBlame, renderBlameMarkdown } = require('../../src/blameFormat');

const committed = {
  fullSha: '1234567890abcdef1234567890abcdef12345678',
  shortSha: '12345678',
  author: 'Jane Doe',
  summary: 'Add hover blame',
  authorTime: 1780759591, // 2026-06-06 in +08:00
  authorTz: '+0800',
};

const uncommitted = {
  fullSha: '0000000000000000000000000000000000000000',
  shortSha: '00000000',
  author: 'Not Committed Yet',
  summary: 'Version of a.ts from standard input',
  authorTime: 0,
  authorTz: '',
};

describe('formatInlineBlame', () => {
  it('renders author, date, and summary', () => {
    assert.strictEqual(formatInlineBlame(committed), 'Jane Doe, 2026-06-06 • Add hover blame');
  });

  it('drops the date when the timestamp is absent', () => {
    assert.strictEqual(
      formatInlineBlame({ ...committed, authorTime: 0, authorTz: '' }),
      'Jane Doe • Add hover blame',
    );
  });

  it('renders a clean label for uncommitted lines', () => {
    assert.strictEqual(formatInlineBlame(uncommitted), 'Not committed yet');
  });

  it('truncates a very long summary', () => {
    const long = formatInlineBlame({ ...committed, summary: 'x'.repeat(100) });
    // "Jane Doe, 2026-06-06 • " + 50-char truncated summary
    assert.ok(long.endsWith('…'), long);
    assert.ok(long.includes('x'.repeat(49)), long);
    assert.ok(!long.includes('x'.repeat(51)), long);
  });
});

describe('renderBlameMarkdown', () => {
  it('includes author, summary, sha and the supplied links', () => {
    const md = renderBlameMarkdown(committed, {
      openFileDiffCommand: 'command:gitdiff.openCommitDiffForFile?%7B%7D',
      commitUrl: 'https://github.com/o/r/commit/123',
      pr: { url: 'https://github.com/o/r/pull/9', label: '#9' },
    });
    assert.ok(md.value.includes('Jane Doe'), md.value);
    assert.ok(md.value.includes('Add hover blame'), md.value);
    assert.ok(md.value.includes('12345678'), md.value);
    assert.ok(md.value.includes('Open commit diff'), md.value);
    assert.ok(md.value.includes('https://github.com/o/r/commit/123'), md.value);
    assert.ok(md.value.includes('](https://github.com/o/r/pull/9)'), md.value);
    assert.ok(md.value.includes('#9'), md.value);
  });

  it('scopes isTrusted to the open-commit-diff command for committed lines', () => {
    const md = renderBlameMarkdown(committed, {});
    assert.deepStrictEqual(md.isTrusted, {
      enabledCommands: ['gitdiff.openCommitDiffForFile'],
    });
  });

  it('renders a clean "Not committed yet" label and stays untrusted', () => {
    const md = renderBlameMarkdown(uncommitted, {
      commitUrl: 'https://example.com/should-not-appear',
    });
    assert.ok(md.value.includes('Not committed yet'), md.value);
    assert.ok(!md.value.includes('should-not-appear'), md.value);
    assert.strictEqual(md.isTrusted, false);
  });
});
