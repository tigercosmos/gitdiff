import * as assert from 'assert';

// `extension.ts` imports `vscode` at module load time. Stub it before
// requiring the module — same pattern as the other unit tests.
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
const { pickAnyWorkspaceFileUri } = require('../../src/extension');

const REPO = '/Users/me/proj';
const WORKTREE = '/Users/me/proj/.worktrees/feature';

function setState(opts: { folders?: string[]; active?: string; activeScheme?: string }): void {
  stub.workspace.workspaceFolders = opts.folders?.map((p, index) => ({
    uri: stub.Uri.file(p),
    name: p,
    index,
  }));
  if (opts.active === undefined) {
    stub.window.activeTextEditor = undefined;
    return;
  }
  const uri = stub.Uri.file(opts.active);
  if (opts.activeScheme) {
    stub.window.activeTextEditor = {
      document: { uri: { ...uri, scheme: opts.activeScheme, fsPath: opts.active } },
    };
    return;
  }
  stub.window.activeTextEditor = { document: { uri } };
}

describe('pickAnyWorkspaceFileUri', () => {
  afterEach(() => {
    stub.workspace.workspaceFolders = undefined;
    stub.window.activeTextEditor = undefined;
  });

  it('uses the active editor when it lives inside the open folder', () => {
    setState({ folders: [REPO], active: `${REPO}/src/a.ts` });
    assert.strictEqual(pickAnyWorkspaceFileUri()?.fsPath, `${REPO}/src/a.ts`);
  });

  // The regression this guards: a window opened on a linked worktree with a
  // file from the *parent* repo focused used to resolve the parent repo, so
  // the sidebar silently listed the parent's changes.
  it('falls back to the workspace folder when the active file is outside it', () => {
    setState({ folders: [WORKTREE], active: `${REPO}/notes.md` });
    assert.strictEqual(pickAnyWorkspaceFileUri()?.fsPath, WORKTREE);
  });

  it('keeps the active editor when no folder is open (loose file window)', () => {
    setState({ active: '/elsewhere/scratch.ts' });
    assert.strictEqual(pickAnyWorkspaceFileUri()?.fsPath, '/elsewhere/scratch.ts');
  });

  it('uses the first workspace folder when no editor is focused', () => {
    setState({ folders: [WORKTREE, REPO] });
    assert.strictEqual(pickAnyWorkspaceFileUri()?.fsPath, WORKTREE);
  });

  it('ignores a non-file active editor', () => {
    setState({ folders: [WORKTREE], active: '/x/y.ts', activeScheme: 'gitdiff' });
    assert.strictEqual(pickAnyWorkspaceFileUri()?.fsPath, WORKTREE);
  });

  it('returns undefined when nothing is open', () => {
    setState({});
    assert.strictEqual(pickAnyWorkspaceFileUri(), undefined);
  });
});
