import * as assert from 'assert';

// `changedFilesProvider.ts` imports `vscode` at module load time. Stub it
// before requiring the module — same pattern as the other unit tests.
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') {
    return require.resolve('./_vscode-stub-full');
  }
  return originalResolve.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stub = require('./_vscode-stub-full');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ChangedFilesProvider } = require('../../src/changedFilesProvider');

type Msg = Record<string, unknown>;

/** Enough of GitService for a target to be set and a list to be produced. */
const fakeGit = {
  gitDir: async (repoRoot: string) => `${repoRoot}/.git`,
  listChangedPaths: async () => [{ relPath: 'src/a.ts', status: 'M' as const }],
  listUntrackedPaths: async () => [],
  listWorktrees: async () => [],
};

function setup(): { provider: any; posted: Msg[] } {
  const posted: Msg[] = [];
  const memento = {
    store: new Map<string, unknown>(),
    get(key: string) {
      return this.store.get(key);
    },
    async update(key: string, value: unknown) {
      this.store.set(key, value);
    },
  };
  const provider = new ChangedFilesProvider(fakeGit, memento, stub.Uri.file('/ext'));
  provider.resolveWebviewView({
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://test',
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: (m: Msg) => {
        posted.push(m);
        return Promise.resolve(true);
      },
    },
    visible: true,
    onDidDispose: () => ({ dispose() {} }),
    onDidChangeVisibility: () => ({ dispose() {} }),
  });
  return { provider, posted };
}

function lastFilesMessage(posted: Msg[]): Msg {
  const files = posted.filter((m) => m.type === 'files');
  assert.ok(files.length > 0, 'expected a files message');
  return files[files.length - 1];
}

const TARGET = { ref: 'a'.repeat(40), display: 'upstream/master', branch: 'upstream/master' };

describe('ChangedFilesProvider target messages', () => {
  it('names the target repo so a cross-repo pin is visible in the view', async () => {
    const { provider, posted } = setup();
    await provider.setTarget(TARGET, '/repo/.claude/worktrees/agent-mvp-step3');
    const msg = lastFilesMessage(posted);
    assert.strictEqual(msg.repoLabel, 'agent-mvp-step3');
    assert.strictEqual(msg.repoPath, '/repo/.claude/worktrees/agent-mvp-step3');
    assert.strictEqual(msg.targetLabel, 'upstream/master');
    provider.dispose();
  });

  // path.basename('/') is '' — the label must never come through blank.
  it('falls back to the root itself when the repo root has no basename', async () => {
    const { provider, posted } = setup();
    await provider.setTarget(TARGET, '/');
    assert.strictEqual(lastFilesMessage(posted).repoLabel, '/');
    provider.dispose();
  });

  it('drops the repo once the target is cleared', async () => {
    const { provider, posted } = setup();
    await provider.setTarget(TARGET, '/repo');
    await provider.clearTarget();
    const msg = lastFilesMessage(posted);
    assert.strictEqual(msg.hasTarget, false);
    assert.strictEqual(msg.repoLabel, undefined);
    provider.dispose();
  });

  it('re-labels when the target moves to another repo', async () => {
    const { provider, posted } = setup();
    await provider.setTarget(TARGET, '/repo');
    await provider.setTarget(TARGET, '/repo/.claude/worktrees/wt');
    const msg = lastFilesMessage(posted);
    assert.strictEqual(msg.repoLabel, 'wt');
    assert.strictEqual(msg.repoPath, '/repo/.claude/worktrees/wt');
    provider.dispose();
  });
});

describe('ChangedFilesProvider view mode', () => {
  function setupWith(seed: Record<string, unknown>): { provider: any; posted: Msg[]; store: Map<string, unknown> } {
    const posted: Msg[] = [];
    const store = new Map<string, unknown>(Object.entries(seed));
    const memento = {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    };
    const provider = new ChangedFilesProvider(fakeGit, memento, stub.Uri.file('/ext'));
    provider.resolveWebviewView({
      webview: {
        options: {},
        html: '',
        cspSource: 'vscode-webview://test',
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: (m: Msg) => {
          posted.push(m);
          return Promise.resolve(true);
        },
      },
      visible: true,
      onDidDispose: () => ({ dispose() {} }),
      onDidChangeVisibility: () => ({ dispose() {} }),
    });
    return { provider, posted, store };
  }

  it('defaults to the tree layout', () => {
    const { provider } = setupWith({});
    assert.strictEqual(provider.getViewMode(), 'tree');
    provider.dispose();
  });

  it('restores a persisted layout and ignores garbage in workspaceState', () => {
    const list = setupWith({ 'gitdiff.changedFiles.viewMode': 'list' });
    assert.strictEqual(list.provider.getViewMode(), 'list');
    list.provider.dispose();
    const junk = setupWith({ 'gitdiff.changedFiles.viewMode': { nope: 1 } });
    assert.strictEqual(junk.provider.getViewMode(), 'tree');
    junk.provider.dispose();
  });

  it('persists a toggle, tells the webview, and fires the change event', async () => {
    const { provider, posted, store } = setupWith({});
    const fired: string[] = [];
    provider.onDidChangeViewMode((m: string) => fired.push(m));
    await provider.setViewMode('list');
    assert.strictEqual(provider.getViewMode(), 'list');
    assert.strictEqual(store.get('gitdiff.changedFiles.viewMode'), 'list');
    assert.deepStrictEqual(fired, ['list']);
    assert.deepStrictEqual(posted.filter((m) => m.type === 'viewMode'), [
      { type: 'viewMode', viewMode: 'list' },
    ]);
    // Setting the same mode again is a no-op: no message, no event.
    await provider.setViewMode('list');
    assert.deepStrictEqual(fired, ['list']);
    assert.strictEqual(posted.filter((m) => m.type === 'viewMode').length, 1);
    provider.dispose();
  });
});
