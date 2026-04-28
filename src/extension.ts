import * as vscode from 'vscode';
import { GitService } from './gitService';
import { GitShowProvider, GITDIFF_SCHEME } from './gitShowProvider';
import { ActiveDiffTracker } from './activeDiffTracker';
import { DiffOpener } from './diffOpener';
import { RefPicker } from './refPicker';
import { decodeGitdiffUri } from './util/uri';
import { ChangedFilesProvider, ChangedFile } from './changedFilesProvider';

export function activate(context: vscode.ExtensionContext): void {
  const git = new GitService();
  const provider = new GitShowProvider(git);
  const tracker = new ActiveDiffTracker();
  const opener = new DiffOpener(git);
  const picker = new RefPicker(git);
  const changedFiles = new ChangedFilesProvider(git, context.workspaceState);
  const changedFilesView = vscode.window.createTreeView('gitdiff.changedFiles', {
    treeDataProvider: changedFiles,
    showCollapseAll: false,
  });
  updateChangedFilesViewTitle(changedFilesView, changedFiles);

  context.subscriptions.push(
    changedFilesView,
    vscode.workspace.registerTextDocumentContentProvider(GITDIFF_SCHEME, provider),
    tracker,
    vscode.commands.registerCommand('gitdiff.compareWithBranch', (uri?: vscode.Uri) =>
      runCompare('branch', uri, picker, opener, changedFiles, changedFilesView),
    ),
    vscode.commands.registerCommand('gitdiff.compareWithCommit', (uri?: vscode.Uri) =>
      runCompare('commit', uri, picker, opener, changedFiles, changedFilesView),
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
      await runCompareForUri(active.right, 'pick', picker, opener, changedFiles, changedFilesView);
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
      changedFiles.refresh();
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
      updateChangedFilesViewTitle(changedFilesView, changedFiles);
    }),
    vscode.commands.registerCommand(
      'gitdiff.changedFiles.openFile',
      async (file: ChangedFile) => {
        const target = changedFiles.getCurrentTarget();
        if (!target) return;
        await opener.open(vscode.Uri.file(file.absPath), target);
      },
    ),
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
  changedFilesView: vscode.TreeView<unknown>,
): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) {
    void vscode.window.showInformationMessage('Open a file from your workspace first.');
    return;
  }
  await runCompareForUri(target, mode, picker, opener, changedFiles, changedFilesView);
}

async function runCompareForUri(
  fileUri: vscode.Uri,
  mode: Mode,
  picker: RefPicker,
  opener: DiffOpener,
  changedFiles: ChangedFilesProvider,
  changedFilesView: vscode.TreeView<unknown>,
): Promise<void> {
  if (fileUri.scheme !== 'file') {
    void vscode.window.showInformationMessage('Open a file from your workspace first.');
    return;
  }
  const picked =
    mode === 'commit'
      ? await picker.pickCommit(fileUri)
      : mode === 'branch'
        ? await picker.pickBranch(fileUri)
        : await picker.pickAny(fileUri);
  if (!picked) return;
  const repoRoot = await opener.open(fileUri, picked);
  if (repoRoot) {
    // Surface the just-picked target in the sidebar so the changed-files
    // tree is populated without a separate "Set Comparison Target" step.
    await changedFiles.setTarget(picked, repoRoot);
    updateChangedFilesViewTitle(changedFilesView, changedFiles);
  }
}

function pickAnyWorkspaceFileUri(): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === 'file') return active;
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.scheme === 'file' ? folder.uri : undefined;
}

function updateChangedFilesViewTitle(
  view: vscode.TreeView<unknown>,
  provider: ChangedFilesProvider,
): void {
  const target = provider.getCurrentTarget();
  view.description = target ? `vs ${target.display}` : undefined;
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
