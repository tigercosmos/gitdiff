import * as vscode from 'vscode';
import { GitService } from './gitService';
import { GitShowProvider, GITDIFF_SCHEME } from './gitShowProvider';
import { ActiveDiffTracker } from './activeDiffTracker';
import { DiffOpener } from './diffOpener';
import { RefPicker } from './refPicker';
import { decodeGitdiffUri } from './util/uri';
import { ChangedFilesProvider, ChangedFile, VIEW_ID } from './changedFilesProvider';

export interface GitDiffExports {
  /** Internal — exposed only so integration tests can inspect filter state. */
  readonly changedFiles: ChangedFilesProvider;
}

export function activate(context: vscode.ExtensionContext): GitDiffExports {
  const git = new GitService();
  const provider = new GitShowProvider(git);
  const tracker = new ActiveDiffTracker();
  const opener = new DiffOpener(git);
  const picker = new RefPicker(git);
  const changedFiles = new ChangedFilesProvider(
    git,
    context.workspaceState,
    context.extensionUri,
  );
  const syncHasTargetContext = (): void => {
    void vscode.commands.executeCommand(
      'setContext',
      'gitdiff.hasTarget',
      changedFiles.getCurrentTarget() !== undefined,
    );
  };
  syncHasTargetContext();
  context.subscriptions.push(
    changedFiles,
    changedFiles.onDidChangeTarget(syncHasTargetContext),
    vscode.window.registerWebviewViewProvider(VIEW_ID, changedFiles, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GITDIFF_SCHEME, provider),
    tracker,
    vscode.commands.registerCommand('gitdiff.compareWithBranch', (uri?: vscode.Uri) =>
      runCompare('branch', uri, picker, opener, changedFiles),
    ),
    vscode.commands.registerCommand('gitdiff.compareWithCommit', (uri?: vscode.Uri) =>
      runCompare('commit', uri, picker, opener, changedFiles),
    ),
    vscode.commands.registerCommand('gitdiff.refresh', async () => {
      const active = tracker.getActiveGitdiffPair();
      if (!active) {
        void vscode.window.showInformationMessage('No active GitDiff diff to refresh.');
        return;
      }
      await refreshOrCloseUnsupported(git, provider, active.left, findTabForLeft(active.left), opener);
    }),
    vscode.commands.registerCommand('gitdiff.changeTarget', async () => {
      const active = tracker.getActiveGitdiffPair();
      if (!active) {
        void vscode.window.showInformationMessage('No active GitDiff diff.');
        return;
      }
      await runCompareForUri(active.right, 'pick', picker, opener, changedFiles);
    }),
    // Refresh all open gitdiff: tabs when our config changes, since that may
    // alter what `git` resolves to (e.g., gitdiff.gitPath).
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('gitdiff')) return;
      for (const { uri, tab } of openGitdiffTabs()) {
        await refreshOrCloseUnsupported(git, provider, uri, tab, opener);
      }
      changedFiles.refresh();
    }),

    vscode.commands.registerCommand('gitdiff.changedFiles.refresh', () => {
      void changedFiles.refresh();
    }),
    vscode.commands.registerCommand('gitdiff.changedFiles.setTarget', async () => {
      const fileUri = pickAnyWorkspaceFileUri();
      if (!fileUri) {
        void vscode.window.showInformationMessage(
          'GitDiff: open a folder containing a git repository first.',
        );
        return;
      }
      let repoRoot: string;
      try {
        repoRoot = await git.repoRoot(fileUri.fsPath);
      } catch {
        void vscode.window.showErrorMessage('GitDiff: Not a git repository.');
        return;
      }
      const picked = await picker.pickAny(fileUri);
      if (!picked) return;
      await changedFiles.setTarget(picked, repoRoot);
    }),
    vscode.commands.registerCommand(
      'gitdiff.changedFiles.openFile',
      async (file: ChangedFile) => {
        const target = changedFiles.getCurrentTarget();
        if (!target) return;
        await opener.open(vscode.Uri.file(file.absPath), target);
      },
    ),
    vscode.commands.registerCommand('gitdiff.changedFiles.clearTarget', async () => {
      const tabs: vscode.Tab[] = [];
      for (const { tab } of openGitdiffTabs()) tabs.push(tab);
      await changedFiles.clearTarget();
      if (tabs.length > 0) {
        await vscode.window.tabGroups.close(tabs);
      }
    }),
  );

  // Restore-sweep: any gitdiff: tabs that VSCode reopened before we activated
  // need a re-render now that the provider is registered. If the blob has
  // changed kind to binary/non-UTF-8 since the diff was first opened, close
  // it rather than show misleading content.
  void (async () => {
    for (const { uri, tab } of openGitdiffTabs()) {
      await refreshOrCloseUnsupported(git, provider, uri, tab);
    }
  })();

  return { changedFiles };
}

export async function deactivate(): Promise<void> {
  const toClose: vscode.Tab[] = [];
  for (const { tab } of openGitdiffTabs()) toClose.push(tab);
  if (toClose.length > 0) {
    await vscode.window.tabGroups.close(toClose);
  }
}

type Mode = 'branch' | 'commit' | 'pick';

async function runCompare(
  mode: Mode,
  uri: vscode.Uri | undefined,
  picker: RefPicker,
  opener: DiffOpener,
  changedFiles: ChangedFilesProvider,
): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) {
    void vscode.window.showInformationMessage('Open a file from your workspace first.');
    return;
  }
  await runCompareForUri(target, mode, picker, opener, changedFiles);
}

async function runCompareForUri(
  fileUri: vscode.Uri,
  mode: Mode,
  picker: RefPicker,
  opener: DiffOpener,
  changedFiles: ChangedFilesProvider,
): Promise<void> {
  if (fileUri.scheme !== 'file') {
    void vscode.window.showInformationMessage('Open a file from your workspace first.');
    return;
  }
  const picked = await pickRef(mode, picker, fileUri);
  if (!picked) return;
  const repoRoot = await opener.open(fileUri, picked);
  if (repoRoot) {
    // Populate the sidebar without blocking the compare command — the diff
    // tab is already open; the changed-files scan can finish in the
    // background and update the sidebar when ready.
    void changedFiles.setTarget(picked, repoRoot);
  }
}

function pickRef(mode: Mode, picker: RefPicker, fileUri: vscode.Uri) {
  switch (mode) {
    case 'commit':
      return picker.pickCommit(fileUri);
    case 'branch':
      return picker.pickBranch(fileUri);
    case 'pick':
      return picker.pickAny(fileUri);
  }
}

function pickAnyWorkspaceFileUri(): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === 'file') return active;
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.scheme === 'file' ? folder.uri : undefined;
}

function* openGitdiffTabs(): Generator<{ uri: vscode.Uri; tab: vscode.Tab }> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff && input.original.scheme === GITDIFF_SCHEME) {
        yield { uri: input.original, tab };
      }
    }
  }
}

function findTabForLeft(left: vscode.Uri): vscode.Tab | undefined {
  for (const { uri, tab } of openGitdiffTabs()) {
    if (uri.toString() === left.toString()) return tab;
  }
  return undefined;
}

/**
 * Refresh policy:
 *  - If the URI carries a `branch`, re-resolve it to the current tip SHA.
 *    If the SHA changed, close the old diff and open a new one against the
 *    new tip. (Keeps "Compare with Branch main" tracking main as it advances.)
 *  - If the resolved blob is binary/non-UTF-8, close with a warning rather
 *    than show misleading placeholder content.
 *  - Otherwise, fire onDidChange for the existing URI.
 */
async function refreshOrCloseUnsupported(
  git: GitService,
  provider: GitShowProvider,
  uri: vscode.Uri,
  tab: vscode.Tab | undefined,
  opener?: DiffOpener,
): Promise<void> {
  let parts: ReturnType<typeof decodeGitdiffUri>;
  try {
    parts = decodeGitdiffUri(uri);
  } catch {
    return;
  }

  let effectiveSha = parts.ref;
  let branchAdvanced = false;
  if (parts.branch) {
    try {
      const newSha = await git.verifyRef(parts.repoRoot, parts.branch);
      if (newSha !== parts.ref) {
        effectiveSha = newSha;
        branchAdvanced = true;
      }
    } catch {
      // Branch was deleted or renamed; leave SHA pinned.
    }
  }

  let kind: 'text' | 'binary' | 'nonUtf8' = 'text';
  let exists = true;
  try {
    const show = await git.showFileAtSha(parts.repoRoot, effectiveSha, parts.relPath);
    kind = show.kind;
    exists = show.exists;
  } catch {
    // ignore — fall through and let the provider surface the error.
  }
  if (kind === 'binary' || kind === 'nonUtf8') {
    void vscode.window.showWarningMessage(
      `GitDiff: ${parts.relPath} at ${effectiveSha.slice(0, 8)} is now ${
        kind === 'binary' ? 'binary' : 'not valid UTF-8'
      } — closing diff.`,
    );
    if (tab) {
      await vscode.window.tabGroups.close(tab);
    }
    return;
  }

  if (branchAdvanced && tab && opener) {
    // The diff was tracking a branch that has moved — re-open against the
    // new tip and close the old tab. If the modified side isn't a file: URI
    // for some reason, fall back to a plain refresh.
    const input = tab.input;
    if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === 'file') {
      await vscode.window.tabGroups.close(tab);
      await opener.open(input.modified, {
        ref: effectiveSha,
        display: parts.branch!,
        branch: parts.branch,
      });
      return;
    }
  }

  void exists; // currently unused; kept for future title updates.
  provider.refresh(uri);
}
