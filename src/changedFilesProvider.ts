import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from './gitService';
import type { PickedRef } from './refPicker';

export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface ChangedFile {
  /** Repo-relative POSIX path. */
  relPath: string;
  /** Workspace-absolute fs path. */
  absPath: string;
  status: ChangeStatus;
}

const STATE_KEY = 'gitdiff.changedFiles.target';

interface PersistedTarget {
  ref: string;
  display: string;
  branch?: string;
  /** Absolute repo root path so we know which repo this target belongs to. */
  repoRoot: string;
}

export class ChangedFilesProvider implements vscode.TreeDataProvider<ChangedFile> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private target: PersistedTarget | undefined;

  constructor(
    private readonly git: GitService,
    private readonly workspaceState: vscode.Memento,
  ) {
    this.target = workspaceState.get<PersistedTarget>(STATE_KEY);
  }

  getCurrentTarget(): PickedRef | undefined {
    if (!this.target) return undefined;
    return {
      ref: this.target.ref,
      display: this.target.display,
      ...(this.target.branch ? { branch: this.target.branch } : {}),
    };
  }

  getCurrentRepoRoot(): string | undefined {
    return this.target?.repoRoot;
  }

  async setTarget(picked: PickedRef, repoRoot: string): Promise<void> {
    this.target = {
      ref: picked.ref,
      display: picked.display,
      repoRoot,
      ...(picked.branch ? { branch: picked.branch } : {}),
    };
    await this.workspaceState.update(STATE_KEY, this.target);
    this.refresh();
  }

  async clearTarget(): Promise<void> {
    this.target = undefined;
    await this.workspaceState.update(STATE_KEY, undefined);
    this.refresh();
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(file: ChangedFile): vscode.TreeItem {
    const item = new vscode.TreeItem(
      path.basename(file.relPath),
      vscode.TreeItemCollapsibleState.None,
    );
    const dir = path.dirname(file.relPath);
    item.description = dir === '.' ? '' : dir;
    item.resourceUri = vscode.Uri.file(file.absPath);
    item.tooltip = `${file.relPath} (${statusLabel(file.status)})`;
    item.iconPath = iconForStatus(file.status);
    item.command = {
      command: 'gitdiff.changedFiles.openFile',
      title: 'Open Diff',
      arguments: [file],
    };
    item.contextValue = `changedFile.${file.status}`;
    return item;
  }

  async getChildren(): Promise<ChangedFile[]> {
    if (!this.target) return [];
    const { ref, repoRoot } = this.target;
    try {
      const [tracked, untracked] = await Promise.all([
        this.git.listChangedPaths(repoRoot, ref),
        this.git.listUntrackedPaths(repoRoot),
      ]);
      const seen = new Set<string>();
      const out: ChangedFile[] = [];
      for (const entry of tracked) {
        if (seen.has(entry.relPath)) continue;
        seen.add(entry.relPath);
        out.push({ ...entry, absPath: path.join(repoRoot, entry.relPath) });
      }
      for (const rel of untracked) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        out.push({
          relPath: rel,
          absPath: path.join(repoRoot, rel),
          status: '?',
        });
      }
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    } catch (err) {
      void vscode.window.showErrorMessage(
        `GitDiff: failed to list changes: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}

function statusLabel(s: ChangeStatus): string {
  return (
    {
      M: 'modified',
      A: 'added',
      D: 'deleted',
      R: 'renamed',
      C: 'copied',
      T: 'type changed',
      U: 'unmerged',
      '?': 'untracked',
    } as const
  )[s];
}

function iconForStatus(s: ChangeStatus): vscode.ThemeIcon {
  switch (s) {
    case 'A':
      return new vscode.ThemeIcon(
        'diff-added',
        new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
      );
    case 'D':
      return new vscode.ThemeIcon(
        'diff-removed',
        new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
      );
    case '?':
      return new vscode.ThemeIcon(
        'diff-added',
        new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'),
      );
    case 'R':
    case 'C':
      return new vscode.ThemeIcon(
        'diff-renamed',
        new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      );
    case 'U':
      return new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'),
      );
    default:
      return new vscode.ThemeIcon(
        'diff-modified',
        new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      );
  }
}
