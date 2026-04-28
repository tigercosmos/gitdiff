import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { execGit } from './util/exec';
import { classifyBlob, BlobKind } from './util/encoding';

/**
 * Parse `git diff --name-status -z` output. R/C entries carry an extra path
 * (R<score>NUL<old>NUL<new>); we keep only the new path.
 */
export function parseNameStatusZ(
  text: string,
): Array<{ relPath: string; status: 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' }> {
  if (!text) return [];
  const parts = text.split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  const out: Array<{ relPath: string; status: 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' }> = [];
  let i = 0;
  while (i < parts.length) {
    const code = parts[i++] ?? '';
    if (!code) continue;
    const head = code.charAt(0).toUpperCase();
    if (head === 'R' || head === 'C') {
      i++; // skip the old path
      const next = parts[i++];
      if (next != null) out.push({ relPath: next, status: head as 'R' | 'C' });
    } else {
      const file = parts[i++];
      if (file != null) {
        const norm: 'M' | 'A' | 'D' | 'T' | 'U' =
          head === 'M' || head === 'A' || head === 'D' || head === 'T' || head === 'U'
            ? (head as 'M' | 'A' | 'D' | 'T' | 'U')
            : 'M';
        out.push({ relPath: file, status: norm });
      }
    }
  }
  return out;
}

export interface CommitInfo {
  shortSha: string;
  /** Full 40-char SHA, included so callers can match either form. */
  fullSha: string;
  subject: string;
  isoDate: string;
  author: string;
}

export interface BranchInfo {
  name: string;
  /** True for refs/remotes/* entries. */
  remote: boolean;
}

export interface ShowResult {
  exists: boolean;
  /** Raw bytes from `git show`. Empty when `exists` is false. */
  bytes: Buffer;
  kind: BlobKind;
}

export class GitService {
  private gitPath(): string {
    const cfg = vscode.workspace.getConfiguration('gitdiff').get<string>('gitPath');
    const trimmed = cfg?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : 'git';
  }

  /**
   * Resolve the repo root that contains the given absolute file path.
   * Returns the canonical (realpath-resolved) path, since `git rev-parse
   * --show-toplevel` resolves symlinks. On macOS, `/var/folders/...` ↔
   * `/private/var/folders/...` is the common offender.
   */
  async repoRoot(absFilePath: string): Promise<string> {
    const dir = path.dirname(absFilePath);
    const result = await execGit(this.gitPath(), ['-C', dir, 'rev-parse', '--show-toplevel'], dir);
    return result.stdout.toString('utf8').trim();
  }

  /**
   * repo-relative POSIX path. Canonicalizes the *containing directory* (so
   * macOS `/var` ↔ `/private/var` symlinks line up with `repoRoot`'s
   * realpath-resolved form), then re-appends the basename so a tracked
   * symlink file is compared as itself rather than as its target.
   */
  relPath(repoRoot: string, absFilePath: string): string {
    const dir = path.dirname(absFilePath);
    const base = path.basename(absFilePath);
    let canonDir = dir;
    try {
      canonDir = fs.realpathSync(dir);
    } catch {
      // dir may not exist yet (new file); fall through with raw dir.
    }
    return path.relative(repoRoot, path.join(canonDir, base)).split(path.sep).join('/');
  }

  async listBranchesLocal(repoRoot: string): Promise<BranchInfo[]> {
    const r = await execGit(
      this.gitPath(),
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      repoRoot,
    );
    return r.stdout
      .toString('utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ name, remote: false }));
  }

  async listBranchesRemote(repoRoot: string): Promise<BranchInfo[]> {
    // `--exclude=refs/remotes/*/HEAD` requires git 2.40+; we filter in JS for
    // portability with older system gits (macOS Apple Git 2.39, etc.).
    const r = await execGit(
      this.gitPath(),
      ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'],
      repoRoot,
    );
    return r.stdout
      .toString('utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((name) => !/\/HEAD$/.test(name))
      .map((name) => ({ name, remote: true }));
  }

  /**
   * List recent commits, optionally restricted to a path.
   * Records are NUL-terminated; fields within a record are NUL-separated:
   * `<fullSha>NUL<shortSha>NUL<subject>NUL<isoDate>NUL<author>`.
   */
  async listCommits(
    repoRoot: string,
    limit: number,
    relPath?: string,
  ): Promise<CommitInfo[]> {
    const args = [
      'log',
      '-z',
      '--pretty=format:%H%x00%h%x00%s%x00%cI%x00%an',
      '-n',
      String(limit),
    ];
    if (relPath) args.push('--', relPath);
    const r = await execGit(this.gitPath(), args, repoRoot);
    const text = r.stdout.toString('utf8');
    if (!text) return [];
    // Records are separated by a NUL appended to the last field of the
    // previous record. Trim a possible trailing NUL, then split.
    const trimmed = text.endsWith('\0') ? text.slice(0, -1) : text;
    const records = trimmed.split('\0');
    const commits: CommitInfo[] = [];
    for (let i = 0; i + 4 < records.length; i += 5) {
      commits.push({
        fullSha: records[i],
        shortSha: records[i + 1],
        subject: records[i + 2],
        isoDate: records[i + 3],
        author: records[i + 4],
      });
    }
    return commits;
  }

  /**
   * Verify that `ref` resolves to a commit object in this repo. Returns the
   * full 40-char SHA on success. Throws if the ref is invalid (typo,
   * deleted branch, etc.). Rejects `-`-prefixed input up front to prevent
   * any ref-as-option injection into downstream `git` calls.
   */
  async verifyRef(repoRoot: string, ref: string): Promise<string> {
    const trimmed = ref.trim();
    if (!trimmed) throw new Error('Empty ref');
    if (trimmed.startsWith('-')) {
      throw new Error(`GitDiff: refs cannot begin with '-' (got '${trimmed}').`);
    }
    const r = await execGit(
      this.gitPath(),
      ['rev-parse', '--verify', '--end-of-options', `${trimmed}^{commit}`],
      repoRoot,
      { allowNonZero: true },
    );
    if (r.code !== 0) {
      throw new Error(
        `GitDiff: '${trimmed}' is not a valid revision in this repository.`,
      );
    }
    return r.stdout.toString('utf8').trim();
  }

  /**
   * Returns true iff `relPath` exists in the tree of `ref`. Distinguishes
   * "path not present" (false) from other failures (which throw). Uses
   * `git ls-tree` so the empty tree at the ref doesn't get confused with
   * an invalid ref.
   */
  async pathExistsAtRef(repoRoot: string, sha: string, relPath: string): Promise<boolean> {
    const r = await execGit(
      this.gitPath(),
      ['ls-tree', '--name-only', '-z', '--end-of-options', sha, '--', relPath],
      repoRoot,
      { allowNonZero: true },
    );
    if (r.code !== 0) {
      // ls-tree against a verified SHA only fails for truly weird states.
      throw new Error(
        `GitDiff: failed to read tree at ${sha.slice(0, 8)}: ${r.stderr.toString('utf8').trim()}`,
      );
    }
    const text = r.stdout.toString('utf8');
    if (!text) return false;
    // ls-tree -z output is NUL-terminated; entries match `relPath` exactly.
    const entries = text.split('\0').filter(Boolean);
    return entries.includes(relPath);
  }

  /**
   * Files changed between the working tree (staged + unstaged) and `ref`.
   * `ref` may be a branch, tag, or SHA — caller is responsible for ensuring
   * it has been verified upstream (the tree can re-verify periodically).
   * Returns repo-relative POSIX paths plus a one-letter status code.
   * For renames/copies, only the *new* path is returned with status R/C.
   */
  async listChangedPaths(
    repoRoot: string,
    ref: string,
  ): Promise<Array<{ relPath: string; status: 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' }>> {
    const r = await execGit(
      this.gitPath(),
      ['diff', '--name-status', '-z', '--end-of-options', ref],
      repoRoot,
    );
    return parseNameStatusZ(r.stdout.toString('utf8'));
  }

  /** Untracked files (excluding ignored), repo-relative POSIX paths. */
  async listUntrackedPaths(repoRoot: string): Promise<string[]> {
    const r = await execGit(
      this.gitPath(),
      ['ls-files', '--others', '--exclude-standard', '-z'],
      repoRoot,
    );
    return r.stdout.toString('utf8').split('\0').filter(Boolean);
  }

  /**
   * Read file bytes at a verified SHA. Caller distinguishes binary/text via
   * `kind`. Returns `exists: false` only when the path genuinely is not
   * present in the tree at this ref; any other failure throws.
   */
  async showFileAtSha(repoRoot: string, sha: string, relPath: string): Promise<ShowResult> {
    const exists = await this.pathExistsAtRef(repoRoot, sha, relPath);
    if (!exists) {
      return { exists: false, bytes: Buffer.alloc(0), kind: 'text' };
    }
    const r = await execGit(
      this.gitPath(),
      ['show', '--end-of-options', `${sha}:${relPath}`],
      repoRoot,
    );
    const kind = classifyBlob(r.stdout);
    return { exists: true, bytes: r.stdout, kind };
  }
}
