import type { ChangedFile } from './changedFilesProvider';
import type { GitdiffParts } from './util/uri';
import type { PickedRef } from './refPicker';

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
  target: PickedRef,
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

/**
 * Whether `vscode.changes` will open a real multi-file diff editor.
 *
 * VS Code registers that editor only when `multiDiffEditor.experimental.enabled`
 * is on; the setting defaults to `false` before 1.87 and `true` from 1.87.
 * `version` is `vscode.version` (e.g. `1.85.2`, `1.90.0-insider`).
 */
export function multiDiffAvailable(version: string, experimentalSetting: boolean | undefined): boolean {
  if (experimentalSetting !== undefined) return experimentalSetting;
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 1 || (major === 1 && minor >= 87);
}
