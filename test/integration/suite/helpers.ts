import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
}

export function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdiff-int-'));
  try {
    git(root, ['init', '-b', 'main', '-q']);
  } catch {
    git(root, ['init', '-q']);
    git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  // Deterministic rename detection across hosts/CI (production uses the git
  // default; see GitService.listChangedPaths for why we don't force `-M`).
  git(root, ['config', 'diff.renames', 'true']);
  return root;
}

export function commit(root: string, message: string): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message, '-q', '--allow-empty']);
  return git(root, ['rev-parse', '--short', 'HEAD']).trim();
}

export function realRepoPath(p: string): string {
  // .native to match production, which derives repoRoot from git's
  // `--show-toplevel` (long-name, normalized drive case). Plain realpathSync
  // leaves Windows 8.3 short names (RUNNER~1) in place, so it wouldn't match.
  return fs.realpathSync.native(p);
}

/**
 * Replace `vscode.window.showQuickPick` for the duration of `fn`. The fake
 * receives the resolved items and returns the first one matching `predicate`.
 */
export async function withQuickPickPicking(
  predicate: (item: any) => boolean,
  fn: () => Thenable<unknown> | Promise<unknown>,
): Promise<void> {
  const restore = stubQuickPick(predicate);
  try {
    await fn();
  } finally {
    restore();
  }
}

/**
 * Stubs both `showQuickPick` (the simple API) and `createQuickPick` (used by
 * the commit picker) so the test can pick a row by predicate without the
 * UI ever rendering. For `createQuickPick`, we drive the lifecycle: `show`
 * triggers a microtask that picks the first item matching `predicate` from
 * the current `items` and calls every `onDidAccept` listener with it active.
 */
function stubQuickPick(predicate: (item: any) => boolean): () => void {
  const win = vscode.window as any;
  const origShow = win.showQuickPick;
  const origCreate = win.createQuickPick;
  let typed = '';

  win.showQuickPick = async (items: any) => {
    const resolved = await items;
    return (resolved as any[]).find(predicate);
  };

  win.createQuickPick = () => {
    let items: any[] = [];
    const onAcceptListeners: Array<() => void> = [];
    const onChangeValueListeners: Array<(v: string) => void> = [];
    const onHideListeners: Array<() => void> = [];
    const qp: any = {
      title: '',
      placeholder: '',
      busy: false,
      matchOnDescription: false,
      matchOnDetail: false,
      activeItems: [],
      get items() {
        return items;
      },
      set items(next: any[]) {
        items = next;
        // After items change, re-run the predicate to update activeItems.
        const match = items.find(predicate);
        qp.activeItems = match ? [match] : [];
      },
      get value() {
        return typed;
      },
      set value(v: string) {
        typed = v;
        for (const l of onChangeValueListeners) l(v);
      },
      onDidChangeValue: (cb: (v: string) => void) => {
        onChangeValueListeners.push(cb);
        return { dispose() {} };
      },
      onDidAccept: (cb: () => void) => {
        onAcceptListeners.push(cb);
        return { dispose() {} };
      },
      onDidHide: (cb: () => void) => {
        onHideListeners.push(cb);
        return { dispose() {} };
      },
      show: () => {
        // Wait a turn for the producer to call refreshCommits + rebuildItems,
        // then drive accept on the matching item.
        void Promise.resolve().then(async () => {
          for (let attempt = 0; attempt < 50; attempt++) {
            const match = items.find(predicate);
            if (match) {
              qp.activeItems = [match];
              for (const l of onAcceptListeners) l();
              return;
            }
            await new Promise((r) => setTimeout(r, 20));
          }
          // Give up; fire hide to resolve with undefined.
          for (const l of onHideListeners) l();
        });
      },
      hide: () => {
        for (const l of onHideListeners) l();
      },
      dispose: () => {},
    };
    return qp;
  };

  return () => {
    win.showQuickPick = origShow;
    win.createQuickPick = origCreate;
    typed = '';
  };
}

/** Stub for typing into a createQuickPick before accepting. Use after the
 * picker has shown — sets `value`, fires onDidChangeValue, then accepts the
 * first item matching `accept`. */
export async function withTypedQuickPick(
  typedValue: string,
  accept: (item: any) => boolean,
  fn: () => Thenable<unknown> | Promise<unknown>,
): Promise<void> {
  const win = vscode.window as any;
  const origShow = win.showQuickPick;
  const origCreate = win.createQuickPick;

  win.showQuickPick = async (items: any) => {
    // For nested showQuickPick calls (e.g. pickAny chooser), pick the
    // "Commit…" item.
    const resolved = await items;
    return (resolved as any[]).find(
      (i) => typeof i.label === 'string' && i.label.includes('Commit'),
    );
  };

  win.createQuickPick = () => {
    let items: any[] = [];
    let typed = '';
    const onAcceptListeners: Array<() => void> = [];
    const onChangeValueListeners: Array<(v: string) => void> = [];
    const onHideListeners: Array<() => void> = [];
    const qp: any = {
      title: '',
      placeholder: '',
      busy: false,
      matchOnDescription: false,
      matchOnDetail: false,
      activeItems: [],
      get items() {
        return items;
      },
      set items(next: any[]) {
        items = next;
      },
      get value() {
        return typed;
      },
      set value(v: string) {
        typed = v;
      },
      onDidChangeValue: (cb: (v: string) => void) => {
        onChangeValueListeners.push(cb);
        return { dispose() {} };
      },
      onDidAccept: (cb: () => void) => {
        onAcceptListeners.push(cb);
        return { dispose() {} };
      },
      onDidHide: (cb: () => void) => {
        onHideListeners.push(cb);
        return { dispose() {} };
      },
      show: () => {
        void Promise.resolve().then(async () => {
          // Wait for initial item population.
          for (let attempt = 0; attempt < 50; attempt++) {
            if (items.length > 0) break;
            await new Promise((r) => setTimeout(r, 20));
          }
          // Type the value (fires rebuildItems via onDidChangeValue).
          typed = typedValue;
          for (const l of onChangeValueListeners) l(typedValue);
          await new Promise((r) => setTimeout(r, 20));
          // Find the row to accept.
          const match = items.find(accept);
          if (match) {
            qp.activeItems = [match];
            for (const l of onAcceptListeners) l();
          } else {
            for (const l of onHideListeners) l();
          }
        });
      },
      hide: () => {
        for (const l of onHideListeners) l();
      },
      dispose: () => {},
    };
    return qp;
  };

  try {
    await fn();
  } finally {
    win.showQuickPick = origShow;
    win.createQuickPick = origCreate;
  }
}

/**
 * Like `withQuickPickPicking`, but uses each predicate in `predicates` for
 * one successive picker call. The first predicate handles `showQuickPick`
 * (e.g. the pickAny chooser), and subsequent ones handle `createQuickPick`-
 * driven pickers (the commit picker).
 */
export async function withQuickPickQueue(
  predicates: Array<(item: any) => boolean>,
  fn: () => Thenable<unknown> | Promise<unknown>,
): Promise<void> {
  const win = vscode.window as any;
  const origShow = win.showQuickPick;
  const origCreate = win.createQuickPick;
  let i = 0;
  const next = () => predicates[i++] ?? (() => undefined);

  win.showQuickPick = async (items: any) => {
    const resolved = await items;
    return (resolved as any[]).find(next());
  };

  win.createQuickPick = () => {
    let items: any[] = [];
    const predicate = next();
    const onAcceptListeners: Array<() => void> = [];
    const onChangeValueListeners: Array<(v: string) => void> = [];
    const onHideListeners: Array<() => void> = [];
    let typed = '';
    const qp: any = {
      title: '',
      placeholder: '',
      busy: false,
      matchOnDescription: false,
      matchOnDetail: false,
      activeItems: [],
      get items() {
        return items;
      },
      set items(next2: any[]) {
        items = next2;
      },
      get value() {
        return typed;
      },
      set value(v: string) {
        typed = v;
      },
      onDidChangeValue: (cb: (v: string) => void) => {
        onChangeValueListeners.push(cb);
        return { dispose() {} };
      },
      onDidAccept: (cb: () => void) => {
        onAcceptListeners.push(cb);
        return { dispose() {} };
      },
      onDidHide: (cb: () => void) => {
        onHideListeners.push(cb);
        return { dispose() {} };
      },
      show: () => {
        void Promise.resolve().then(async () => {
          for (let attempt = 0; attempt < 50; attempt++) {
            const match = items.find(predicate);
            if (match) {
              qp.activeItems = [match];
              for (const l of onAcceptListeners) l();
              return;
            }
            await new Promise((r) => setTimeout(r, 20));
          }
          for (const l of onHideListeners) l();
        });
      },
      hide: () => {
        for (const l of onHideListeners) l();
      },
      dispose: () => {},
    };
    return qp;
  };

  try {
    await fn();
  } finally {
    win.showQuickPick = origShow;
    win.createQuickPick = origCreate;
  }
}

/**
 * Replace `showInputBox` for the duration of `fn`. Returns `value` from the box.
 */
export async function withInputBoxReturning(
  value: string | undefined,
  fn: () => Thenable<unknown> | Promise<unknown>,
): Promise<void> {
  const original = vscode.window.showInputBox;
  (vscode.window as any).showInputBox = async () => value;
  try {
    await fn();
  } finally {
    (vscode.window as any).showInputBox = original;
  }
}

/**
 * Replace one of `showWarningMessage` / `showInformationMessage` /
 * `showErrorMessage` and capture the messages it was called with.
 * Returns a disposer that restores the original and exposes captured calls.
 */
export interface MessageCapture {
  warnings: string[];
  infos: string[];
  errors: string[];
  restore(): void;
}
export function captureMessages(): MessageCapture {
  const cap: MessageCapture = {
    warnings: [],
    infos: [],
    errors: [],
    restore: () => {},
  };
  const origW = vscode.window.showWarningMessage;
  const origI = vscode.window.showInformationMessage;
  const origE = vscode.window.showErrorMessage;
  (vscode.window as any).showWarningMessage = (msg: string) => {
    cap.warnings.push(msg);
    return Promise.resolve(undefined);
  };
  (vscode.window as any).showInformationMessage = (msg: string) => {
    cap.infos.push(msg);
    return Promise.resolve(undefined);
  };
  (vscode.window as any).showErrorMessage = (msg: string) => {
    cap.errors.push(msg);
    return Promise.resolve(undefined);
  };
  cap.restore = () => {
    (vscode.window as any).showWarningMessage = origW;
    (vscode.window as any).showInformationMessage = origI;
    (vscode.window as any).showErrorMessage = origE;
  };
  return cap;
}

/**
 * Replace `showWarningMessage` for the duration of `fn` so a modal
 * confirmation resolves to `response` (the label the user "clicked", or
 * `undefined` to simulate dismissing the dialog). Records every prompt shown.
 * Returns the captured prompt strings after `fn` settles.
 */
export async function withWarningResponse(
  response: string | undefined,
  fn: () => Thenable<unknown> | Promise<unknown>,
): Promise<string[]> {
  const prompts: string[] = [];
  const orig = vscode.window.showWarningMessage;
  (vscode.window as any).showWarningMessage = (msg: string) => {
    prompts.push(msg);
    return Promise.resolve(response);
  };
  try {
    await fn();
  } finally {
    (vscode.window as any).showWarningMessage = orig;
  }
  return prompts;
}

/** Close every editor and every tab in every group. */
export async function closeAllTabs(): Promise<void> {
  const tabs: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) tabs.push(tab);
  }
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs, true);
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

export async function settle(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
