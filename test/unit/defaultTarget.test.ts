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
import {
  AUTO_DEFAULT_TARGETS,
  defaultTargetCandidates,
  resolveDefaultTarget,
} from '../../src/defaultTarget';

type Msg = Record<string, unknown>;

/** A repo whose refs are `refs` (name → SHA); every name in `branches` is a branch. */
function fakeGit(
  refs: Record<string, string>,
  branches: string[] = Object.keys(refs),
  originHead?: string,
) {
  return {
    remoteHead: async () => originHead,
    gitDir: async (repoRoot: string) => `${repoRoot}/.git`,
    listChangedPaths: async () => [{ relPath: 'src/a.ts', status: 'M' as const }],
    listUntrackedPaths: async () => [],
    listWorktrees: async () => [],
    verifyRef: async (_root: string, name: string) => {
      const sha = refs[name];
      if (!sha) throw new Error(`'${name}' is not a valid revision`);
      return sha;
    },
    isBranch: async (_root: string, name: string) => branches.includes(name),
  };
}

const MAIN = 'a'.repeat(40);
const MASTER = 'b'.repeat(40);
const DEVELOP = 'c'.repeat(40);

describe('defaultTargetCandidates', () => {
  it('tries origin/main, then origin/master, when the setting is empty', () => {
    assert.deepStrictEqual(AUTO_DEFAULT_TARGETS, ['origin/main', 'origin/master']);
    assert.deepStrictEqual(defaultTargetCandidates(''), ['origin/main', 'origin/master']);
    assert.deepStrictEqual(defaultTargetCandidates('   '), ['origin/main', 'origin/master']);
    assert.deepStrictEqual(defaultTargetCandidates(undefined), ['origin/main', 'origin/master']);
    assert.deepStrictEqual(defaultTargetCandidates(42), ['origin/main', 'origin/master']);
  });

  it('uses only the typed name when the setting is set', () => {
    assert.deepStrictEqual(defaultTargetCandidates(' upstream/develop '), ['upstream/develop']);
    assert.deepStrictEqual(
      defaultTargetCandidates('upstream/develop', 'origin/trunk'),
      ['upstream/develop'],
    );
  });

  it('tries the branch origin/HEAD points at first, without duplicates', () => {
    assert.deepStrictEqual(defaultTargetCandidates('', 'origin/master'), [
      'origin/master',
      'origin/main',
    ]);
    assert.deepStrictEqual(defaultTargetCandidates('', 'origin/trunk'), [
      'origin/trunk',
      'origin/main',
      'origin/master',
    ]);
  });
});

describe('resolveDefaultTarget', () => {
  it('prefers origin/main over origin/master', async () => {
    const git = fakeGit({ 'origin/main': MAIN, 'origin/master': MASTER });
    const picked = await resolveDefaultTarget(git, '/repo', AUTO_DEFAULT_TARGETS);
    assert.deepStrictEqual(picked, { ref: MAIN, display: 'origin/main', branch: 'origin/main' });
  });

  it('falls back to origin/master', async () => {
    const git = fakeGit({ 'origin/master': MASTER });
    const picked = await resolveDefaultTarget(git, '/repo', AUTO_DEFAULT_TARGETS);
    assert.strictEqual(picked?.display, 'origin/master');
    assert.strictEqual(picked?.ref, MASTER);
  });

  it('returns undefined when nothing resolves', async () => {
    const git = fakeGit({});
    assert.strictEqual(await resolveDefaultTarget(git, '/repo', AUTO_DEFAULT_TARGETS), undefined);
  });

  it('pins a non-branch ref (tag, SHA) without branch semantics', async () => {
    const git = fakeGit({ 'v1.0': DEVELOP }, []);
    const picked = await resolveDefaultTarget(git, '/repo', ['v1.0']);
    assert.deepStrictEqual(picked, { ref: DEVELOP, display: 'v1.0' });
  });
});

describe('ChangedFilesProvider default target', () => {
  const originalGetConfiguration = stub.workspace.getConfiguration;
  afterEach(() => {
    stub.workspace.getConfiguration = originalGetConfiguration;
  });

  function setDefaultTargetSetting(value: string): void {
    stub.workspace.getConfiguration = () => ({
      get: (key: string, fallback?: unknown) => (key === 'defaultTarget' ? value : fallback),
    });
  }

  function setup(
    git: ReturnType<typeof fakeGit>,
    seed: Record<string, unknown> = {},
    findRoot: () => Promise<string | undefined> = async () => '/repo',
  ) {
    const posted: Msg[] = [];
    const store = new Map<string, unknown>(Object.entries(seed));
    const memento = {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    };
    const provider = new ChangedFilesProvider(
      git,
      memento,
      stub.Uri.file('/ext'),
      findRoot,
    );
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

  function lastFiles(posted: Msg[]): Msg {
    const files = posted.filter((m) => m.type === 'files');
    assert.ok(files.length > 0, 'expected a files message');
    return files[files.length - 1];
  }

  it('compares against origin/main when no target was picked', async () => {
    const { provider, posted, store } = setup(fakeGit({ 'origin/main': MAIN }));
    await provider.refresh();
    assert.deepStrictEqual(provider.getCurrentTarget(), {
      ref: MAIN,
      display: 'origin/main',
      branch: 'origin/main',
    });
    assert.strictEqual(provider.getCurrentRepoRoot(), '/repo');
    assert.strictEqual(provider.isDefaultTarget(), true);
    const msg = lastFiles(posted);
    assert.strictEqual(msg.hasTarget, true);
    assert.strictEqual(msg.targetLabel, 'origin/main');
    assert.strictEqual(msg.targetIsDefault, true);
    // The default is resolved, not stored: a later setting change must win.
    assert.strictEqual(store.get('gitdiff.changedFiles.target'), undefined);
    provider.dispose();
  });

  it('follows origin/HEAD when both origin/main and origin/master exist', async () => {
    const { provider } = setup(
      fakeGit({ 'origin/main': MAIN, 'origin/master': MASTER }, undefined, 'origin/master'),
    );
    await provider.refresh();
    assert.deepStrictEqual(provider.getCurrentTarget(), {
      ref: MASTER,
      display: 'origin/master',
      branch: 'origin/master',
    });
    provider.dispose();
  });

  it('uses the branch typed in gitdiff.defaultTarget instead', async () => {
    setDefaultTargetSetting('develop');
    const { provider } = setup(fakeGit({ 'origin/main': MAIN, develop: DEVELOP }, undefined, 'origin/main'));
    await provider.refresh();
    assert.strictEqual(provider.getCurrentTarget()?.display, 'develop');
    assert.strictEqual(provider.getCurrentTarget()?.ref, DEVELOP);
    provider.dispose();
  });

  it('shows no target when the typed branch does not exist', async () => {
    setDefaultTargetSetting('nope');
    const { provider, posted } = setup(fakeGit({ 'origin/main': MAIN }));
    await provider.refresh();
    assert.strictEqual(provider.getCurrentTarget(), undefined);
    assert.strictEqual(lastFiles(posted).hasTarget, false);
    provider.dispose();
  });

  it('follows the default branch tip on refresh', async () => {
    const refs: Record<string, string> = { 'origin/main': MAIN };
    const { provider } = setup(fakeGit(refs));
    await provider.refresh();
    refs['origin/main'] = MASTER;
    await provider.refresh();
    assert.strictEqual(provider.getCurrentTarget()?.ref, MASTER);
    provider.dispose();
  });

  it('keeps the last default when an automatic refresh resolves nothing', async () => {
    const refs: Record<string, string> = { 'origin/main': MAIN };
    const { provider } = setup(fakeGit(refs));
    await provider.refresh();
    delete refs['origin/main'];
    await provider.refresh({ quiet: true });
    assert.strictEqual(provider.getCurrentTarget()?.ref, MAIN);
    // A refresh the user asked for reports the real state.
    await provider.refresh();
    assert.strictEqual(provider.getCurrentTarget(), undefined);
    provider.dispose();
  });

  it('a picked target wins over the default, and clearing it returns to the default', async () => {
    const { provider, posted } = setup(fakeGit({ 'origin/main': MAIN }));
    await provider.refresh();
    const picked = { ref: DEVELOP, display: 'feature', branch: 'feature' };
    await provider.setTarget(picked, '/repo');
    assert.deepStrictEqual(provider.getCurrentTarget(), picked);
    assert.strictEqual(provider.isDefaultTarget(), false);
    assert.strictEqual(lastFiles(posted).targetIsDefault, undefined);

    await provider.clearTarget();
    assert.strictEqual(provider.getCurrentTarget()?.display, 'origin/main');
    assert.strictEqual(provider.isDefaultTarget(), true);
    provider.dispose();
  });

  it('names a typed default that does not resolve, and only that', async () => {
    setDefaultTargetSetting('orgin/main');
    const typo = setup(fakeGit({ 'origin/main': MAIN }));
    await typo.provider.refresh();
    assert.strictEqual(lastFiles(typo.posted).defaultTargetMissing, 'orgin/main');
    typo.provider.dispose();

    // No remote at all with an empty setting is normal, not an error.
    stub.workspace.getConfiguration = originalGetConfiguration;
    const bare = setup(fakeGit({}));
    await bare.provider.refresh();
    assert.strictEqual(lastFiles(bare.posted).hasTarget, false);
    assert.strictEqual(lastFiles(bare.posted).defaultTargetMissing, undefined);
    bare.provider.dispose();
  });

  it('has no target, and does not throw, when the repo lookup fails', async () => {
    const { provider, posted } = setup(fakeGit({ 'origin/main': MAIN }), {}, async () => {
      throw new Error('not a git repository');
    });
    await provider.refresh();
    assert.strictEqual(provider.getCurrentTarget(), undefined);
    assert.strictEqual(lastFiles(posted).hasTarget, false);
    provider.dispose();
  });

  it('falls back to origin/main when reading origin/HEAD fails', async () => {
    const git = fakeGit({ 'origin/main': MAIN, 'origin/master': MASTER });
    git.remoteHead = async () => {
      throw new Error('git crashed');
    };
    const { provider } = setup(git);
    await provider.refresh();
    assert.strictEqual(provider.getCurrentTarget()?.display, 'origin/main');
    provider.dispose();
  });

  it('clears old rows when the tip moves and the automatic listing then fails', async () => {
    const refs: Record<string, string> = { 'origin/main': MAIN };
    const git = fakeGit(refs);
    const { provider, posted } = setup(git);
    await provider.refresh();
    assert.strictEqual((lastFiles(posted).files as unknown[]).length, 1);
    refs['origin/main'] = MASTER;
    git.listChangedPaths = async () => {
      throw new Error('index.lock exists');
    };
    await provider.refresh({ quiet: true });
    const msg = lastFiles(posted);
    assert.strictEqual(provider.getCurrentTarget()?.ref, MASTER);
    assert.deepStrictEqual(msg.files, []);
    assert.strictEqual(msg.hasTarget, true);
    assert.deepStrictEqual(provider.getAllFiles(), []);
    provider.dispose();
  });

  it('keeps the last list when an automatic listing fails on an unchanged target', async () => {
    const git = fakeGit({ 'origin/main': MAIN });
    const { provider, posted } = setup(git);
    await provider.refresh();
    const before = posted.length;
    git.listChangedPaths = async () => {
      throw new Error('index.lock exists');
    };
    await provider.refresh({ quiet: true });
    assert.strictEqual(posted.length, before, 'a quiet failure must not post');
    assert.strictEqual(provider.getAllFiles().length, 1);
    provider.dispose();
  });

  it('a target picked while the default is resolving is not overwritten', async () => {
    const git = fakeGit({ 'origin/main': MAIN });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const verify = git.verifyRef;
    git.verifyRef = async (root: string, name: string) => {
      await gate;
      return verify(root, name);
    };
    const { provider } = setup(git);
    const pending = provider.refresh();
    const picked = { ref: DEVELOP, display: 'feature', branch: 'feature' };
    // setTarget's own refresh skips default resolution for a picked target.
    await provider.setTarget(picked, '/repo');
    release();
    await pending;
    assert.deepStrictEqual(provider.getCurrentTarget(), picked);
    assert.strictEqual(provider.isDefaultTarget(), false);
    provider.dispose();
  });

  it('an older default resolution that lands last does not win', async () => {
    const git = fakeGit({ 'origin/main': MAIN, develop: DEVELOP });
    const gates: Array<() => void> = [];
    const verify = git.verifyRef;
    git.verifyRef = async (root: string, name: string) => {
      await new Promise<void>((r) => gates.push(r));
      return verify(root, name);
    };
    // The constructor starts its own resolution too (no target persisted),
    // so the gates hold: constructor, `first`, then `second`.
    const { provider } = setup(git);
    const first = provider.refresh(); // resolves origin/main
    await new Promise((r) => setImmediate(r));
    setDefaultTargetSetting('develop');
    const second = provider.refresh(); // resolves develop
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(gates.length, 3);
    gates[2](); // the newest one finishes first…
    await second;
    gates[0](); // …then the older ones land
    gates[1]();
    await first;
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(provider.getCurrentTarget()?.display, 'develop');
    provider.dispose();
  });

  it('resolves the default at startup without listing files', async () => {
    const git = fakeGit({ 'origin/main': MAIN });
    let listings = 0;
    git.listChangedPaths = async () => {
      listings++;
      return [{ relPath: 'src/a.ts', status: 'M' as const }];
    };
    const posted: Msg[] = [];
    const memento = { get: () => undefined, update: async () => {} };
    const provider = new ChangedFilesProvider(git, memento, stub.Uri.file('/ext'), async () => '/repo');
    const changes: number[] = [];
    provider.onDidChangeTarget(() => changes.push(1));
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.strictEqual(provider.getCurrentTarget()?.display, 'origin/main');
    assert.strictEqual(changes.length, 1, 'the title-bar context keys must hear about it');
    assert.strictEqual(listings, 0);
    assert.deepStrictEqual(posted, []);
    provider.dispose();
  });

  it('reviews the automatic default from its merge base and tracks HEAD without persisting it', async () => {
    stub.workspace.getConfiguration = () => ({
      get: (key: string, fallback?: unknown) => key === 'branchComparison' ? 'mergeBase' : fallback,
    });
    const refs: Record<string, string> = { 'origin/main': MAIN, HEAD: DEVELOP };
    const base = 'd'.repeat(40);
    const listings: string[][] = [];
    const git = {
      ...fakeGit(refs),
      mergeBase: async () => base,
      listChangedPaths: async (...args: string[]) => {
        listings.push(args);
        return [{ relPath: 'src/a.ts', status: 'M' as const }];
      },
    };
    const { provider, posted, store } = setup(git);
    try {
      await provider.refresh();
      assert.deepStrictEqual(provider.getCurrentTarget(), {
        ref: base, display: 'origin/main...HEAD', branch: 'origin/main', head: DEVELOP,
      });
      assert.strictEqual(provider.isDefaultTarget(), true);
      assert.deepStrictEqual(listings.at(-1), ['/repo', base, DEVELOP]);
      assert.strictEqual(lastFiles(posted).targetIsDefault, true);
      assert.strictEqual(lastFiles(posted).readOnly, true);
      assert.strictEqual(store.get('gitdiff.changedFiles.target'), undefined);

      refs.HEAD = MASTER;
      await provider.refresh();
      assert.strictEqual(provider.getCurrentTarget()?.head, MASTER);
      assert.strictEqual(provider.isDefaultTarget(), true);
      assert.deepStrictEqual(listings.at(-1), ['/repo', base, MASTER]);
      assert.strictEqual(store.get('gitdiff.changedFiles.target'), undefined);
    } finally {
      provider.dispose();
    }
  });

  it('drops the pinned HEAD when a picked branch returns to working-tree mode', async () => {
    let mode = 'mergeBase';
    stub.workspace.getConfiguration = () => ({
      get: (key: string, fallback?: unknown) => key === 'branchComparison' ? mode : fallback,
    });
    const git = {
      ...fakeGit({ main: MAIN, HEAD: DEVELOP }),
      mergeBase: async () => 'd'.repeat(40),
    };
    const { provider } = setup(git);
    try {
      await provider.setTarget({ ref: MAIN, display: 'main', branch: 'main' }, '/repo');
      assert.strictEqual(provider.getCurrentTarget()?.head, DEVELOP);
      mode = 'workingTree';
      await provider.refresh();
      assert.deepStrictEqual(provider.getCurrentTarget(), { ref: MAIN, display: 'main', branch: 'main' });
    } finally {
      provider.dispose();
    }
  });

  it('keeps a target persisted from an earlier session', async () => {
    const persisted = { ref: DEVELOP, display: 'feature', branch: 'feature', repoRoot: '/repo' };
    const { provider } = setup(fakeGit({ 'origin/main': MAIN }), {
      'gitdiff.changedFiles.target': persisted,
    });
    await provider.refresh();
    assert.strictEqual(provider.getCurrentTarget()?.display, 'feature');
    assert.strictEqual(provider.isDefaultTarget(), false);
    provider.dispose();
  });
});
