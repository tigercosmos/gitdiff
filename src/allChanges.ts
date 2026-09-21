import type { ChangedFile } from './changedFilesProvider';
import type { GitdiffParts } from './util/uri';

export interface ChangeEntry {
  absPath: string;
  /** Absent when the file does not exist at the target (added / untracked). */
  left?: GitdiffParts;
  /** False when the file no longer exists in the working tree (deleted). */
  hasRight: boolean;
}

/** Pure planner for the multi-file diff: which side each changed file has. */
export function planAllChanges(
  files: readonly ChangedFile[],
  target: { ref: string; branch?: string },
  repoRoot: string,
): ChangeEntry[] {
  return files.map((file) => {
    const entry: ChangeEntry = { absPath: file.absPath, hasRight: file.status !== 'D' };
    if (file.status !== 'A' && file.status !== '?') {
      entry.left = {
        ref: target.ref,
        repoRoot,
        relPath: file.origPath ?? file.relPath,
        ...(target.branch ? { branch: target.branch } : {}),
      };
    }
    return entry;
  });
}
