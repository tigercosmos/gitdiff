import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from './gitService';
import { encodeGitdiffUri } from './util/uri';
import type { PickedRef } from './refPicker';

export class DiffOpener {
  constructor(private readonly git: GitService) {}

  /**
   * Open a diff comparing `fileUri` (working-tree, editable) against `picked`.
   * The picker has already resolved the ref to a full SHA. If `picked.branch`
   * is set, the URI carries the branch name so refresh can re-resolve to the
   * branch's current tip.
   *
   * Returns the resolved `repoRoot` on success so the caller can wire other
   * UI (e.g. the changed-files sidebar) to the same repo + target. Returns
   * `undefined` if the diff was not opened (not-a-repo, binary, non-UTF-8).
   *
   * `relPathAtTarget` overrides the path read at the target — for a renamed
   * file, the pre-rename path — so the diff compares old content with the
   * renamed working-tree file rather than showing it as an addition.
   */
  async open(
    fileUri: vscode.Uri,
    picked: PickedRef,
    relPathAtTarget?: string,
  ): Promise<string | undefined> {
    let repoRoot: string;
    try {
      repoRoot = await this.git.repoRoot(fileUri.fsPath);
    } catch {
      void vscode.window.showErrorMessage('GitDiff: Not a git repository.');
      return undefined;
    }
    const relPath = relPathAtTarget ?? this.git.relPath(repoRoot, fileUri.fsPath);
    const sha = picked.ref;

    const show = await this.git.showFileAtSha(repoRoot, sha, relPath);
    if (show.exists && show.kind === 'binary') {
      void vscode.window.showWarningMessage(
        `GitDiff: ${path.basename(fileUri.fsPath)} at ${picked.display} is binary — diff not supported in v1.`,
      );
      return undefined;
    }
    if (show.exists && show.kind === 'nonUtf8') {
      void vscode.window.showWarningMessage(
        `GitDiff: ${path.basename(fileUri.fsPath)} at ${picked.display} is not valid UTF-8 — only UTF-8 text is supported in v1.`,
      );
      return undefined;
    }
    const left = encodeGitdiffUri({
      ref: sha,
      repoRoot,
      relPath,
      ...(picked.branch ? { branch: picked.branch } : {}),
    });
    const fileName = path.basename(fileUri.fsPath);
    const title = show.exists
      ? `${fileName} (vs ${picked.display})`
      : `${fileName} (new vs ${picked.display})`;
    await vscode.commands.executeCommand('vscode.diff', left, fileUri, title, {
      preview: false,
    });
    return repoRoot;
  }
}
