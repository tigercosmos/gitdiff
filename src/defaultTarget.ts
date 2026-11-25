import type { GitService } from './gitService';
import type { PickedRef } from './refPicker';

/**
 * Refs tried, in order, when `gitdiff.defaultTarget` is empty and
 * `origin/HEAD` is missing (a repo whose remote was added rather than
 * cloned). `main` comes first because it is the default branch name for new
 * repos on the major hosts; `master` covers older repos.
 */
export const AUTO_DEFAULT_TARGETS: readonly string[] = ['origin/main', 'origin/master'];

/**
 * The refs to try for the default target. A name typed in the setting is the
 * only candidate. Otherwise the branch `origin/HEAD` points at (the remote's
 * default branch, usually `origin/main` or `origin/master`) comes first, then
 * AUTO_DEFAULT_TARGETS. `originHead` is that branch's short name, e.g.
 * `origin/main` — never `origin/HEAD` itself, so the target keeps the real
 * branch name and tracks its tip.
 */
export function defaultTargetCandidates(setting: unknown, originHead?: string): string[] {
  const name = typeof setting === 'string' ? setting.trim() : '';
  if (name) return [name];
  const head = originHead?.trim();
  const out = head ? [head] : [];
  for (const ref of AUTO_DEFAULT_TARGETS) if (!out.includes(ref)) out.push(ref);
  return out;
}

/**
 * Resolve the first candidate that names a commit in `repoRoot`. A branch
 * (local or remote-tracking) keeps its name in `branch`, so diffs opened from
 * it track the branch tip on refresh, the same as a branch picked by hand.
 * Returns undefined when no candidate resolves.
 */
export async function resolveDefaultTarget(
  git: Pick<GitService, 'verifyRef' | 'isBranch'>,
  repoRoot: string,
  candidates: readonly string[],
): Promise<PickedRef | undefined> {
  for (const name of candidates) {
    let sha: string;
    try {
      sha = await git.verifyRef(repoRoot, name);
    } catch {
      continue;
    }
    const branch = await git.isBranch(repoRoot, name).catch(() => false);
    return { ref: sha, display: name, ...(branch ? { branch: name } : {}) };
  }
  return undefined;
}
