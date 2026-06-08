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
): Array<{ relPath: string; status: 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U'; origPath?: string }> {
  if (!text) return [];
  const parts = text.split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  const out: Array<{
    relPath: string;
    status: 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U';
    origPath?: string;
  }> = [];
  let i = 0;
  while (i < parts.length) {
    const code = parts[i++] ?? '';
    if (!code) continue;
    const head = code.charAt(0).toUpperCase();
    if (head === 'R' || head === 'C') {
      // Format: R<score>NUL<old>NUL<new>. Keep the new path as `relPath` but
      // retain the old path as `origPath` — a revert of a rename must restore
      // the old name, which is otherwise lost.
      const orig = parts[i++];
      const next = parts[i++];
      if (next != null) {
        out.push({
          relPath: next,
          status: head as 'R' | 'C',
          ...(orig ? { origPath: orig } : {}),
        });
      }
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

export interface BlameInfo {
  shortSha: string;
  fullSha: string;
  author: string;
  summary: string;
  /** Author time as Unix epoch seconds; 0 when absent (e.g. uncommitted). */
  authorTime: number;
  /** Author timezone offset as git emits it, e.g. "+0800"; '' when absent. */
  authorTz: string;
  /**
   * The file's path *at the blamed commit*, from the porcelain `filename`
   * line. Differs from the caller's current path when the line predates a
   * rename — callers opening `sha:path` must use this, not the live path.
   * '' when git omits it.
   */
  filename: string;
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

/**
 * Decode git's C-quoted path form (`"src/caf\303\251.txt"`) back to a literal
 * UTF-8 path. git quotes paths with non-ASCII or control characters when
 * `core.quotePath` is on (the default); octal `\NNN` escapes are raw bytes that
 * must be reassembled and decoded as UTF-8. An unquoted value is returned as-is.
 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const body = raw.slice(1, -1);
  const simple: Record<string, number> = {
    a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92,
  };
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      for (const b of Buffer.from(body[i], 'utf8')) bytes.push(b);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      break;
    }
    if (next >= '0' && next <= '7') {
      let oct = next;
      i++;
      for (let k = 0; k < 2 && body[i + 1] >= '0' && body[i + 1] <= '7'; k++) {
        oct += body[i + 1];
        i++;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
    } else if (next in simple) {
      bytes.push(simple[next]);
      i++;
    } else {
      // Unknown escape — keep the backslash literally, don't consume `next`.
      bytes.push(0x5c);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * True iff both paths are the same filesystem entry (same device + inode).
 * Used to detect a case-only rename collision on case-insensitive filesystems,
 * where two differently-cased names share one inode. Uses `lstatSync`, NOT
 * `statSync`: for a renamed *symlink* whose old and new names point at the same
 * target, following the links would report the target's inode for both and
 * wrongly call them the same entry — leaving the new link behind. lstat
 * compares the link entries themselves. A missing side (or any error) is
 * treated as "not the same". (For a genuine case-only collision the two names
 * are one directory entry, so they share an inode under lstat too.)
 */
function isSameFsEntry(a: string, b: string): boolean {
  try {
    const sa = fs.lstatSync(a);
    const sb = fs.lstatSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

export function parseBlameLinePorcelain(text: string): BlameInfo | undefined {
  const lines = text.split(/\r?\n/);
  const first = lines[0]?.trim();
  if (!first) return undefined;

  const fullSha = first.split(/\s+/, 1)[0];
  if (!fullSha) return undefined;

  let author = '';
  let summary = '';
  let authorTime = 0;
  let authorTz = '';
  let filename = '';
  for (const line of lines) {
    // `author ` must be tested before the `author-*` keys: `'author-time'`
    // does not start with `'author '` (index 6 is '-', not a space), so the
    // order is unambiguous, but keep `author-time`/`author-tz` as their own
    // branches rather than nesting under a generic `author` prefix.
    if (line.startsWith('author ')) {
      author = line.slice('author '.length);
    } else if (line.startsWith('author-time ')) {
      const n = Number(line.slice('author-time '.length).trim());
      if (Number.isFinite(n)) authorTime = n;
    } else if (line.startsWith('author-tz ')) {
      authorTz = line.slice('author-tz '.length).trim();
    } else if (line.startsWith('summary ')) {
      summary = line.slice('summary '.length);
    } else if (line.startsWith('filename ')) {
      filename = unquoteGitPath(line.slice('filename '.length));
    }
  }

  return {
    fullSha,
    shortSha: fullSha.slice(0, 8),
    author: author || 'Unknown author',
    summary: summary || '(no commit subject)',
    authorTime,
    authorTz,
    filename,
  };
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
  async repoRoot(absPath: string): Promise<string> {
    // `absPath` is usually a file, but the changed-files sidebar can hand us
    // the workspace folder itself (a directory) when no editor is active.
    // `path.dirname()` on a directory climbs above it — and for a worktree
    // nested in (or sibling to) the main repo that lands in the *wrong* repo,
    // so `--show-toplevel` resolves to the main repo instead of the worktree.
    // Use the path directly when it's a directory; only strip the basename
    // for files (or paths that don't exist yet, e.g. a not-yet-saved file).
    let dir = absPath;
    try {
      if (!fs.statSync(absPath).isDirectory()) {
        dir = path.dirname(absPath);
      }
    } catch (err) {
      // ENOENT: the path doesn't exist yet (e.g. an unsaved new file) — its
      // parent directory is the right place to resolve from. For any other
      // stat error (EACCES, …) the path *does* exist but we can't classify
      // it; climbing to the parent could resolve the *wrong* repo (a nested
      // worktree would resolve to its main repo), so leave `dir = absPath`
      // and let `git -C` surface the underlying error instead.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        dir = path.dirname(absPath);
      }
    }
    const result = await execGit(this.gitPath(), ['-C', dir, 'rev-parse', '--show-toplevel'], dir);
    return result.stdout.toString('utf8').trim();
  }

  /**
   * repo-relative POSIX path. Canonicalizes the *containing directory* (so
   * macOS `/var` ↔ `/private/var` symlinks line up with `repoRoot`'s
   * realpath-resolved form), then re-appends the basename so a tracked
   * symlink file is compared as itself rather than as its target.
   *
   * Directory arguments (e.g. the workspace folder itself, passed when no
   * editor is active) are canonicalized *whole* — including a symlinked final
   * component — so a symlinked worktree folder lines up with `repoRoot` and
   * yields `''` when they're the same directory, rather than re-appending the
   * unresolved symlink basename and producing an outside-repo pathspec.
   */
  relPath(repoRoot: string, absFilePath: string): string {
    // Use realpathSync.native (not plain realpathSync): on Windows the legacy
    // implementation leaves 8.3 short names (RUNNER~1) and drive-letter case
    // as-is, whereas `repoRoot` comes from git's `--show-toplevel` already in
    // long-name form (…runneradmin…). path.relative() between the two then
    // climbs out of the repo ("../../…/RUNNER~1/…"). .native resolves both to
    // the same canonical long-name form so the relative path stays in-repo.
    try {
      if (fs.statSync(absFilePath).isDirectory()) {
        const canon = fs.realpathSync.native(absFilePath);
        return path.relative(repoRoot, canon).split(path.sep).join('/');
      }
    } catch {
      // Path doesn't exist yet (new file) — fall through to the file logic.
    }
    const dir = path.dirname(absFilePath);
    const base = path.basename(absFilePath);
    let canonDir = dir;
    try {
      canonDir = fs.realpathSync.native(dir);
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

  async blameLine(
    repoRoot: string,
    relPath: string,
    line: number,
    ref?: string,
  ): Promise<BlameInfo | undefined> {
    if (!Number.isInteger(line) || line < 1) return undefined;
    if (ref?.startsWith('-')) {
      throw new Error(`GitDiff: refs cannot begin with '-' (got '${ref}').`);
    }

    // core.quotePath=false: emit the porcelain `filename` verbatim (UTF-8)
    // instead of C-quoting non-ASCII paths, so the value is usable as-is.
    const args = ['-c', 'core.quotePath=false', 'blame', '--line-porcelain', '-L', `${line},${line}`];
    if (ref) args.push(ref);
    args.push('--', relPath);

    const r = await execGit(this.gitPath(), args, repoRoot, { allowNonZero: true });
    if (r.code !== 0) return undefined;
    return parseBlameLinePorcelain(r.stdout.toString('utf8'));
  }

  async blameLineForContents(
    repoRoot: string,
    relPath: string,
    line: number,
    contents: string,
    ref?: string,
  ): Promise<BlameInfo | undefined> {
    if (!Number.isInteger(line) || line < 1) return undefined;
    if (ref?.startsWith('-')) {
      throw new Error(`GitDiff: refs cannot begin with '-' (got '${ref}').`);
    }

    const args = [
      '-c',
      'core.quotePath=false',
      'blame',
      '--line-porcelain',
      '--contents',
      '-',
      '-L',
      `${line},${line}`,
    ];
    if (ref) args.push(ref);
    args.push('--', relPath);

    const r = await execGit(this.gitPath(), args, repoRoot, {
      allowNonZero: true,
      input: contents,
    });
    if (r.code !== 0) return undefined;
    return parseBlameLinePorcelain(r.stdout.toString('utf8'));
  }

  /**
   * URL of the `origin` remote (falling back to the first configured remote),
   * or undefined when the repo has no remote. Used only to build web links —
   * never fed back into a git invocation, so a non-zero exit is non-fatal.
   */
  async remoteUrl(repoRoot: string): Promise<string | undefined> {
    const origin = await execGit(
      this.gitPath(),
      ['remote', 'get-url', 'origin'],
      repoRoot,
      { allowNonZero: true },
    );
    if (origin.code === 0) {
      const url = origin.stdout.toString('utf8').trim();
      if (url) return url;
    }
    // No `origin` — use whatever remote is configured first, if any.
    const list = await execGit(this.gitPath(), ['remote'], repoRoot, { allowNonZero: true });
    if (list.code !== 0) return undefined;
    const first = list.stdout.toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean)[0];
    if (!first) return undefined;
    const other = await execGit(
      this.gitPath(),
      ['remote', 'get-url', '--end-of-options', first],
      repoRoot,
      { allowNonZero: true },
    );
    if (other.code !== 0) return undefined;
    const url = other.stdout.toString('utf8').trim();
    return url || undefined;
  }

  /**
   * Full SHA of `sha`'s first parent, or undefined for a root commit (no
   * parent). `sha` must already be a verified full SHA. Used to diff a commit
   * against its predecessor for a single file.
   */
  async parentSha(repoRoot: string, sha: string): Promise<string | undefined> {
    if (sha.startsWith('-')) {
      throw new Error(`GitDiff: refs cannot begin with '-' (got '${sha}').`);
    }
    const r = await execGit(
      this.gitPath(),
      ['rev-parse', '--verify', '--end-of-options', `${sha}^`],
      repoRoot,
      { allowNonZero: true },
    );
    if (r.code !== 0) return undefined;
    const out = r.stdout.toString('utf8').trim();
    return out || undefined;
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
   *
   * The pathspec carries the `:(literal)` magic prefix so a path containing
   * fnmatch metacharacters (`*`, `?`, `[…]`) is matched verbatim. This keeps
   * the existence check in lock-step with the literal-pathspec `checkout`/`rm`
   * in `revertFileToRef`: `git checkout` DOES glob its pathspec while
   * `ls-tree`'s matching is more literal, so without this the gate and the
   * action it guards could disagree about which file(s) are involved — a
   * destructive mismatch for revert. (`:(literal)` is a no-op for ordinary
   * paths; the `--name-only` output is still the plain path, so the exact
   * `entries.includes(relPath)` comparison below is unaffected.)
   */
  async pathExistsAtRef(repoRoot: string, sha: string, relPath: string): Promise<boolean> {
    const r = await execGit(
      this.gitPath(),
      ['ls-tree', '--name-only', '-z', '--end-of-options', sha, '--', `:(literal)${relPath}`],
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
  ): Promise<
    Array<{ relPath: string; status: 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U'; origPath?: string }>
  > {
    // Rename detection follows the user's `diff.renames` config (git's default
    // is on). When a rename is detected it arrives as a single `R` row carrying
    // `origPath`, which revert uses to restore the old name; when it is off the
    // same rename surfaces as separate A+D rows that each revert correctly. We
    // deliberately do NOT force `-M`: a rename `R` row makes the diff opener and
    // the blame providers (which derive the editable side's path from the diff's
    // left `gitdiff:` URI) assume the left and right share one repo path, and
    // pinning detection on regardless of config widened that coupling.
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
   * Absolute paths of every *live* worktree linked to this repo (including
   * the main worktree). Parses `git worktree list --porcelain`. Records are
   * blank-line separated; each starts with `worktree <path>` and may carry a
   * `prunable ...` line if the worktree's directory has been removed. We
   * skip prunable entries so a stale path doesn't masquerade as a real
   * worktree and end up hiding newly-created files at the same location.
   * Returns an empty list on older git versions that don't recognise the
   * command.
   */
  async listWorktrees(repoRoot: string): Promise<string[]> {
    const r = await execGit(
      this.gitPath(),
      ['worktree', 'list', '--porcelain'],
      repoRoot,
      { allowNonZero: true },
    );
    if (r.code !== 0) return [];
    // Drive a small state machine over lines: a `worktree <path>` line
    // starts a new record; subsequent attribute lines (`HEAD`, `branch`,
    // `prunable`, `locked`, …) belong to it. Splitting on blank lines is
    // brittle across git versions (and trailing-newline quirks); treating
    // every `worktree` line as a record boundary is robust.
    const out: string[] = [];
    let current: { path: string; prunable: boolean } | undefined;
    const flush = (): void => {
      if (current && !current.prunable) out.push(current.path);
    };
    // Split on \r?\n so a Windows CRLF doesn't leave a trailing \r that breaks
    // the exact-match attribute checks below (e.g. `prunable\r` !== `prunable`).
    for (const line of r.stdout.toString('utf8').split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        flush();
        current = { path: line.slice('worktree '.length).trim(), prunable: false };
      } else if (current && (line === 'prunable' || line.startsWith('prunable '))) {
        current.prunable = true;
      }
    }
    flush();
    return out;
  }

  /**
   * Make `relPath` in the working tree match its state at `ref`:
   *  - present at `ref` → restore its content with `git checkout`, which
   *    overwrites both the working tree and the index entry.
   *  - absent at `ref` (a working-tree/staged addition) → drop any staged
   *    entry and delete the file from disk, so the result matches `ref`.
   * `ref` should already be verified; `-`-prefixed input is rejected up front
   * to prevent ref-as-option injection.
   *
   * `renameFrom` is the file's path *at the target* when this row is a rename
   * (the sidebar keeps only the new path for an `R` entry). Restoring the
   * target state then means bringing back the old name as well as removing the
   * new one — otherwise the revert leaves the old path deleted. Pass it ONLY
   * for true renames: for a copy the old path is unrelated and may carry edits
   * the user did not ask to discard.
   */
  async revertFileToRef(
    repoRoot: string,
    ref: string,
    relPath: string,
    renameFrom?: string,
  ): Promise<void> {
    if (ref.startsWith('-')) {
      throw new Error(`GitDiff: refs cannot begin with '-' (got '${ref}').`);
    }
    // `:(literal)` pathspec magic: `--` only ends options, it does NOT disable
    // glob interpretation — a path containing `*`, `?`, or `[…]` would
    // otherwise match (and destructively revert/unstage) sibling files. The
    // prefix forces git to treat the whole string as a literal path.
    const literalPath = `:(literal)${relPath}`;
    if (renameFrom && renameFrom !== relPath) {
      // Rename revert: restore the old name from the target FIRST (so a failure
      // aborts before we delete anything), then drop the new path.
      await execGit(
        this.gitPath(),
        ['checkout', ref, '--', `:(literal)${renameFrom}`],
        repoRoot,
      );
      // Index-only (`--cached`): drop the stale new-path entry. Safe to run
      // unconditionally — it never touches the working tree.
      await execGit(
        this.gitPath(),
        ['rm', '-f', '--cached', '--ignore-unmatch', '--', literalPath],
        repoRoot,
      );
      // Delete the new path from disk ONLY if it is a distinct filesystem entry
      // from the just-restored old path. A case-only rename (`Foo.ts` →
      // `foo.ts`) on a case-insensitive FS (default macOS/Windows) makes both
      // names the same inode, so deleting `relPath` would wipe the file the
      // checkout above just restored.
      const newAbs = path.join(repoRoot, relPath);
      const oldAbs = path.join(repoRoot, renameFrom);
      if (!isSameFsEntry(newAbs, oldAbs)) {
        await fs.promises.rm(newAbs, { recursive: true, force: true });
      }
      return;
    }
    if (await this.pathExistsAtRef(repoRoot, ref, relPath)) {
      // No `--end-of-options` here: `git checkout` misparses it as a second
      // ref ("only one reference expected, 2 given"). The leading-`-` guard
      // above is what protects the ref from being read as an option; `--`
      // separates it from the pathspec.
      await execGit(this.gitPath(), ['checkout', ref, '--', literalPath], repoRoot);
      return;
    }
    // Not present at `ref`: a working-tree addition (tracked-but-new or
    // untracked). `--ignore-unmatch` keeps `rm` at exit 0 when the path was
    // never staged, so we do NOT pass `allowNonZero` — a real failure (index
    // lock, rejected pathspec) must throw and abort before we delete from
    // disk, rather than leaving the index and working tree out of sync.
    // `-f` overrides the staged-content safety check.
    await execGit(
      this.gitPath(),
      ['rm', '-f', '--cached', '--ignore-unmatch', '--', literalPath],
      repoRoot,
    );
    // `recursive` so a directory-shaped entry (an added gitlink/submodule or an
    // untracked nested repo, which git reports as a single path) is removed
    // rather than throwing EISDIR; `force` so a path already gone is a no-op.
    await fs.promises.rm(path.join(repoRoot, relPath), { recursive: true, force: true });
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
