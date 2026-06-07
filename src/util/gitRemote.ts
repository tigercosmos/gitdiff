/**
 * Pure helpers for turning a git remote URL into web links and for guessing a
 * pull/merge-request number out of a commit subject. No `vscode` or `child_process`
 * dependency, so they're directly unit-testable.
 *
 * We deliberately avoid any network/API access: the PR number is recovered from
 * the commit subject (GitHub squash `(#123)`, merge commits `Merge pull request
 * #123`, GitLab `See merge request …!123`), which covers the common host
 * conventions without a token.
 */

export interface RemoteWeb {
  /** Lower-cased host, e.g. `github.com`. */
  host: string;
  /** `https://host/owner/repo` with no trailing slash or `.git`. */
  base: string;
}

/**
 * Normalize a git remote URL into a browsable `https` base. Handles the three
 * forms git emits: `https://host/owner/repo(.git)`, `ssh://git@host/owner/repo`,
 * and the SCP-like `git@host:owner/repo(.git)`. Returns undefined for anything
 * we can't confidently map (local paths, unrecognised shapes).
 */
export function parseRemoteWebBase(remoteUrl: string): RemoteWeb | undefined {
  const raw = remoteUrl.trim();
  if (!raw) return undefined;

  let host: string;
  let pathPart: string;
  // Port suffix to keep on the web origin. Preserved only for http(s) remotes
  // (a self-hosted instance serves its UI on that same port); an ssh:// port is
  // the SSH port, not a web port, so it's dropped.
  let portSuffix = '';

  if (raw.includes('://')) {
    // scheme://[user@]host[:port]/owner/repo
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.+)$/.exec(raw);
    if (!m) return undefined;
    const scheme = m[1].toLowerCase();
    // Only schemes that map to a browsable host. `file://`, `ftp://`, etc. are
    // local/non-web and must not be turned into bogus https links.
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ssh' && scheme !== 'git') {
      return undefined;
    }
    host = m[2];
    if (m[3] && (scheme === 'http' || scheme === 'https')) portSuffix = `:${m[3]}`;
    pathPart = m[4];
  } else {
    // SCP-like: [user@]host:owner/repo  (the colon separates host from path)
    const m = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(raw);
    if (!m) return undefined;
    host = m[1];
    pathPart = m[2];
    // A single-letter "host" is a Windows drive (e.g. `C:\repos\origin.git`),
    // not a real remote — and a backslash anywhere marks a local Windows path.
    // Treat both as local paths we can't turn into web links.
    if (/^[a-zA-Z]$/.test(host) || raw.includes('\\')) return undefined;
  }

  // Strip a trailing slash and a `.git` suffix from the repo path.
  pathPart = pathPart.replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!host || !pathPart) return undefined;

  const lcHost = host.toLowerCase();
  // host stays portless (used for the gitlab/bitbucket host checks); the port
  // rides on the base URL only.
  return { host: lcHost, base: `https://${lcHost}${portSuffix}/${pathPart}` };
}

export function buildCommitUrl(remote: RemoteWeb, sha: string): string {
  // Bitbucket uses `/commits/<sha>` (plural); GitHub/GitLab use `/commit/<sha>`.
  const segment = remote.host.includes('bitbucket') ? 'commits' : 'commit';
  return `${remote.base}/${segment}/${sha}`;
}

export interface PullRequestRef {
  number: number;
  /** `pull` for GitHub/Bitbucket pull requests, `mr` for GitLab merge requests. */
  kind: 'pull' | 'mr';
}

/**
 * Recover a pull/merge-request number from a commit subject without hitting any
 * API. Tries strong signals first (merge-commit phrasing, trailing `(#n)`),
 * then a loose `#n`/`!n` fallback. `!n` implies a GitLab merge request.
 */
export function detectPullRequest(summary: string): PullRequestRef | undefined {
  if (!summary) return undefined;

  // GitHub/Bitbucket merge commit: "Merge pull request #123 from …"
  let m = /\bMerge pull request #(\d+)\b/i.exec(summary);
  if (m) return { number: Number(m[1]), kind: 'pull' };

  // GitLab merge commit: "Merge branch '…' … See merge request group/proj!123"
  m = /\bmerge request\b[^!]*!(\d+)\b/i.exec(summary);
  if (m) return { number: Number(m[1]), kind: 'mr' };

  // Squash/rebase merges put the reference in parentheses at the end.
  m = /\(#(\d+)\)\s*$/.exec(summary);
  if (m) return { number: Number(m[1]), kind: 'pull' };
  m = /\(!(\d+)\)\s*$/.exec(summary);
  if (m) return { number: Number(m[1]), kind: 'mr' };

  // Loose fallback anywhere in the subject.
  m = /(?:^|\s)!(\d+)\b/.exec(summary);
  if (m) return { number: Number(m[1]), kind: 'mr' };
  m = /(?:^|\s)#(\d+)\b/.exec(summary);
  if (m) return { number: Number(m[1]), kind: 'pull' };

  return undefined;
}

/**
 * Web URL for a pull/merge request. The path segment depends on host
 * convention, but an explicit GitLab `!n` reference forces the merge-request
 * path even on hosts we'd otherwise treat as GitHub-style.
 */
export function buildPrUrl(remote: RemoteWeb, pr: PullRequestRef): string {
  if (pr.kind === 'mr' || remote.host.includes('gitlab')) {
    return `${remote.base}/-/merge_requests/${pr.number}`;
  }
  if (remote.host.includes('bitbucket')) {
    return `${remote.base}/pull-requests/${pr.number}`;
  }
  return `${remote.base}/pull/${pr.number}`;
}
