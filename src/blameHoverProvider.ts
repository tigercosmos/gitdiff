import * as vscode from 'vscode';
import { ActiveDiffTracker } from './activeDiffTracker';
import { GITDIFF_SCHEME } from './gitShowProvider';
import { BlameInfo, GitService } from './gitService';
import { decodeGitdiffUri } from './util/uri';

interface BlameTarget {
  repoRoot: string;
  relPath: string;
  ref?: string;
  contents?: string;
  version?: number;
  uriKey?: string;
}

export class BlameHoverProvider implements vscode.HoverProvider, vscode.Disposable {
  // Bounded LRU-ish cache. The provider lives for the whole session and the
  // contents-based key includes document.version, so an unbounded Map would
  // accrue a fresh entry on every edit-then-hover. Cap it and evict the
  // oldest insertion (Map preserves insertion order) once full.
  private static readonly MAX_CACHE = 256;
  private readonly cache = new Map<string, Promise<BlameInfo | undefined>>();

  constructor(
    private readonly git: GitService,
    private readonly tracker: ActiveDiffTracker,
  ) {}

  dispose(): void {
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

    return new vscode.Hover(this.render(info));
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

  private render(info: BlameInfo): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    // An all-zero SHA is git's sentinel for a line not in any commit (e.g. an
    // unsaved/uncommitted edit on the working-tree pane). git fills the author
    // and summary with placeholders ("Not Committed Yet", "Version of … from
    // standard input") that are noise to the reader — show a clean label.
    if (isUncommitted(info.fullSha)) {
      md.appendText('Not committed yet');
      return md;
    }
    md.appendMarkdown('**Author:** ');
    md.appendText(info.author);
    const date = formatBlameDate(info.authorTime, info.authorTz);
    if (date) {
      md.appendMarkdown('\n\n**Date:** ');
      md.appendText(date);
    }
    md.appendMarkdown('\n\n**Commit:** ');
    md.appendText(info.summary);
    md.appendMarkdown('\n\n`');
    md.appendText(info.shortSha);
    md.appendMarkdown('`');
    return md;
  }
}

function isUncommitted(sha: string): boolean {
  return /^0{40}$/.test(sha);
}

/**
 * Format git's `author-time` (Unix epoch seconds) into the commit's own
 * wall-clock time using its `author-tz` offset (e.g. "+0800"), as
 * `YYYY-MM-DD HH:MM ±TZ`. Pure and timezone-stable: it shifts the epoch by the
 * offset and reads UTC fields, so it doesn't depend on the host's local zone.
 * Returns '' for missing/invalid input so the caller can omit the line.
 */
export function formatBlameDate(epochSeconds: number, tz: string): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return '';
  const m = /^([+-])(\d{2})(\d{2})$/.exec(tz);
  const offsetMinutes = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const shifted = new Date((epochSeconds + offsetMinutes * 60) * 1000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const min = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}${m ? ` ${tz}` : ''}`;
}
