import * as vscode from 'vscode';
import { GITDIFF_SCHEME } from '../gitShowProvider';

export interface GitdiffParts {
  /** Full 40-char SHA — what the provider reads from. Pinned at open time. */
  ref: string;
  /** Absolute filesystem path to the repo root. */
  repoRoot: string;
  /** Repo-relative POSIX path to the file. */
  relPath: string;
  /**
   * Original branch name the user picked, if any. Refresh re-resolves this
   * to the current tip SHA, so a diff opened "vs main" keeps tracking main.
   * Absent for diffs opened against a specific commit (those stay pinned).
   */
  branch?: string;
  /**
   * URI path to show instead of `relPath`. The multi-file diff editor marks an
   * entry as renamed when its two sides' paths differ, so that view sets this
   * to the working-tree file's path.
   */
  displayPath?: string;
}

/**
 * Pure helpers — no `vscode` dependency, so they're unit-testable. The path is
 * always leading-slash; ref and repoRoot live in the query, percent-encoded
 * via URLSearchParams so they round-trip cleanly even when they contain `/`,
 * `?`, `#`, `&`, `%`, spaces, or non-ASCII characters.
 */
export function partsToPathAndQuery(parts: GitdiffParts): { path: string; query: string } {
  const shown = parts.displayPath ?? parts.relPath;
  const path = shown.startsWith('/') ? shown : `/${shown}`;
  const params = new URLSearchParams();
  params.set('ref', parts.ref);
  params.set('repo', parts.repoRoot);
  if (parts.displayPath !== undefined) params.set('rel', parts.relPath);
  if (parts.branch) params.set('branch', parts.branch);
  return { path, query: params.toString() };
}

export function pathAndQueryToParts(path: string, query: string): GitdiffParts {
  const params = new URLSearchParams(query);
  const ref = params.get('ref');
  const repoRoot = params.get('repo');
  if (!ref || !repoRoot) {
    throw new Error('Missing ref or repo in gitdiff URI query');
  }
  const branch = params.get('branch') ?? undefined;
  const rel = params.get('rel');
  return {
    ref,
    repoRoot,
    relPath: rel ?? (path.startsWith('/') ? path.slice(1) : path),
    ...(branch ? { branch } : {}),
    ...(rel !== null ? { displayPath: path } : {}),
  };
}

export function encodeGitdiffUri(parts: GitdiffParts): vscode.Uri {
  const { path, query } = partsToPathAndQuery(parts);
  return vscode.Uri.from({ scheme: GITDIFF_SCHEME, path, query });
}

export function decodeGitdiffUri(uri: vscode.Uri): GitdiffParts {
  if (uri.scheme !== GITDIFF_SCHEME) {
    throw new Error(`Expected ${GITDIFF_SCHEME}: URI, got ${uri.scheme}:`);
  }
  return pathAndQueryToParts(uri.path, uri.query);
}
