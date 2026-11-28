import * as vscode from 'vscode';
import { GitService } from './gitService';
import type { PickedRef } from './refPicker';

/** Resolve both endpoints together so lists and editors review the same commits. */
export async function resolveBranchTarget(
  git: GitService,
  repoRoot: string,
  branch: string,
): Promise<PickedRef> {
  const ref = await git.verifyRef(repoRoot, branch);
  const mode = vscode.workspace.getConfiguration('gitdiff', vscode.Uri.file(repoRoot))
    .get<string>('branchComparison', 'workingTree');
  if (mode !== 'mergeBase') return { ref, display: branch, branch };
  const head = await git.verifyRef(repoRoot, 'HEAD');
  const base = await git.mergeBase(repoRoot, ref, head);
  return { ref: base, display: `${branch}...HEAD`, branch, head };
}
