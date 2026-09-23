import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from './gitService';
import { compilePatterns } from './util/glob';
import { compileSearch } from './util/search';
import type { PickedRef } from './refPicker';

export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface ChangedFile {
  relPath: string;
  absPath: string;
  status: ChangeStatus;
  /** For a rename (`R`), the file's path at the comparison target. */
  origPath?: string;
}

export interface FilterState {
  search: string;
  include: string;
  exclude: string;
  matchCase: boolean;
  matchWholeWord: boolean;
  useRegex: boolean;
}

/**
 * How the webview lays out the changed files: `tree` nests them under their
 * directories like the Explorer (folders first, single-child folder chains
 * compacted into one `a/b/c` row, collapsible); `list` is a flat list with a
 * dimmed directory suffix. Toggled from the view's title bar.
 */
export type ViewMode = 'tree' | 'list';
export const DEFAULT_VIEW_MODE: ViewMode = 'tree';

const STATE_KEY = 'gitdiff.changedFiles.target';
const FILTER_KEY = 'gitdiff.changedFiles.filter';
const VIEW_MODE_KEY = 'gitdiff.changedFiles.viewMode';
/** Skip content search on files larger than this (5 MB). */
const MAX_SEARCH_FILE_BYTES = 5 * 1024 * 1024;

export const DEFAULT_FILTER: FilterState = {
  search: '',
  include: '',
  exclude: '',
  matchCase: false,
  matchWholeWord: false,
  useRegex: false,
};

interface PersistedTarget {
  ref: string;
  display: string;
  branch?: string;
  repoRoot: string;
}

interface FilesMessage {
  type: 'files';
  files: Array<{ relPath: string; status: ChangeStatus }>;
  hasTarget: boolean;
  targetLabel: string;
  loading?: boolean;
  searchError?: string;
  /** relPath of the file shown by the active gitdiff diff, if any. */
  activeRelPath?: string;
  /**
   * Basename of the target's repo root, shown next to the target label. The
   * target carries its own repoRoot, which need not be the repo the window is
   * open on (comparing a file from another repo/worktree re-points it), so
   * naming the repo keeps a cross-repo list from looking like this repo's.
   */
  repoLabel?: string;
  /** Absolute repo root — the repo label's tooltip. */
  repoPath?: string;
}

interface InitMessage {
  type: 'init';
  filter: FilterState;
  viewMode: ViewMode;
}

/** Lightweight update of just the highlighted row, no list rebuild. */
interface ActiveFileMessage {
  type: 'activeFile';
  relPath?: string;
}

/** Switch the layout; the webview re-renders from the list it already holds. */
interface ViewModeMessage {
  type: 'viewMode';
  viewMode: ViewMode;
}

type OutgoingMessage = FilesMessage | InitMessage | ActiveFileMessage | ViewModeMessage;

export const VIEW_ID = 'gitdiff.changedFiles';

/**
 * Hosts the Changed Files view (WebviewView). Owns:
 *  - the comparison target (persisted in workspaceState)
 *  - the list of working-tree files that differ from the target, with sibling
 *    worktrees of the same repo excluded
 *  - the filter pipeline (path globs + content regex) and its cancellation
 */
export class ChangedFilesProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly _onDidChangeTarget = new vscode.EventEmitter<void>();
  readonly onDidChangeTarget = this._onDidChangeTarget.event;

  /**
   * Fires (debounced) when the target repo's git state changes underneath us
   * (HEAD/index/refs — commit, checkout, stage, merge…). Consumers use it to
   * drop caches whose results depend on repo state, e.g. line-blame results
   * that change when a commit lands even though no document changed.
   */
  private readonly _onDidChangeGitState = new vscode.EventEmitter<void>();
  readonly onDidChangeGitState = this._onDidChangeGitState.event;

  /** Fires after the layout toggles; the extension mirrors it into a context key for the title-bar buttons. */
  private readonly _onDidChangeViewMode = new vscode.EventEmitter<ViewMode>();
  readonly onDidChangeViewMode = this._onDidChangeViewMode.event;

  private target: PersistedTarget | undefined;
  private filter: FilterState;
  private viewMode: ViewMode;
  private view: vscode.WebviewView | undefined;
  private files: ChangedFile[] = [];
  /**
   * Two sequence counters, each guarding a different invariant:
   *  - `listSeq` bumps when the underlying file list is invalidated
   *    (setTarget, clearTarget, refresh). refresh() checks it after its
   *    awaits so a newer target can drop the older list build.
   *  - `filterSeq` bumps on every filter run. applyFilter() checks it so a
   *    newer filter input (or refresh) can drop an older filter result.
   * They are split because a filter edit must NOT cancel an in-flight
   * refresh — that previously left `this.files` empty until the next refresh.
   */
  private listSeq = 0;
  private filterSeq = 0;
  private viewSubs: vscode.Disposable[] = [];
  /** Watchers on the target repo's gitdir; recreated on every target change. */
  private gitWatchers: vscode.Disposable[] = [];
  /** Guards installGitWatcher against a target change racing the async gitDir lookup. */
  private gitWatcherSeq = 0;
  private autoRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly saveSub: vscode.Disposable;
  /**
   * The file shown by the active gitdiff diff, or undefined when no gitdiff
   * diff is focused. Stored raw (not yet matched against the target's repo) so
   * the highlight is recomputed live — the diff may become active before the
   * target is set, and the target can change while a diff stays focused.
   */
  private activeFile: { repoRoot: string; relPath: string } | undefined;

  constructor(
    private readonly git: GitService,
    private readonly workspaceState: vscode.Memento,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.target = workspaceState.get<PersistedTarget>(STATE_KEY);
    // workspaceState is on-disk JSON that could carry stale or hand-edited
    // shapes across version bumps — sanitize before trusting.
    const persistedFilter = workspaceState.get<Partial<FilterState>>(FILTER_KEY);
    this.filter = sanitizeFilter({ ...DEFAULT_FILTER, ...(persistedFilter ?? {}) });
    this.viewMode = sanitizeViewMode(workspaceState.get<unknown>(VIEW_MODE_KEY));
    // Keep the list live: a save inside the target repo means the working
    // tree changed, so the diff-vs-target list is stale.
    this.saveSub = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === 'file' && this.isUnderTargetRepo(doc.uri.fsPath)) {
        this.scheduleAutoRefresh(false);
      }
    });
    void this.installGitWatcher();
  }

  dispose(): void {
    if (this.autoRefreshTimer) clearTimeout(this.autoRefreshTimer);
    this.saveSub.dispose();
    for (const d of this.gitWatchers.splice(0)) d.dispose();
    for (const d of this.viewSubs.splice(0)) d.dispose();
    this._onDidChangeTarget.dispose();
    this._onDidChangeGitState.dispose();
    this._onDidChangeViewMode.dispose();
  }

  /**
   * Watch the target repo's gitdir for state changes (HEAD, index, merge
   * state, refs) so commits/checkouts/staging made outside this extension —
   * terminal git, the built-in SCM view — refresh the list without a manual
   * refresh. Two non-recursive watchers (gitdir root + gitdir/logs) rather
   * than one `**` pattern: recursive watching *outside* the workspace needs a
   * newer VS Code than our 1.85 engine floor, while non-recursive watching of
   * outside paths has been supported for years. `logs/HEAD` is the reflog,
   * touched by every commit/checkout/reset — the cheap "something happened"
   * signal even when the watched top-level files are updated atomically via
   * renames some platforms miss.
   */
  private async installGitWatcher(): Promise<void> {
    const token = ++this.gitWatcherSeq;
    for (const d of this.gitWatchers.splice(0)) d.dispose();
    const repoRoot = this.target?.repoRoot;
    if (!repoRoot) return;
    let gitDir: string;
    try {
      gitDir = await this.git.gitDir(repoRoot);
    } catch {
      return; // repo vanished / git missing — auto-refresh just degrades to manual.
    }
    if (token !== this.gitWatcherSeq) return;
    const subs: vscode.Disposable[] = [];
    const onGitEvent = (): void => this.scheduleAutoRefresh(true);
    for (const [base, glob] of [
      [gitDir, '{HEAD,index,ORIG_HEAD,MERGE_HEAD,packed-refs}'],
      [path.join(gitDir, 'logs'), 'HEAD'],
    ] as const) {
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(base), glob),
      );
      subs.push(w, w.onDidChange(onGitEvent), w.onDidCreate(onGitEvent), w.onDidDelete(onGitEvent));
    }
    this.gitWatchers = subs;
  }

  /** True when `fsPath` (or its canonical form) lives under the target repo. */
  private isUnderTargetRepo(fsPath: string): boolean {
    const root = this.target?.repoRoot;
    if (!root) return false;
    for (const p of [fsPath, canonicalize(fsPath)]) {
      const rel = path.relative(root, p);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return true;
    }
    return false;
  }

  /**
   * Debounced refresh for watcher/save events. Quiet: transient failures
   * (mid-rebase repo states, index churn) must not spam error toasts the way
   * a user-initiated refresh legitimately does. Skipped while the view is
   * hidden — `onDidChangeVisibility` already refreshes on re-show.
   */
  private scheduleAutoRefresh(gitStateChanged: boolean): void {
    if (gitStateChanged) this._onDidChangeGitState.fire();
    if (this.autoRefreshTimer) clearTimeout(this.autoRefreshTimer);
    this.autoRefreshTimer = setTimeout(() => {
      this.autoRefreshTimer = undefined;
      if (!this.target || !this.view?.visible) return;
      void this.refresh({ quiet: true });
    }, 400);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    // resolveWebviewView can fire again if the view is recreated (move,
    // toggle retainContextWhenHidden, etc.) — tear down the previous view's
    // listeners before installing new ones.
    for (const d of this.viewSubs.splice(0)) d.dispose();
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    // Register the message listener BEFORE assigning html: webview JS can
    // postMessage on first parse, and messages sent before the listener
    // attaches are not redelivered.
    this.viewSubs.push(
      view.webview.onDidReceiveMessage((msg) => {
        void this.onMessage(msg);
      }),
      view.onDidDispose(() => {
        this.view = undefined;
        for (const d of this.viewSubs.splice(0)) d.dispose();
      }),
      // On re-show, refresh: files on disk may have changed while hidden.
      // Do NOT re-post `init` — with retainContextWhenHidden=true the webview
      // keeps its inputs, and pushing init back would clobber local edits.
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          void this.refresh();
        }
      }),
    );
    view.webview.html = renderHtml(view.webview);
  }

  getCurrentTarget(): PickedRef | undefined {
    if (!this.target) return undefined;
    return {
      ref: this.target.ref,
      display: this.target.display,
      ...(this.target.branch ? { branch: this.target.branch } : {}),
    };
  }

  getCurrentRepoRoot(): string | undefined {
    return this.target?.repoRoot;
  }

  getAllFiles(): readonly ChangedFile[] {
    return this.files;
  }

  getFilter(): FilterState {
    return { ...this.filter };
  }

  getViewMode(): ViewMode {
    return this.viewMode;
  }

  /**
   * Switch between the tree and flat layouts. Persisted per workspace. The
   * webview keeps the last file list it was sent and re-renders it in the new
   * layout, so no git work or filter run is needed here.
   */
  async setViewMode(mode: ViewMode): Promise<void> {
    const next = sanitizeViewMode(mode);
    if (next === this.viewMode) return;
    this.viewMode = next;
    await this.workspaceState.update(VIEW_MODE_KEY, next);
    this._onDidChangeViewMode.fire(next);
    this.post({ type: 'viewMode', viewMode: next });
  }

  /**
   * Record the file the active gitdiff diff is showing. Pass `undefined` to
   * clear. The highlight is only applied when the diff's repo matches the
   * current target (see `effectiveActiveRelPath`), so an unrelated repo's diff
   * can't light up a same-named row here.
   */
  setActiveFile(file: { repoRoot: string; relPath: string } | undefined): void {
    const prev = this.effectiveActiveRelPath();
    this.activeFile = file ? { repoRoot: file.repoRoot, relPath: file.relPath } : undefined;
    const next = this.effectiveActiveRelPath();
    if (next === prev) return;
    this.post({ type: 'activeFile', relPath: next });
  }

  /** The currently highlighted row's relPath, or undefined. Exposed for tests. */
  getActiveRelPath(): string | undefined {
    return this.effectiveActiveRelPath();
  }

  /** Active file's relPath only when it belongs to the current target's repo. */
  private effectiveActiveRelPath(): string | undefined {
    return this.activeFile && this.activeFile.repoRoot === this.target?.repoRoot
      ? this.activeFile.relPath
      : undefined;
  }

  async setTarget(picked: PickedRef, repoRoot: string): Promise<void> {
    this.invalidate();
    this.files = [];
    this.target = {
      ref: picked.ref,
      display: picked.display,
      repoRoot,
      ...(picked.branch ? { branch: picked.branch } : {}),
    };
    await this.workspaceState.update(STATE_KEY, this.target);
    this._onDidChangeTarget.fire();
    void this.installGitWatcher();
    await this.refresh();
  }

  async clearTarget(): Promise<void> {
    this.invalidate();
    this.target = undefined;
    await this.workspaceState.update(STATE_KEY, undefined);
    this._onDidChangeTarget.fire();
    void this.installGitWatcher();
    this.files = [];
    this.post({
      type: 'files',
      files: [],
      hasTarget: false,
      targetLabel: '',
    });
  }

  async refresh(options: { quiet?: boolean } = {}): Promise<void> {
    const token = this.invalidate();
    if (!this.target) {
      this.files = [];
      this.post({ type: 'files', files: [], hasTarget: false, targetLabel: '' });
      return;
    }
    const { ref, repoRoot, display } = this.target;
    // Only blank the list into a "Loading…" state when there is nothing to
    // show yet (first load / target change). Re-refreshes — especially the
    // automatic ones on save and git activity — keep the previous rows on
    // screen until the new list lands, instead of flashing empty. Quiet
    // (auto) refreshes never post the spinner: their error path returns
    // without posting anything, so a spinner posted here would have nothing
    // to clear it and the view would be stuck on "Loading…".
    if (this.files.length === 0 && !options.quiet) {
      this.post({
        type: 'files',
        files: [],
        hasTarget: true,
        targetLabel: display,
        loading: true,
      });
    }
    try {
      const [tracked, untracked, worktrees] = await Promise.all([
        this.git.listChangedPaths(repoRoot, ref),
        this.git.listUntrackedPaths(repoRoot),
        this.git.listWorktrees(repoRoot).catch(() => []),
      ]);
      if (token !== this.listSeq) return;
      const exclude = computeWorktreeExclusion(repoRoot, worktrees);
      const seen = new Set<string>();
      const out: ChangedFile[] = [];
      for (const entry of tracked) {
        if (seen.has(entry.relPath)) continue;
        seen.add(entry.relPath);
        const abs = path.join(repoRoot, entry.relPath);
        if (isInsideAny(abs, exclude)) continue;
        out.push({ ...entry, absPath: abs });
      }
      for (const rel of untracked) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        const abs = path.join(repoRoot, rel);
        if (isInsideAny(abs, exclude)) continue;
        out.push({ relPath: rel, absPath: abs, status: '?' });
      }
      out.sort(byRelPath);
      this.files = out;
      await this.applyFilter();
    } catch (err) {
      if (token !== this.listSeq) return;
      if (options.quiet) {
        // Auto-refresh hit a transient repo state (mid-rebase, lock churn):
        // keep the last good list on screen and let the next event retry.
        return;
      }
      void vscode.window.showErrorMessage(
        `GitDiff: failed to list changes: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.files = [];
      this.post({
        type: 'files',
        files: [],
        hasTarget: true,
        targetLabel: display,
      });
    }
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; filter?: Partial<FilterState>; relPath?: string };
    switch (m.type) {
      case 'ready':
        this.post({ type: 'init', filter: this.filter, viewMode: this.viewMode });
        if (this.target) {
          await this.refresh();
        } else {
          this.post({ type: 'files', files: [], hasTarget: false, targetLabel: '' });
        }
        break;
      case 'setFilter': {
        if (!m.filter) break;
        const next = sanitizeFilter({ ...this.filter, ...m.filter });
        if (filterEquals(next, this.filter)) break;
        this.filter = next;
        await this.workspaceState.update(FILTER_KEY, this.filter);
        await this.applyFilter();
        break;
      }
      case 'openFile': {
        if (!m.relPath) return;
        const file = this.files.find((f) => f.relPath === m.relPath);
        if (file) {
          await vscode.commands.executeCommand('gitdiff.changedFiles.openFile', file);
        }
        break;
      }
      case 'revertFile': {
        if (!m.relPath) return;
        const file = this.files.find((f) => f.relPath === m.relPath);
        if (file) {
          await vscode.commands.executeCommand('gitdiff.changedFiles.revertFile', file);
        }
        break;
      }
      case 'setTarget':
        await vscode.commands.executeCommand('gitdiff.changedFiles.setTarget');
        break;
      case 'clearTarget':
        await vscode.commands.executeCommand('gitdiff.changedFiles.clearTarget');
        break;
      case 'refresh':
        await this.refresh();
        break;
    }
  }

  /**
   * Re-run the path-glob + optional content-regex pipeline and post the
   * result. Each call bumps `filterSeq`; awaited continuations drop their
   * publish if a newer call (filter edit or list refresh) has superseded
   * them. The list-level seq is independent — see the `listSeq`/`filterSeq`
   * comment on the class field.
   */
  private async applyFilter(): Promise<void> {
    const token = ++this.filterSeq;
    const result = await filterFiles(this.files, this.filter, {
      isCancelled: () => token !== this.filterSeq,
    });
    if (token !== this.filterSeq) return;
    this.post({
      type: 'files',
      files: result.files.map((f) => ({ relPath: f.relPath, status: f.status })),
      hasTarget: !!this.target,
      targetLabel: this.target?.display ?? '',
      ...(result.error ? { searchError: result.error } : {}),
    });
  }

  private invalidate(): number {
    // Bump filterSeq too — any in-flight filter run is operating on a list
    // that's about to be replaced, so its result would be meaningless.
    this.filterSeq++;
    return ++this.listSeq;
  }

  private post(msg: OutgoingMessage): void {
    if (!this.view) return;
    // Carry the active-file highlight on every list post so it survives
    // rebuilds (refresh/filter) — and so a target change re-evaluates which
    // row (if any) matches — without a separate round-trip.
    const active = this.effectiveActiveRelPath();
    let out: OutgoingMessage = msg;
    if (msg.type === 'files') {
      const extra: Partial<FilesMessage> = {};
      if (active !== undefined) extra.activeRelPath = active;
      if (this.target) {
        const root = this.target.repoRoot;
        // basename('/') is '' — fall back to the root itself so the label is
        // never blank.
        extra.repoLabel = path.basename(root) || root;
        extra.repoPath = root;
      }
      out = { ...msg, ...extra };
    }
    void this.view.webview.postMessage(out);
  }
}

function sanitizeFilter(f: FilterState): FilterState {
  return {
    search: typeof f.search === 'string' ? f.search : '',
    include: typeof f.include === 'string' ? f.include : '',
    exclude: typeof f.exclude === 'string' ? f.exclude : '',
    matchCase: !!f.matchCase,
    matchWholeWord: !!f.matchWholeWord,
    useRegex: !!f.useRegex,
  };
}

/** workspaceState is on-disk JSON — anything but the two known modes falls back to the default. */
function sanitizeViewMode(v: unknown): ViewMode {
  return v === 'list' || v === 'tree' ? v : DEFAULT_VIEW_MODE;
}

function filterEquals(a: FilterState, b: FilterState): boolean {
  return (
    a.search === b.search &&
    a.include === b.include &&
    a.exclude === b.exclude &&
    a.matchCase === b.matchCase &&
    a.matchWholeWord === b.matchWholeWord &&
    a.useRegex === b.useRegex
  );
}

function byRelPath(a: ChangedFile, b: ChangedFile): number {
  return a.relPath.localeCompare(b.relPath);
}

interface FilterResult {
  files: ChangedFile[];
  error?: string;
}

export interface FilterOptions {
  isCancelled?: () => boolean;
}

/** Max parallel `readFile` operations during a content search. */
const CONTENT_SCAN_CONCURRENCY = 8;

export async function filterFiles(
  files: readonly ChangedFile[],
  filter: FilterState,
  options: FilterOptions = {},
): Promise<FilterResult> {
  const include = compilePatterns(filter.include);
  const exclude = compilePatterns(filter.exclude);
  const compiled = compileSearch({
    query: filter.search,
    matchCase: filter.matchCase,
    matchWholeWord: filter.matchWholeWord,
    useRegex: filter.useRegex,
  });

  const pathOk: ChangedFile[] = [];
  for (const f of files) {
    if (include && !include.test(f.relPath)) continue;
    if (exclude && exclude.test(f.relPath)) continue;
    pathOk.push(f);
  }

  if (!compiled) return { files: pathOk };
  if ('error' in compiled) {
    // Invalid user regex — surface, but still apply path filters.
    return { files: pathOk, error: compiled.error };
  }

  const regex = compiled.regex;
  const isCancelled = options.isCancelled ?? (() => false);
  const matched: ChangedFile[] = [];
  let nextIndex = 0;

  // Bounded-concurrency worker pool. Each worker grabs the next index, does
  // its readFile/test, and yields cancellation checkpoints between candidates
  // so a superseded scan stops quickly instead of running to completion.
  async function worker(): Promise<void> {
    while (true) {
      if (isCancelled()) return;
      const i = nextIndex++;
      if (i >= pathOk.length) return;
      const f = pathOk[i];
      if (f.status === 'D') continue;
      try {
        const stat = await fs.promises.stat(f.absPath);
        if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) continue;
        if (isCancelled()) return;
        const content = await fs.promises.readFile(f.absPath, 'utf8');
        if (isCancelled()) return;
        if (regex.test(content)) matched.push(f);
      } catch {
        // Permission denied, symlink to non-existent target, etc.
      }
    }
  }

  const workers: Promise<void>[] = [];
  const n = Math.min(CONTENT_SCAN_CONCURRENCY, pathOk.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  matched.sort(byRelPath);
  return { files: matched };
}

/**
 * Build the canonical-path prefixes (with trailing path.sep) of sibling
 * worktrees that physically nest inside the main worktree's directory.
 * Files under those prefixes belong to a different worktree and must not
 * appear in the main worktree's changed-files list.
 */
export function computeWorktreeExclusion(
  repoRoot: string,
  worktrees: readonly string[],
): string[] {
  const mainCanon = canonicalize(repoRoot);
  const prefixes: string[] = [];
  for (const wt of worktrees) {
    if (!wt) continue;
    const canon = canonicalize(wt);
    if (canon === mainCanon) continue;
    if (isInside(canon, mainCanon)) {
      prefixes.push(canon + path.sep);
    }
  }
  return prefixes;
}

function canonicalize(p: string): string {
  try {
    // .native (not plain realpathSync) so Windows 8.3 short names and
    // drive-letter case resolve to the same canonical long-name form as the
    // git-sourced repoRoot these prefixes are compared against; otherwise
    // nested-worktree exclusion silently fails on Windows.
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(child: string, parent: string): boolean {
  if (child === parent) return false;
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Test whether `absPath` lives under one of the worktree `prefixes`. We
 * assume `absPath` is constructed via `path.join(repoRoot, …)` where
 * `repoRoot` is already canonical (production goes through `git rev-parse
 * --show-toplevel`; tests pass `fs.realpathSync(root)`). That lets us skip
 * a per-file `realpathSync` syscall, which used to dominate refresh() on
 * large change sets.
 */
function isInsideAny(absPath: string, prefixes: readonly string[]): boolean {
  if (prefixes.length === 0) return false;
  // Strip any trailing separator: git emits nested-worktree dir entries as
  // `wt-name/`, and we want to compare the entry itself against the prefix.
  const stripped = absPath.replace(/[\\/]+$/, '') + path.sep;
  for (const pre of prefixes) {
    if (stripped.startsWith(pre)) return true;
  }
  return false;
}

function makeNonce(): string {
  // CSP nonces must be unguessable: a predictable nonce lets injected
  // content carry `<script nonce="…">` that the browser will execute.
  return randomBytes(24).toString('base64');
}

/** Exported for unit tests, which execute the inlined script against a fake DOM. */
export function renderHtml(webview: vscode.Webview): string {
  const nonce = makeNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root { color-scheme: dark light; }
body {
  margin: 0;
  padding: 6px 6px 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
}
.row { position: relative; }
.row + .row { margin-top: 4px; }
.input-wrap {
  display: flex;
  align-items: center;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px;
  min-height: 24px;
  padding: 0 1px;
}
.input-wrap:focus-within { border-color: var(--vscode-focusBorder); }
.input-wrap input {
  flex: 1;
  background: transparent;
  color: inherit;
  border: 0;
  outline: 0;
  padding: 0 4px;
  font: inherit;
  line-height: 22px;
  min-width: 0;
}
.toggles {
  display: flex;
  gap: 1px;
  padding-right: 1px;
}
.toggle {
  appearance: none;
  background: transparent;
  color: inherit;
  border: 1px solid transparent;
  cursor: pointer;
  padding: 1px 4px;
  font: inherit;
  border-radius: 3px;
  line-height: 1;
  min-width: 22px;
  text-align: center;
  opacity: 0.75;
}
.toggle:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
.toggle.active {
  background: var(--vscode-inputOption-activeBackground);
  color: var(--vscode-inputOption-activeForeground);
  border-color: var(--vscode-inputOption-activeBorder, transparent);
  opacity: 1;
}
.target-bar {
  font-size: 11px;
  opacity: 0.8;
  margin: 8px 2px 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.target-repo { opacity: 0.75; }
.set-target-btn, .clear-target-btn {
  appearance: none;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: 0;
  padding: 4px 10px;
  margin-top: 6px;
  cursor: pointer;
  border-radius: 2px;
  font: inherit;
}
.set-target-btn:hover, .clear-target-btn:hover {
  background: var(--vscode-button-hoverBackground);
}
#files-list { list-style: none; padding: 0; margin: 4px 0 8px; }
#files-list li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 2px;
  white-space: nowrap;
}
#files-list li:hover { background: var(--vscode-list-hoverBackground); }
#files-list li:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; background: var(--vscode-list-focusBackground); }
#files-list li.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
/* Row whose diff is the active editor: a left accent + tinted background so
   it reads as "currently open" without mimicking keyboard selection. */
#files-list li.active-file {
  background: var(--vscode-list-inactiveSelectionBackground);
  box-shadow: inset 2px 0 0 0 var(--vscode-focusBorder);
}
.status {
  width: 12px;
  text-align: center;
  font-weight: 700;
  flex: 0 0 auto;
  font-size: 11px;
}
.status.M, .status.R, .status.C, .status.T { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
.status.A { color: var(--vscode-gitDecoration-addedResourceForeground); }
.status.D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
.status.U { color: var(--vscode-gitDecoration-conflictingResourceForeground); }
.status.Q { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
.name { overflow: hidden; text-overflow: ellipsis; }
.dir { opacity: 0.55; font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
/* Tree layout: every row is a flat <li> indented by its depth (the way the
   Explorer renders), so the list keeps one DOM level and the arrow-key
   navigation keeps working on siblings. The twistie is a CSS chevron — the
   codicon font isn't available inside the webview. File rows carry an empty
   twistie so their names line up with folder names at the same depth. */
.twistie {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.twistie::before {
  content: '';
  width: 5px;
  height: 5px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: translateX(-1px) rotate(-45deg);
  opacity: 0.8;
}
.twistie.expanded::before { transform: translateY(-1px) rotate(45deg); }
.twistie.leaf::before { content: none; }
.dir-row .name { opacity: 0.9; }
.revert-btn {
  appearance: none;
  background: transparent;
  color: inherit;
  border: 0;
  cursor: pointer;
  flex: 0 0 auto;
  margin-left: auto;
  padding: 0 4px;
  border-radius: 3px;
  font: inherit;
  line-height: 1;
  /* Hidden until the row is hovered/focused, matching VSCode SCM inline
     actions — revert is destructive, so it shouldn't invite a stray click. */
  opacity: 0;
}
.revert-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
#files-list li:hover .revert-btn,
#files-list li:focus .revert-btn,
#files-list li:focus-within .revert-btn,
.revert-btn:focus { opacity: 0.9; }
.empty, .loading {
  padding: 8px 4px;
  opacity: 0.6;
  font-style: italic;
}
.search-error {
  padding: 4px 2px;
  color: var(--vscode-errorForeground);
  font-size: 11px;
}
.no-target {
  padding: 8px 2px;
  opacity: 0.85;
}
</style>
</head>
<body>
<div class="row">
  <div class="input-wrap">
    <input id="search" type="text" placeholder="Search" aria-label="Search" />
    <div class="toggles" role="group" aria-label="Search options">
      <button class="toggle" id="mc" type="button" title="Match Case" aria-label="Match Case" aria-pressed="false">Aa</button>
      <button class="toggle" id="mw" type="button" title="Match Whole Word" aria-label="Match Whole Word" aria-pressed="false">ab</button>
      <button class="toggle" id="re" type="button" title="Use Regular Expression" aria-label="Use Regular Expression" aria-pressed="false">.*</button>
    </div>
  </div>
</div>
<div class="row">
  <div class="input-wrap">
    <input id="include" type="text" placeholder="files to include" aria-label="files to include" />
  </div>
</div>
<div class="row">
  <div class="input-wrap">
    <input id="exclude" type="text" placeholder="files to exclude" aria-label="files to exclude" />
  </div>
</div>
<div id="target-bar" class="target-bar"></div>
<div id="search-error" class="search-error" style="display:none"></div>
<div id="no-target" class="no-target" style="display:none">
  <div>No comparison target selected.</div>
  <button class="set-target-btn" id="set-target" type="button">Set target…</button>
</div>
<div id="loading" class="loading" style="display:none">Loading…</div>
<ul id="files-list"></ul>
<div id="empty" class="empty" style="display:none">No matching files.</div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const persisted = vscode.getState() || {};
  // relPath of the file whose diff is the active editor, or null. Tracked
  // separately from the file list so it re-applies across list rebuilds.
  let activeRelPath = null;
  // relPath we've already scrolled into view, so a re-render for an unrelated
  // reason (filter edit) doesn't yank the viewport back to the active row.
  let scrolledRelPath = null;
  // 'tree' | 'list'. Seeded from the webview's own persisted state so a
  // re-show before init lands doesn't flash the other layout; the
  // extension's init / viewMode messages are authoritative.
  let viewMode = persisted.viewMode === 'list' ? 'list' : 'tree';
  // Folder rows the user collapsed, keyed by the path the row represents (a
  // compacted a/b/c row is keyed by its full path). Kept across list
  // rebuilds and, via setState, across hide/show.
  const collapsed = new Set(Array.isArray(persisted.collapsed) ? persisted.collapsed : []);
  // Last files payload, so a layout change or a collapse toggle can
  // re-render without a round-trip to the extension.
  let lastPayload = null;
  // Extra left padding per tree level, on top of the 16px twistie.
  const INDENT = 10;

  function saveState() {
    vscode.setState({ filter: readFilter(), viewMode: viewMode, collapsed: [...collapsed] });
  }

  function readFilter() {
    return {
      search: $('search').value,
      include: $('include').value,
      exclude: $('exclude').value,
      matchCase: $('mc').classList.contains('active'),
      matchWholeWord: $('mw').classList.contains('active'),
      useRegex: $('re').classList.contains('active'),
    };
  }
  function writeFilter(f) {
    $('search').value = f.search || '';
    $('include').value = f.include || '';
    $('exclude').value = f.exclude || '';
    setToggle('mc', !!f.matchCase);
    setToggle('mw', !!f.matchWholeWord);
    setToggle('re', !!f.useRegex);
  }
  function setToggle(id, on) {
    const b = $(id);
    b.classList.toggle('active', !!on);
    b.setAttribute('aria-pressed', String(!!on));
  }

  if (persisted.filter) writeFilter(persisted.filter);

  let debounceTimer = null;
  function fireFilter(immediate) {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    const send = () => {
      saveState();
      vscode.postMessage({ type: 'setFilter', filter: readFilter() });
    };
    if (immediate) send();
    else debounceTimer = setTimeout(send, 200);
  }

  ['search', 'include', 'exclude'].forEach((id) => {
    $(id).addEventListener('input', () => fireFilter(false));
    $(id).addEventListener('change', () => fireFilter(true));
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        fireFilter(true);
      }
    });
  });
  ['mc', 'mw', 're'].forEach((id) => {
    $(id).addEventListener('click', () => {
      const on = !$(id).classList.contains('active');
      setToggle(id, on);
      fireFilter(true);
    });
  });
  $('set-target').addEventListener('click', () => {
    vscode.postMessage({ type: 'setTarget' });
  });

  // Event-delegate: one listener on the list, reading data-rel off the
  // clicked row. Avoids attaching/detaching N listeners on every render.
  function activateRow(li) {
    vscode.postMessage({ type: 'openFile', relPath: li.getAttribute('data-rel') });
  }
  function revertRow(li) {
    vscode.postMessage({ type: 'revertFile', relPath: li.getAttribute('data-rel') });
  }
  // Both row kinds: file rows carry data-rel, folder rows data-dir.
  const ROW_SEL = 'li[data-rel], li[data-dir]';
  function isRow(el) {
    return !!el && (el.hasAttribute('data-rel') || el.hasAttribute('data-dir'));
  }
  function isDirRow(li) { return li.hasAttribute('data-dir'); }
  // The directories a folder row stands for (several for a compact a/b/c row).
  function chainOf(li) {
    try {
      const c = JSON.parse(li.getAttribute('data-chain') || '');
      if (Array.isArray(c) && c.length) return c;
    } catch {}
    return [li.getAttribute('data-dir')];
  }
  function isExpanded(li) { return !chainOf(li).some((p) => collapsed.has(p)); }
  function rerender() { if (lastPayload) render(lastPayload); }
  function toggleDir(li) {
    const p = li.getAttribute('data-dir');
    if (isExpanded(li)) {
      collapsed.add(p);
    } else {
      // Expanding must clear every collapsed entry the row represents, or an
      // outer directory's entry would keep the compact row shut.
      for (const c of chainOf(li)) collapsed.delete(c);
    }
    saveState();
    rerender();
    // The rebuild replaced the row that had focus — put it back on the same folder.
    const rows = $('files-list').children;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-dir') === p) {
        rows[i].focus();
        break;
      }
    }
  }
  // Nearest folder row above li that is shallower than it — its parent in
  // the tree, since rows are emitted depth-first.
  function parentDirRow(li) {
    const depth = Number(li.getAttribute('data-depth') || 0);
    let sib = li.previousElementSibling;
    while (sib) {
      if (sib.hasAttribute('data-dir') && Number(sib.getAttribute('data-depth')) < depth) return sib;
      sib = sib.previousElementSibling;
    }
    return null;
  }
  $('files-list').addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    // Revert button takes precedence — it sits inside the row, so without
    // this guard the click would bubble up and open the diff instead.
    const rb = target.closest('.revert-btn');
    if (rb) {
      const rli = rb.closest('li[data-rel]');
      if (rli) revertRow(rli);
      return;
    }
    const li = target.closest(ROW_SEL);
    if (!li) return;
    if (isDirRow(li)) toggleDir(li);
    else activateRow(li);
  });
  // Keyboard: Enter/Space opens a file's diff or toggles a folder, matching
  // VSCode tree semantics. ArrowUp/ArrowDown walk the rows; ArrowLeft
  // collapses a folder or jumps to the parent folder; ArrowRight expands a
  // folder or steps into its first child.
  $('files-list').addEventListener('keydown', (event) => {
    const target = event.target;
    // Keys pressed while the revert button is focused are its own concern:
    // Enter/Space fire a native click (handled above), and we don't want
    // arrow-nav or row activation to steal them.
    if (target && target.closest && target.closest('.revert-btn')) return;
    const li = target && target.closest ? target.closest(ROW_SEL) : null;
    if (!li) return;
    const dir = isDirRow(li);
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (dir) toggleDir(li);
      else activateRow(li);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const sib = event.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling;
      if (isRow(sib)) sib.focus();
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (dir && isExpanded(li)) {
        toggleDir(li);
      } else {
        const parent = parentDirRow(li);
        if (parent) parent.focus();
      }
      return;
    }
    if (event.key === 'ArrowRight' && dir) {
      event.preventDefault();
      if (!isExpanded(li)) {
        toggleDir(li);
      } else {
        const sib = li.nextElementSibling;
        if (isRow(sib)) sib.focus();
      }
    }
  });

  function statusClass(s) { return s === '?' ? 'Q' : s; }
  function basename(p) {
    const i = p.lastIndexOf('/');
    return i === -1 ? p : p.slice(i + 1);
  }
  function dirname(p) {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
  }

  // Toggle the .active-file class on the row matching activeRelPath, and
  // scroll that row into view once per active file — when it first becomes
  // active OR when its row first appears in a later render (e.g. the active
  // diff was known before the list finished loading). scrolledRelPath guards
  // against re-scrolling on unrelated re-renders such as filter edits.
  //
  // In tree mode a newly active file hiding inside a collapsed folder is
  // revealed first — its ancestors are expanded and the list rebuilt — the
  // way the Explorer reveals the active editor's file.
  function applyActiveHighlight() {
    const rows = $('files-list').children;
    let matched = null;
    for (let i = 0; i < rows.length; i++) {
      const li = rows[i];
      const on = activeRelPath != null && li.getAttribute('data-rel') === activeRelPath;
      li.classList.toggle('active-file', on);
      if (on) matched = li;
    }
    if (!matched && activeRelPath != null && scrolledRelPath !== activeRelPath && revealAncestors(activeRelPath)) {
      rerender(); // re-enters applyActiveHighlight with the row now present
      return;
    }
    if (matched && scrolledRelPath !== activeRelPath) {
      matched.scrollIntoView({ block: 'nearest' });
      scrolledRelPath = activeRelPath;
    } else if (activeRelPath == null) {
      scrolledRelPath = null;
    }
  }
  // Expand every collapsed folder above relPath. Returns true when
  // something changed. Only acts when the file is actually in the current
  // list — a filtered-out file has no row to reveal, and expanding for it
  // would just undo the user's collapses.
  function revealAncestors(relPath) {
    if (viewMode !== 'tree' || !lastPayload || collapsed.size === 0) return false;
    const files = lastPayload.files || [];
    if (!files.some((f) => f.relPath === relPath)) return false;
    let changed = false;
    for (const p of [...collapsed]) {
      if (relPath.startsWith(p + '/')) {
        collapsed.delete(p);
        changed = true;
      }
    }
    if (changed) saveState();
    return changed;
  }

  function render(payload) {
    lastPayload = payload;
    const hasTarget = !!payload.hasTarget;
    const loading = !!payload.loading;
    const files = payload.files || [];

    // Built from text nodes rather than innerHTML: repo paths are arbitrary
    // filesystem strings and must never be parsed as markup.
    const bar = $('target-bar');
    bar.textContent = hasTarget && payload.targetLabel
      ? 'Comparing vs ' + payload.targetLabel
      : '';
    if (hasTarget && payload.targetLabel && payload.repoLabel) {
      const repo = document.createElement('span');
      repo.className = 'target-repo';
      repo.textContent = ' in ' + payload.repoLabel;
      repo.title = payload.repoPath || payload.repoLabel;
      bar.appendChild(repo);
    }
    bar.style.display = hasTarget && payload.targetLabel ? '' : 'none';
    $('no-target').style.display = hasTarget ? 'none' : '';
    $('loading').style.display = loading ? '' : 'none';
    $('search-error').style.display = payload.searchError ? '' : 'none';
    $('search-error').textContent = payload.searchError
      ? 'Search: ' + payload.searchError
      : '';

    const list = $('files-list');
    list.innerHTML = '';
    if (!hasTarget || loading) {
      $('empty').style.display = 'none';
      return;
    }
    if (files.length === 0) {
      $('empty').style.display = '';
      return;
    }
    $('empty').style.display = 'none';

    const frag = document.createDocumentFragment();
    if (viewMode === 'tree') {
      appendTreeRows(frag, buildTree(files), 0, payload);
    } else {
      for (const f of files) frag.appendChild(makeFileRow(f, payload, -1));
    }
    list.appendChild(frag);
    applyActiveHighlight();
  }

  // Nest the flat list under its directories. Each node: { name, path,
  // dirs: Map<name, node>, files: [] }. Paths are git's forward-slash relPaths
  // regardless of platform.
  function buildTree(files) {
    const root = { name: '', path: '', dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.relPath.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        let child = node.dirs.get(parts[i]);
        if (!child) {
          child = {
            name: parts[i],
            path: node.path ? node.path + '/' + parts[i] : parts[i],
            dirs: new Map(),
            files: [],
          };
          node.dirs.set(parts[i], child);
        }
        node = child;
      }
      node.files.push(f);
    }
    return root;
  }
  // The Explorer's ordering: case-insensitive, digit runs compared numerically.
  function compareNames(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }
  // Emit rows depth-first — folders before files at every level, each
  // alphabetical. A folder whose only content is a single sub-folder is
  // compacted with it into one a/b/c row (the Explorer's compactFolders);
  // the row is keyed by the innermost path so collapsing it hides exactly
  // that subtree. A collapsed folder's descendants are simply not emitted.
  function appendTreeRows(frag, node, depth, payload) {
    const dirs = [...node.dirs.values()].sort((a, b) => compareNames(a.name, b.name));
    for (let d of dirs) {
      let label = d.name;
      // Every directory the row stands for. A filter or refresh can merge a
      // folder the user collapsed on its own into a compact chain, so the
      // row is collapsed if ANY of them is — not just the innermost.
      const chain = [d.path];
      while (d.dirs.size === 1 && d.files.length === 0) {
        d = d.dirs.values().next().value;
        label += '/' + d.name;
        chain.push(d.path);
      }
      const expanded = !chain.some((p) => collapsed.has(p));
      frag.appendChild(makeDirRow(d.path, label, depth, expanded, chain));
      if (expanded) appendTreeRows(frag, d, depth + 1, payload);
    }
    const files = node.files
      .slice()
      .sort((a, b) => compareNames(basename(a.relPath), basename(b.relPath)));
    for (const f of files) frag.appendChild(makeFileRow(f, payload, depth));
  }
  function indentRow(li, depth) {
    li.setAttribute('data-depth', String(depth));
    li.style.paddingLeft = 4 + depth * INDENT + 'px';
  }
  function makeDirRow(dirPath, label, depth, expanded, chain) {
    const li = document.createElement('li');
    li.className = 'dir-row';
    li.title = dirPath;
    li.setAttribute('data-dir', dirPath);
    li.setAttribute('data-chain', JSON.stringify(chain));
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.setAttribute('aria-expanded', String(expanded));
    li.setAttribute('aria-label', (expanded ? 'Collapse folder: ' : 'Expand folder: ') + dirPath);
    indentRow(li, depth);
    const tw = document.createElement('span');
    tw.className = 'twistie' + (expanded ? ' expanded' : '');
    const nm = document.createElement('span');
    nm.className = 'name';
    nm.textContent = label;
    li.appendChild(tw);
    li.appendChild(nm);
    return li;
  }
  // depth >= 0: a tree row (indented, twistie spacer, no dir suffix).
  // depth -1: a flat-list row with the dimmed directory after the name.
  function makeFileRow(f, payload, depth) {
    const li = document.createElement('li');
    li.title = f.relPath;
    li.setAttribute('data-rel', f.relPath);
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.setAttribute('aria-label', 'Open diff: ' + f.relPath);
    if (depth >= 0) {
      indentRow(li, depth);
      const tw = document.createElement('span');
      tw.className = 'twistie leaf';
      li.appendChild(tw);
    }
    const s = document.createElement('span');
    s.className = 'status ' + statusClass(f.status);
    s.textContent = f.status;
    const nm = document.createElement('span');
    nm.className = 'name';
    nm.textContent = basename(f.relPath);
    const rb = document.createElement('button');
    rb.className = 'revert-btn';
    rb.type = 'button';
    const revertLabel = payload.targetLabel
      ? 'Revert to ' + payload.targetLabel
      : 'Revert to target';
    rb.title = revertLabel;
    rb.setAttribute('aria-label', revertLabel + ': ' + f.relPath);
    rb.textContent = '↺';
    li.appendChild(s);
    li.appendChild(nm);
    if (depth < 0) {
      const dr = document.createElement('span');
      dr.className = 'dir';
      dr.textContent = dirname(f.relPath);
      if (dr.textContent) li.appendChild(dr);
    }
    li.appendChild(rb);
    return li;
  }

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') {
      if (m.filter) writeFilter(m.filter);
      if (m.viewMode === 'tree' || m.viewMode === 'list') viewMode = m.viewMode;
      saveState();
    } else if (m.type === 'viewMode') {
      if (m.viewMode !== 'tree' && m.viewMode !== 'list') return;
      viewMode = m.viewMode;
      saveState();
      rerender();
    } else if (m.type === 'files') {
      activeRelPath = m.activeRelPath != null ? m.activeRelPath : null;
      render(m);
    } else if (m.type === 'activeFile') {
      activeRelPath = m.relPath != null ? m.relPath : null;
      applyActiveHighlight();
    }
  });

  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
}
