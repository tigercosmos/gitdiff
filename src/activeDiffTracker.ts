import * as vscode from 'vscode';
import { GITDIFF_SCHEME } from './gitShowProvider';

const CONTEXT_KEY = 'gitdiff.activeDiff';

export interface GitdiffPair {
  left: vscode.Uri;
  right: vscode.Uri;
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

  constructor() {
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.update()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.update()),
    );
    this.update();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
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

  private update(): void {
    const active = this.getActiveGitdiffPair() !== undefined;
    if (active === this.current) return;
    this.current = active;
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, active);
  }
}
