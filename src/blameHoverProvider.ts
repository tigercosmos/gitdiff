import * as vscode from 'vscode';
import { ActiveDiffTracker } from './activeDiffTracker';
import { GITDIFF_SCHEME } from './gitShowProvider';
import { BlameInfo, GitService } from './gitService';
import { decodeGitdiffUri } from './util/uri';
import {
  BlameLinks,
  isUncommitted,
  OPEN_COMMIT_DIFF_COMMAND,
  renderBlameMarkdown,
} from './blameFormat';
import {
  buildCommitUrl,
  buildPrUrl,
  detectPullRequest,
  parseRemoteWebBase,
  RemoteWeb,
} from './util/gitRemote';

// Re-exported for callers/tests that imported it from here historically.
export { formatBlameDate } from './blameFormat';

interface BlameTarget {
  repoRoot: string;
  relPath: string;
  ref?: string;
  contents?: string;
  version?: number;
  uriKey?: string;
}

/**
 * Build the rich hover/decoration links for a blamed line: an in-editor "open
 * this commit's diff for the file" command, and (when a remote is configured)
 * web links to the commit and its pull/merge request. `remoteFor` is provided
 * by the caller so the remote-URL lookup can be cached per repo root.
 */
export async function buildBlameLinks(
  info: BlameInfo,
  repoRoot: string,
  relPath: string,
  remoteFor: (repoRoot: string) => Promise<RemoteWeb | undefined>,
): Promise<BlameLinks> {
  if (isUncommitted(info.fullSha)) return {};
  // Open the diff against the path the file had *at the blamed commit*: when the
  // line predates a rename, git blame attributes it to a commit where the file
  // lived under its old name, and `sha:currentPath` would be empty/wrong.
  const blamedPath = info.filename || relPath;
  // A command: URI carries its arguments as a URI-encoded JSON *array* of
  // positional args; our handler takes a single options object, so wrap it.
  const args = encodeURIComponent(
    JSON.stringify([{ repoRoot, relPath: blamedPath, sha: info.fullSha }]),
  );
  const links: BlameLinks = {
    openFileDiffCommand: `command:${OPEN_COMMIT_DIFF_COMMAND}?${args}`,
  };
  const remote = await remoteFor(repoRoot);
  if (remote) {
    links.commitUrl = buildCommitUrl(remote, info.fullSha);
    const pr = detectPullRequest(info.summary);
    if (pr) {
      links.pr = {
        url: buildPrUrl(remote, pr),
        label: `${pr.kind === 'mr' ? '!' : '#'}${pr.number}`,
      };
    }
  }
  return links;
}

export class BlameHoverProvider implements vscode.HoverProvider, vscode.Disposable {
  // Bounded LRU-ish cache. The provider lives for the whole session and the
  // contents-based key includes document.version, so an unbounded Map would
  // accrue a fresh entry on every edit-then-hover. Cap it and evict the
  // oldest insertion (Map preserves insertion order) once full.
  private static readonly MAX_CACHE = 256;
  private readonly cache = new Map<string, Promise<BlameInfo | undefined>>();
  private readonly remoteCache = new Map<string, Promise<RemoteWeb | undefined>>();

  constructor(
    private readonly git: GitService,
    private readonly tracker: ActiveDiffTracker,
  ) {}

  dispose(): void {
    this.cache.clear();
    this.remoteCache.clear();
  }

  /**
   * External git state change (commit/checkout): contents-keyed entries are
   * keyed by document version, which does NOT change when a commit turns an
   * "uncommitted" line into a real SHA — drop them all.
   */
  handleGitStateChange(): void {
    this.cache.clear();
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const target = this.targetForDocument(document);
    if (!target) return undefined;

    let info: BlameInfo | undefined;
    try {
      info = await this.blame(target, position.line + 1);
    } catch {
      return undefined;
    }
    if (token.isCancellationRequested || !info) return undefined;

    const links = await buildBlameLinks(
      info,
      target.repoRoot,
      target.relPath,
      (root) => this.remote(root),
    );
    if (token.isCancellationRequested) return undefined;

    return new vscode.Hover(renderBlameMarkdown(info, links));
  }

  /** Cached parse of a repo's `origin` remote into a browsable web base. */
  private remote(repoRoot: string): Promise<RemoteWeb | undefined> {
    let cached = this.remoteCache.get(repoRoot);
    if (!cached) {
      // Remote URL is best-effort (links only); swallow any failure to
      // undefined so a hover never breaks on a repo without a usable remote.
      cached = Promise.resolve()
        .then(() => this.git.remoteUrl(repoRoot))
        .then((url) => (url ? parseRemoteWebBase(url) : undefined))
        .catch(() => undefined);
      this.remoteCache.set(repoRoot, cached);
    }
    return cached;
  }

  private targetForDocument(document: vscode.TextDocument): BlameTarget | undefined {
    if (document.uri.scheme === GITDIFF_SCHEME) {
      try {
        const { repoRoot, relPath, ref } = decodeGitdiffUri(document.uri);
        return { repoRoot, relPath, ref };
      } catch {
        return undefined;
      }
    }

    if (document.uri.scheme !== 'file') return undefined;

    const active = this.tracker.getActiveGitdiffPair();
    if (!active || active.right.toString() !== document.uri.toString()) return undefined;

    try {
      const { repoRoot, relPath } = decodeGitdiffUri(active.left);
      return {
        repoRoot,
        relPath,
        contents: document.getText(),
        version: document.version,
        uriKey: document.uri.toString(),
      };
    } catch {
      return undefined;
    }
  }

  private blame(target: BlameTarget, line: number): Promise<BlameInfo | undefined> {
    const hasContents = target.contents !== undefined;
    const key = hasContents
      ? [
          target.repoRoot,
          target.uriKey,
          target.version ?? 0,
          target.relPath,
          line,
        ].join('\0')
      : [target.repoRoot, target.ref ?? '', target.relPath, line].join('\0');
    let cached = this.cache.get(key);
    if (!cached) {
      cached = (
        hasContents
          ? this.git.blameLineForContents(
              target.repoRoot,
              target.relPath,
              line,
              target.contents ?? '',
              target.ref,
            )
          : this.git.blameLine(target.repoRoot, target.relPath, line, target.ref)
      ).catch((err) => {
        // Only drop the entry if it's still the one we created — a later
        // hover may have evicted and replaced this key while we were pending.
        if (this.cache.get(key) === cached) this.cache.delete(key);
        throw err;
      });
      this.cache.set(key, cached);
      if (this.cache.size > BlameHoverProvider.MAX_CACHE) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    }
    return cached;
  }
}
