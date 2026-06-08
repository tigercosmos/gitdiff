import * as vscode from 'vscode';
import { GITDIFF_SCHEME } from './gitShowProvider';
import { decodeGitdiffUri } from './util/uri';

const CONTEXT_KEY = 'gitdiff.activeDiff';

export interface GitdiffPair {
  left: vscode.Uri;
  right: vscode.Uri;
}

/** Identifies which changed file the active gitdiff diff is showing. */
export interface ActiveDiffFile {
  repoRoot: string;
  /** Repo-relative POSIX path, matching ChangedFile.relPath. */
  relPath: string;
}

/**
 * Maintains the `gitdiff.activeDiff` context key (used to gate menu items)
 * by inspecting the active tab's input. There is no `onDidChangeActiveTab`
 * event on `TabGroups`; `onDidChangeTabs` and `onDidChangeTabGroups` together
 * cover focus changes, since the previously- and newly-active tab both
 * surface as "changed".
 */
export class ActiveDiffTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private current = false;
  private currentFileKey: string | undefined;

  /**
   * Fires when the changed file shown by the active gitdiff diff changes —
   * including to `undefined` when no gitdiff diff is active. Used to highlight
   * the corresponding row in the Changed Files view.
   */
  private readonly _onDidChangeActiveFile = new vscode.EventEmitter<
    ActiveDiffFile | undefined
  >();
  readonly onDidChangeActiveFile = this._onDidChangeActiveFile.event;

  constructor() {
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.update()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.update()),
    );
    this.update();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onDidChangeActiveFile.dispose();
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
  }

  getActiveGitdiffPair(): GitdiffPair | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab?.input;
    if (
      input instanceof vscode.TabInputTextDiff &&
      input.original.scheme === GITDIFF_SCHEME
    ) {
      return { left: input.original, right: input.modified };
    }
    return undefined;
  }

  /** The changed file the active gitdiff diff shows, if any. */
  getActiveFile(): ActiveDiffFile | undefined {
    const pair = this.getActiveGitdiffPair();
    if (!pair) return undefined;
    try {
      const { repoRoot, relPath } = decodeGitdiffUri(pair.left);
      return { repoRoot, relPath };
    } catch {
      return undefined;
    }
  }

  private update(): void {
    const active = this.getActiveGitdiffPair() !== undefined;
    if (active !== this.current) {
      this.current = active;
      void vscode.commands.executeCommand('setContext', CONTEXT_KEY, active);
    }
    const file = this.getActiveFile();
    const key = file ? `${file.repoRoot}\0${file.relPath}` : undefined;
    if (key !== this.currentFileKey) {
      this.currentFileKey = key;
      this._onDidChangeActiveFile.fire(file);
    }
  }
}
