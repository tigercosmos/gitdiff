import * as vscode from 'vscode';
import { BlameInfo } from './gitService';

/** git's sentinel SHA for a line not in any commit (uncommitted / unsaved). */
export function isUncommitted(sha: string): boolean {
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

/** Just the `YYYY-MM-DD` date in the commit's own timezone; '' when absent. */
export function formatBlameDateShort(epochSeconds: number, tz: string): string {
  const full = formatBlameDate(epochSeconds, tz);
  return full ? full.slice(0, 10) : '';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Compact one-line annotation for the inline (end-of-line) decoration:
 * `Author, YYYY-MM-DD • summary`. Uncommitted lines get a clean label.
 */
export function formatInlineBlame(info: BlameInfo): string {
  if (isUncommitted(info.fullSha)) return 'Not committed yet';
  const date = formatBlameDateShort(info.authorTime, info.authorTz);
  const head = date ? `${info.author}, ${date}` : info.author;
  const summary = truncate(info.summary, 50);
  return summary ? `${head} • ${summary}` : head;
}

export interface BlameLinks {
  /** `https://…/commit/<sha>` web URL, when a remote is configured. */
  commitUrl?: string;
  /** Associated PR/MR, when one can be recovered from the commit subject. */
  pr?: { url: string; label: string };
  /** `command:…` URI that opens this commit's diff for the file, in-editor. */
  openFileDiffCommand?: string;
}

/**
 * Rich hover markdown shared by the hover provider and the inline decoration.
 * `isTrusted` is scoped to our single command so an embedded `command:` link
 * works while no other command can be invoked from blame text; author/summary
 * are appended via `appendText`, which escapes markdown, so untrusted commit
 * metadata can't inject links or HTML.
 */
export function renderBlameMarkdown(info: BlameInfo, links: BlameLinks = {}): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  if (isUncommitted(info.fullSha)) {
    md.isTrusted = false;
    md.appendText('Not committed yet');
    return md;
  }
  md.isTrusted = { enabledCommands: [OPEN_COMMIT_DIFF_COMMAND] };

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

  const linkParts: string[] = [];
  if (links.openFileDiffCommand) {
    linkParts.push(`[$(git-commit) Open commit diff](${links.openFileDiffCommand})`);
  }
  if (links.commitUrl) {
    linkParts.push(`[$(link-external) View commit on web](${links.commitUrl})`);
  }
  if (links.pr) {
    linkParts.push(`[$(git-pull-request) ${links.pr.label}](${links.pr.url})`);
  }
  if (linkParts.length > 0) {
    md.appendMarkdown('\n\n');
    md.appendMarkdown(linkParts.join('  ·  '));
  }
  return md;
}

/** Command id that opens a commit's diff for a single file inside the editor. */
export const OPEN_COMMIT_DIFF_COMMAND = 'gitdiff.openCommitDiffForFile';
