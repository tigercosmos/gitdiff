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
}

export interface FilterState {
  search: string;
  include: string;
  exclude: string;
  matchCase: boolean;
  matchWholeWord: boolean;
  useRegex: boolean;
}

const STATE_KEY = 'gitdiff.changedFiles.target';
const FILTER_KEY = 'gitdiff.changedFiles.filter';
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
}

interface InitMessage {
  type: 'init';
  filter: FilterState;
}

type OutgoingMessage = FilesMessage | InitMessage;

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

  private target: PersistedTarget | undefined;
  private filter: FilterState;
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
  }

  dispose(): void {
    for (const d of this.viewSubs.splice(0)) d.dispose();
    this._onDidChangeTarget.dispose();
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
    await this.refresh();
  }

  async clearTarget(): Promise<void> {
    this.invalidate();
    this.target = undefined;
    await this.workspaceState.update(STATE_KEY, undefined);
    this._onDidChangeTarget.fire();
    this.files = [];
    this.post({
      type: 'files',
      files: [],
      hasTarget: false,
      targetLabel: '',
    });
  }

  async refresh(): Promise<void> {
    const token = this.invalidate();
    if (!this.target) {
      this.files = [];
      this.post({ type: 'files', files: [], hasTarget: false, targetLabel: '' });
      return;
    }
    const { ref, repoRoot, display } = this.target;
    this.post({
      type: 'files',
      files: [],
      hasTarget: true,
      targetLabel: display,
      loading: true,
    });
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
        this.post({ type: 'init', filter: this.filter });
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
    void this.view.webview.postMessage(msg);
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

function renderHtml(webview: vscode.Webview): string {
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
      const f = readFilter();
      vscode.setState({ filter: f });
      vscode.postMessage({ type: 'setFilter', filter: f });
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
  $('files-list').addEventListener('click', (event) => {
    const target = event.target;
    const li = target && target.closest ? target.closest('li[data-rel]') : null;
    if (!li) return;
    activateRow(li);
  });
  // Keyboard activation: Enter or Space on a focused row opens the diff,
  // matching VSCode list semantics. ArrowUp/ArrowDown move focus between
  // rows so a screen-reader / keyboard user can walk the list.
  $('files-list').addEventListener('keydown', (event) => {
    const target = event.target;
    const li = target && target.closest ? target.closest('li[data-rel]') : null;
    if (!li) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateRow(li);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const sib = event.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling;
      if (sib && sib.hasAttribute('data-rel')) sib.focus();
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

  function render(payload) {
    const hasTarget = !!payload.hasTarget;
    const loading = !!payload.loading;
    const files = payload.files || [];

    $('target-bar').textContent = hasTarget && payload.targetLabel
      ? 'Comparing vs ' + payload.targetLabel
      : '';
    $('target-bar').style.display = hasTarget && payload.targetLabel ? '' : 'none';
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
    for (const f of files) {
      const li = document.createElement('li');
      li.title = f.relPath;
      li.setAttribute('data-rel', f.relPath);
      li.setAttribute('role', 'button');
      li.setAttribute('tabindex', '0');
      li.setAttribute('aria-label', 'Open diff: ' + f.relPath);
      const s = document.createElement('span');
      s.className = 'status ' + statusClass(f.status);
      s.textContent = f.status;
      const nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = basename(f.relPath);
      const dr = document.createElement('span');
      dr.className = 'dir';
      dr.textContent = dirname(f.relPath);
      li.appendChild(s);
      li.appendChild(nm);
      if (dr.textContent) li.appendChild(dr);
      frag.appendChild(li);
    }
    list.appendChild(frag);
  }

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') {
      if (m.filter) {
        writeFilter(m.filter);
        vscode.setState({ filter: m.filter });
      }
    } else if (m.type === 'files') {
      render(m);
    }
  });

  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
}
