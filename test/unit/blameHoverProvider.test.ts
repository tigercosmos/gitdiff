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
const { BlameHoverProvider, formatBlameDate, buildBlameLinks } = require('../../src/blameHoverProvider');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { encodeGitdiffUri } = require('../../src/util/uri');

interface BlameCall {
  repoRoot: string;
  relPath: string;
  line: number;
  ref?: string;
}

function fileUri(path: string): { scheme: string; fsPath: string; toString(): string } {
  return {
    scheme: 'file',
    fsPath: path,
    toString: () => `file:${path}`,
  };
}

function document(
  uri: unknown,
  text = '',
  version = 1,
): { uri: unknown; version: number; getText(): string } {
  return { uri, version, getText: () => text };
}

function token(cancelled = false): { isCancellationRequested: boolean } {
  return { isCancellationRequested: cancelled };
}

function markdownValue(hover: any): string {
  return hover.contents.value;
}

describe('BlameHoverProvider', () => {
  it('blames gitdiff documents at the pinned target ref', async () => {
    const calls: BlameCall[] = [];
    const git = {
      blameLine(repoRoot: string, relPath: string, line: number, ref?: string) {
        calls.push({ repoRoot, relPath, line, ref });
        return Promise.resolve({
          fullSha: '1234567890abcdef1234567890abcdef12345678',
          shortSha: '12345678',
          author: 'Jane Doe',
          summary: 'Add hover blame',
        });
      },
      blameLineForContents() {
        throw new Error('unexpected contents blame');
      },
    };
    const tracker = { getActiveGitdiffPair: () => undefined };
    const provider = new BlameHoverProvider(git, tracker);
    const uri = encodeGitdiffUri({
      ref: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      repoRoot: '/repo',
      relPath: 'src/a.ts',
    });

    const hover = await provider.provideHover(
      document(uri),
      { line: 2 },
      token(),
    );

    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], {
      repoRoot: '/repo',
      relPath: 'src/a.ts',
      line: 3,
      ref: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    assert.ok(markdownValue(hover).includes('Jane Doe'));
    assert.ok(markdownValue(hover).includes('Add hover blame'));
    assert.ok(markdownValue(hover).includes('12345678'));
  });

  it('renders the commit date and a clean SHA for committed lines', async () => {
    const git = {
      blameLine() {
        return Promise.resolve({
          fullSha: '1234567890abcdef1234567890abcdef12345678',
          shortSha: '12345678',
          author: 'Jane Doe',
          summary: 'Add hover blame',
          authorTime: 1780759591, // 2026-06-06 15:26 UTC -> 23:26 +08:00
          authorTz: '+0800',
        });
      },
      blameLineForContents() {
        throw new Error('unexpected contents blame');
      },
    };
    const tracker = { getActiveGitdiffPair: () => undefined };
    const provider = new BlameHoverProvider(git, tracker);
    const uri = encodeGitdiffUri({
      ref: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      repoRoot: '/repo',
      relPath: 'src/a.ts',
    });

    const hover = await provider.provideHover(document(uri), { line: 0 }, token());

    const value = markdownValue(hover);
    assert.ok(value.includes('**Date:**'), value);
    assert.ok(value.includes('2026-06-06 23:26 +0800'), value);
    assert.ok(value.includes('12345678'), value);
  });

  it('renders a clean "Not committed yet" label for working-tree lines', async () => {
    const git = {
      blameLine() {
        throw new Error('unexpected disk blame');
      },
      blameLineForContents() {
        // git's sentinel output for an uncommitted line.
        return Promise.resolve({
          fullSha: '0000000000000000000000000000000000000000',
          shortSha: '00000000',
          author: 'Not Committed Yet',
          summary: 'Version of a.ts from standard input',
          authorTime: 1780759591,
          authorTz: '+0800',
        });
      },
    };
    const right = fileUri('/repo/src/a.ts');
    const left = encodeGitdiffUri({
      ref: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      repoRoot: '/repo',
      relPath: 'src/a.ts',
    });
    const tracker = { getActiveGitdiffPair: () => ({ left, right }) };
    const provider = new BlameHoverProvider(git, tracker);

    const hover = await provider.provideHover(
      document(right, 'unsaved\n', 1),
      { line: 0 },
      token(),
    );

    const value = markdownValue(hover);
    assert.ok(value.includes('Not committed yet'), value);
    // git's placeholder noise must not leak into the hover.
    assert.ok(!value.includes('Not Committed Yet'), value);
    assert.ok(!value.includes('standard input'), value);
    assert.ok(!value.includes('Author:'), value);
  });

  it('blames only the active GitDiff modified file for file documents', async () => {
    const calls: BlameCall[] = [];
    const contentCalls: Array<BlameCall & { contents: string }> = [];
    const git = {
      blameLine() {
        throw new Error('unexpected disk blame');
      },
      blameLineForContents(
        repoRoot: string,
        relPath: string,
        line: number,
        contents: string,
        ref?: string,
      ) {
        contentCalls.push({ repoRoot, relPath, line, contents, ref });
        return Promise.resolve({
          fullSha: '2222222222222222222222222222222222222222',
          shortSha: '22222222',
          author: 'Test',
          summary: 'Committed line',
        });
      },
    };
    const right = fileUri('/repo/src/a.ts');
    const left = encodeGitdiffUri({
      ref: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      repoRoot: '/repo',
      relPath: 'src/a.ts',
    });
    const tracker = { getActiveGitdiffPair: () => ({ left, right }) };
    const provider = new BlameHoverProvider(git, tracker);

    const hover = await provider.provideHover(
      document(right, 'visible contents\n', 7),
      { line: 0 },
      token(),
    );
    const unrelated = await provider.provideHover(
      document(fileUri('/repo/src/b.ts')),
      { line: 0 },
      token(),
    );

    assert.strictEqual(unrelated, undefined);
    assert.strictEqual(contentCalls.length, 1);
    assert.deepStrictEqual(contentCalls[0], {
      repoRoot: '/repo',
      relPath: 'src/a.ts',
      line: 1,
      contents: 'visible contents\n',
      ref: undefined,
    });
    assert.ok(markdownValue(hover).includes('Committed line'));
  });

  it('returns no hover when cancellation is requested before rendering', async () => {
    const git = {
      blameLine() {
        return Promise.resolve({
          fullSha: '3333333333333333333333333333333333333333',
          shortSha: '33333333',
          author: 'Test',
          summary: 'Cancelled',
        });
      },
      blameLineForContents() {
        throw new Error('unexpected contents blame');
      },
    };
    const tracker = { getActiveGitdiffPair: () => undefined };
    const provider = new BlameHoverProvider(git, tracker);
    const uri = encodeGitdiffUri({
      ref: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      repoRoot: '/repo',
      relPath: 'src/a.ts',
    });

    const hover = await provider.provideHover(document(uri), { line: 0 }, token(true));

    assert.strictEqual(hover, undefined);
  });

  it('caches pinned gitdiff blame lookups by line', async () => {
    let calls = 0;
    const git = {
      blameLine() {
        calls++;
        return Promise.resolve({
          fullSha: '4444444444444444444444444444444444444444',
          shortSha: '44444444',
          author: 'Test',
          summary: 'Cached',
        });
      },
      blameLineForContents() {
        throw new Error('unexpected contents blame');
      },
    };
    const tracker = { getActiveGitdiffPair: () => undefined };
    const provider = new BlameHoverProvider(git, tracker);
    const uri = encodeGitdiffUri({
      ref: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      repoRoot: '/repo',
      relPath: 'src/a.ts',
    });

    await provider.provideHover(document(uri), { line: 0 }, token());
    await provider.provideHover(document(uri), { line: 0 }, token());
    await provider.provideHover(document(uri), { line: 1 }, token());

    assert.strictEqual(calls, 2);
  });

  it('caches modified document blame by version and line', async () => {
    let calls = 0;
    const git = {
      blameLine() {
        throw new Error('unexpected disk blame');
      },
      blameLineForContents() {
        calls++;
        return Promise.resolve({
          fullSha: '5555555555555555555555555555555555555555',
          shortSha: '55555555',
          author: 'Test',
          summary: 'Cached contents',
        });
      },
    };
    const right = fileUri('/repo/src/a.ts');
    const left = encodeGitdiffUri({
      ref: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      repoRoot: '/repo',
      relPath: 'src/a.ts',
    });
    const tracker = { getActiveGitdiffPair: () => ({ left, right }) };
    const provider = new BlameHoverProvider(git, tracker);

    await provider.provideHover(document(right, 'one\n', 1), { line: 0 }, token());
    await provider.provideHover(document(right, 'one\n', 1), { line: 0 }, token());
    await provider.provideHover(document(right, 'two\n', 2), { line: 0 }, token());
    await provider.provideHover(document(right, 'two\n', 2), { line: 1 }, token());

    assert.strictEqual(calls, 3);
  });

  it('bounds the cache so a long editing session does not leak entries', async () => {
    let calls = 0;
    const git = {
      blameLine() {
        throw new Error('unexpected disk blame');
      },
      blameLineForContents() {
        calls++;
        return Promise.resolve({
          fullSha: '6666666666666666666666666666666666666666',
          shortSha: '66666666',
          author: 'Test',
          summary: 'Bounded',
        });
      },
    };
    const right = fileUri('/repo/src/a.ts');
    const left = encodeGitdiffUri({
      ref: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      repoRoot: '/repo',
      relPath: 'src/a.ts',
    });
    const tracker = { getActiveGitdiffPair: () => ({ left, right }) };
    const provider = new BlameHoverProvider(git, tracker);

    // Each new version is a distinct cache key; far more than the cap.
    for (let v = 1; v <= 300; v++) {
      await provider.provideHover(document(right, `v${v}\n`, v), { line: 0 }, token());
    }
    assert.strictEqual(calls, 300);

    // The earliest version must have been evicted, so it re-blames.
    await provider.provideHover(document(right, 'v1\n', 1), { line: 0 }, token());
    assert.strictEqual(calls, 301);

    // The most-recent version is still cached, so it does not re-blame.
    await provider.provideHover(document(right, 'v300\n', 300), { line: 0 }, token());
    assert.strictEqual(calls, 301);
  });

  it('uses supplied modified contents even when the document is empty', async () => {
    let contentsSeen: string | undefined;
    const git = {
      blameLine() {
        throw new Error('unexpected disk blame');
      },
      blameLineForContents(
        _repoRoot: string,
        _relPath: string,
        _line: number,
        contents: string,
      ) {
        contentsSeen = contents;
        return Promise.resolve(undefined);
      },
    };
    const right = fileUri('/repo/src/a.ts');
    const left = encodeGitdiffUri({
      ref: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      repoRoot: '/repo',
      relPath: 'src/a.ts',
    });
    const tracker = { getActiveGitdiffPair: () => ({ left, right }) };
    const provider = new BlameHoverProvider(git, tracker);

    const hover = await provider.provideHover(document(right, '', 1), { line: 0 }, token());

    assert.strictEqual(hover, undefined);
    assert.strictEqual(contentsSeen, '');
  });
});

describe('buildBlameLinks', () => {
  const committed = {
    fullSha: '1234567890abcdef1234567890abcdef12345678',
    shortSha: '12345678',
    author: 'Jane Doe',
    summary: 'Fix the parser (#42)',
    authorTime: 1780759591,
    authorTz: '+0800',
  };

  it('encodes the open-commit-diff command with the repo/path/sha args', async () => {
    const links = await buildBlameLinks(committed, '/repo', 'src/a.ts', async () => undefined);
    assert.ok(links.openFileDiffCommand.startsWith('command:gitdiff.openCommitDiffForFile?'));
    const json = decodeURIComponent(links.openFileDiffCommand.split('?')[1]);
    // VS Code command URIs carry a JSON *array* of positional arguments.
    assert.deepStrictEqual(JSON.parse(json), [
      {
        repoRoot: '/repo',
        relPath: 'src/a.ts',
        sha: committed.fullSha,
      },
    ]);
    // No remote -> no web links.
    assert.strictEqual(links.commitUrl, undefined);
    assert.strictEqual(links.pr, undefined);
  });

  it('adds commit and PR web links when a remote is present', async () => {
    const remote = { host: 'github.com', base: 'https://github.com/o/r' };
    const links = await buildBlameLinks(committed, '/repo', 'src/a.ts', async () => remote);
    assert.strictEqual(links.commitUrl, `https://github.com/o/r/commit/${committed.fullSha}`);
    assert.deepStrictEqual(links.pr, {
      url: 'https://github.com/o/r/pull/42',
      label: '#42',
    });
  });

  it('uses the blamed filename (not the current path) for the open-diff command', async () => {
    const renamed = { ...committed, filename: 'old/path.txt' };
    const links = await buildBlameLinks(renamed, '/repo', 'new/path.txt', async () => undefined);
    const args = JSON.parse(decodeURIComponent(links.openFileDiffCommand.split('?')[1]));
    assert.strictEqual(args[0].relPath, 'old/path.txt', 'must open the path at the blamed commit');
    assert.strictEqual(args[0].sha, committed.fullSha);
  });

  it('falls back to the current path when blame reports no filename', async () => {
    const links = await buildBlameLinks(committed, '/repo', 'src/a.ts', async () => undefined);
    const args = JSON.parse(decodeURIComponent(links.openFileDiffCommand.split('?')[1]));
    assert.strictEqual(args[0].relPath, 'src/a.ts');
  });

  it('returns no links for an uncommitted line', async () => {
    const links = await buildBlameLinks(
      { ...committed, fullSha: '0'.repeat(40) },
      '/repo',
      'src/a.ts',
      async () => {
        throw new Error('remote must not be consulted for uncommitted lines');
      },
    );
    assert.deepStrictEqual(links, {});
  });
});

describe('formatBlameDate', () => {
  it('renders the wall-clock time in the commit timezone, independent of host zone', () => {
    // 1780759591 == 2026-06-06 15:26 UTC; in +08:00 the wall clock is 23:26.
    assert.strictEqual(formatBlameDate(1780759591, '+0800'), '2026-06-06 23:26 +0800');
  });

  it('applies a negative offset', () => {
    assert.strictEqual(formatBlameDate(1780759591, '-0500'), '2026-06-06 10:26 -0500');
  });

  it('omits the timezone suffix when the offset is malformed', () => {
    assert.strictEqual(formatBlameDate(1780759591, ''), '2026-06-06 15:26');
  });

  it('returns empty for missing or non-positive times', () => {
    assert.strictEqual(formatBlameDate(0, '+0800'), '');
    assert.strictEqual(formatBlameDate(NaN, '+0800'), '');
  });
});
