import * as vscode from 'vscode';
import { GitService, BranchInfo, CommitInfo } from './gitService';

interface BranchPickItem extends vscode.QuickPickItem {
  ref?: string;
}

interface CommitPickItem extends vscode.QuickPickItem {
  /** Full 40-char SHA — sent to verifyRef and stored in the URI. */
  ref?: string;
  /** Short SHA — used for the diff tab title. */
  shortSha?: string;
  /** Sentinel actions when ref is undefined. */
  action?: 'enter-sha' | 'load-more' | 'use-typed';
  /** Raw user-typed value, for action='use-typed'. */
  typed?: string;
}

export interface PickedRef {
  /** Full 40-char SHA, post-verifyRef. The provider reads from this. */
  ref: string;
  /** Short label for the tab title — branch name, short SHA, etc. */
  display: string;
  /** Original branch name if the user picked from the branch list. */
  branch?: string;
}

export class RefPicker {
  constructor(private readonly git: GitService) {}

  async pickBranch(fileUri: vscode.Uri): Promise<PickedRef | undefined> {
    let repoRoot: string;
    try {
      repoRoot = await this.git.repoRoot(fileUri.fsPath);
    } catch {
      void vscode.window.showErrorMessage('GitDiff: Not a git repository.');
      return undefined;
    }
    const [local, remote] = await Promise.all([
      this.git.listBranchesLocal(repoRoot),
      this.git.listBranchesRemote(repoRoot),
    ]);
    if (local.length === 0 && remote.length === 0) {
      void vscode.window.showInformationMessage(
        'No branches found. Try Compare with Commit instead.',
      );
      return undefined;
    }
    const items = buildBranchItems(local, remote);
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Compare with Branch',
      placeHolder: 'Pick a branch to diff the working-tree file against',
      matchOnDescription: true,
    });
    if (!picked?.ref) return undefined;
    try {
      const sha = await this.git.verifyRef(repoRoot, picked.ref);
      return { ref: sha, display: picked.ref, branch: picked.ref };
    } catch (err) {
      void vscode.window.showErrorMessage(
        err instanceof Error ? err.message : `GitDiff: cannot resolve ${picked.ref}`,
      );
      return undefined;
    }
  }

  async pickCommit(fileUri: vscode.Uri): Promise<PickedRef | undefined> {
    let repoRoot: string;
    try {
      repoRoot = await this.git.repoRoot(fileUri.fsPath);
    } catch {
      void vscode.window.showErrorMessage('GitDiff: Not a git repository.');
      return undefined;
    }
    const relPath = this.git.relPath(repoRoot, fileUri.fsPath);
    const initialLimit =
      vscode.workspace.getConfiguration('gitdiff').get<number>('commitPickerLimit') ?? 100;

    return runCommitQuickPick(this.git, repoRoot, relPath, initialLimit);
  }

  /**
   * Picker for the "Change Target" / "Set Comparison Target" commands.
   * Offers the Branch…/Commit… sub-pickers, but also lets the user just type
   * a revision — branch, tag, SHA, `HEAD~2`, anything `git rev-parse`
   * understands — and accept it directly without choosing a category first.
   */
  async pickAny(fileUri: vscode.Uri): Promise<PickedRef | undefined> {
    const selection = await runTargetChooser();
    if (!selection) return undefined;
    if (selection.choice === 'branch') return this.pickBranch(fileUri);
    if (selection.choice === 'commit') return this.pickCommit(fileUri);
    if (selection.typed) return this.resolveTypedTarget(fileUri, selection.typed);
    return undefined;
  }

  /**
   * Resolve free-typed text to a comparison target. Verification is the same
   * `rev-parse --verify <text>^{commit}` used everywhere else, so it accepts
   * whatever git does. If the text names an existing branch (local or
   * remote-tracking) the result carries `branch:` so refresh keeps tracking
   * the tip; tags, SHAs, and relative revisions stay pinned.
   */
  private async resolveTypedTarget(
    fileUri: vscode.Uri,
    typed: string,
  ): Promise<PickedRef | undefined> {
    let repoRoot: string;
    try {
      repoRoot = await this.git.repoRoot(fileUri.fsPath);
    } catch {
      void vscode.window.showErrorMessage('GitDiff: Not a git repository.');
      return undefined;
    }
    let full: string;
    try {
      full = await this.git.verifyRef(repoRoot, typed);
    } catch (err) {
      void vscode.window.showErrorMessage(
        err instanceof Error ? err.message : `GitDiff: invalid revision '${typed}'`,
      );
      return undefined;
    }
    const isBranch = await this.git.isBranch(repoRoot, typed).catch(() => false);
    if (isBranch) {
      return { ref: full, display: typed, branch: typed };
    }
    // A SHA prefix reads better shortened from the *full* SHA; any other
    // revision (tag, HEAD~2, …) is most recognizable as what the user typed.
    const display =
      SHA_PREFIX_RE.test(typed) && full.toLowerCase().startsWith(typed.toLowerCase())
        ? shortenSha(full)
        : typed;
    return { ref: full, display };
  }
}

export interface TargetChoiceItem extends vscode.QuickPickItem {
  /** Set for the fixed Branch…/Commit… rows. */
  choice?: 'branch' | 'commit';
  /** Set for the synthesized "compare with what you typed" row. */
  typed?: string;
}

/**
 * Items for the target chooser. Pure — exported for unit tests. When the user
 * has typed something, a "Compare with <typed>" row is synthesized at the top
 * (leading-`-` input is excluded up front: it could be misparsed as an option
 * by downstream git calls, and verifyRef would reject it anyway).
 */
export function buildTargetChoiceItems(typedRaw: string): TargetChoiceItem[] {
  const items: TargetChoiceItem[] = [];
  const typed = typedRaw.trim();
  if (typed && !typed.startsWith('-')) {
    items.push({
      label: `$(arrow-right) Compare with '${typed}'`,
      description: 'branch, tag, or commit — verify and use',
      typed,
      alwaysShow: true,
    });
  }
  items.push(
    {
      label: '$(git-branch) Branch…',
      description: 'pick from the branch list',
      choice: 'branch',
      alwaysShow: true,
    },
    {
      label: '$(git-commit) Commit…',
      description: 'pick from recent commits',
      choice: 'commit',
      alwaysShow: true,
    },
  );
  return items;
}

/**
 * Drive the chooser with `createQuickPick` (not `showQuickPick`) so typing
 * can synthesize the direct-compare row live.
 */
function runTargetChooser(): Promise<TargetChoiceItem | undefined> {
  return new Promise<TargetChoiceItem | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<TargetChoiceItem>();
    qp.title = 'Change Target';
    qp.placeholder = 'Pick a target type, or type a branch, tag, or commit directly';
    let done = false;
    const finish = (result: TargetChoiceItem | undefined): void => {
      if (done) return;
      done = true;
      qp.hide();
      qp.dispose();
      resolve(result);
    };
    qp.items = buildTargetChoiceItems('');
    qp.onDidChangeValue((value) => {
      qp.items = buildTargetChoiceItems(value);
    });
    qp.onDidAccept(() => {
      const picked = qp.activeItems[0];
      if (picked) finish(picked);
    });
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}

function shortenSha(sha: string): string {
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 8) : sha;
}

const SHA_PREFIX_RE = /^[0-9a-f]{4,40}$/i;

/**
 * Drive the commit picker with `createQuickPick` so we can react to typing.
 * As the user types, if the input looks like a SHA prefix and doesn't match
 * any visible commit, we synthesise a "Use SHA: <input>" row at the top.
 * That row works for any SHA the user pastes — full or short — even when the
 * commit is older than the current window (`commitPickerLimit`), so users
 * never have to dig through a list to enter a hash they already know.
 */
function runCommitQuickPick(
  git: GitService,
  repoRoot: string,
  relPath: string,
  initialLimit: number,
): Promise<PickedRef | undefined> {
  return new Promise<PickedRef | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<CommitPickItem>();
    qp.title = 'Compare with Commit';
    qp.placeholder = 'Pick a commit, or paste a SHA (short or full)';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.busy = true;

    let commits: CommitInfo[] = [];
    let limit = initialLimit;
    let done = false;

    const finish = (result: PickedRef | undefined) => {
      if (done) return;
      done = true;
      qp.hide();
      qp.dispose();
      resolve(result);
    };

    const rebuildItems = () => {
      const typed = qp.value.trim();
      const items: CommitPickItem[] = [];

      if (typed && SHA_PREFIX_RE.test(typed)) {
        const lower = typed.toLowerCase();
        const matchedInList = commits.some(
          (c) =>
            c.fullSha.toLowerCase().startsWith(lower) ||
            c.shortSha.toLowerCase().startsWith(lower),
        );
        if (!matchedInList) {
          items.push({
            label: `$(arrow-right) Use SHA: ${typed}`,
            description: 'verify and open',
            action: 'use-typed',
            typed,
            alwaysShow: true,
          });
        }
      }

      items.push({
        label: '$(edit) Enter SHA…',
        description: 'open an input box',
        action: 'enter-sha',
        alwaysShow: true,
      });

      for (const c of commits) items.push(commitItem(c));

      if (commits.length >= limit) {
        items.push({
          label: `$(history) Load more (current: ${limit})`,
          action: 'load-more',
          alwaysShow: true,
        });
      }
      qp.items = items;
    };

    const refreshCommits = async () => {
      qp.busy = true;
      try {
        commits = await git.listCommits(repoRoot, limit, relPath);
      } catch {
        commits = [];
      }
      rebuildItems();
      qp.busy = false;
    };

    qp.onDidChangeValue(rebuildItems);

    qp.onDidAccept(async () => {
      const picked = qp.activeItems[0];
      if (!picked) return;

      if (picked.action === 'load-more') {
        limit *= 2;
        await refreshCommits();
        return;
      }

      if (picked.action === 'enter-sha') {
        const input = await vscode.window.showInputBox({
          title: 'Compare with Commit',
          prompt: 'Enter a commit SHA (or any revision recognised by git)',
          value: qp.value,
          validateInput: (v) => {
            const t = v.trim();
            if (!t) return 'Required';
            if (t.startsWith('-')) return "Refs cannot begin with '-'";
            return undefined;
          },
        });
        const trimmed = input?.trim();
        if (!trimmed) {
          finish(undefined);
          return;
        }
        try {
          const full = await git.verifyRef(repoRoot, trimmed);
          finish({ ref: full, display: shortenSha(full) });
        } catch (err) {
          void vscode.window.showErrorMessage(
            err instanceof Error ? err.message : `GitDiff: invalid revision '${trimmed}'`,
          );
          finish(undefined);
        }
        return;
      }

      if (picked.action === 'use-typed') {
        const typed = picked.typed!;
        try {
          const full = await git.verifyRef(repoRoot, typed);
          finish({ ref: full, display: shortenSha(full) });
        } catch (err) {
          void vscode.window.showErrorMessage(
            err instanceof Error ? err.message : `GitDiff: invalid revision '${typed}'`,
          );
          finish(undefined);
        }
        return;
      }

      // Normal commit row — full SHA already provided by `git log`.
      finish({ ref: picked.ref!, display: picked.shortSha ?? picked.ref! });
    });

    qp.onDidHide(() => {
      finish(undefined);
    });

    qp.show();
    void refreshCommits();
  });
}

function buildBranchItems(local: BranchInfo[], remote: BranchInfo[]): BranchPickItem[] {
  const items: BranchPickItem[] = [];
  if (local.length > 0) {
    items.push({ label: 'Local', kind: vscode.QuickPickItemKind.Separator });
    for (const b of local.sort(byName)) {
      items.push({ label: `$(git-branch) ${b.name}`, ref: b.name });
    }
  }
  if (remote.length > 0) {
    items.push({ label: 'Remote', kind: vscode.QuickPickItemKind.Separator });
    for (const b of remote.sort(byName)) {
      items.push({ label: `$(cloud) ${b.name}`, ref: b.name });
    }
  }
  return items;
}

function byName(a: BranchInfo, b: BranchInfo): number {
  return a.name.localeCompare(b.name);
}

function commitItem(c: CommitInfo): CommitPickItem {
  // Include the full SHA in `detail` so VSCode's QuickPick filter (with
  // matchOnDetail) finds the commit whether the user pastes the short or
  // full hash. The short SHA in the label keeps the row visually compact.
  return {
    label: `$(git-commit) ${c.shortSha}  ${c.subject}`,
    description: relativeTime(c.isoDate),
    detail: `${c.author}  ·  ${c.fullSha}`,
    ref: c.fullSha,
    shortSha: c.shortSha,
  };
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffSec = Math.max(1, Math.floor((Date.now() - then) / 1000));
  const units: Array<[number, string]> = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.34524, 'week'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];
  let value = diffSec;
  let label = 'second';
  for (const [factor, name] of units) {
    if (value < factor) {
      label = name;
      break;
    }
    value /= factor;
    label = name;
  }
  const rounded = Math.floor(value);
  return `${rounded} ${label}${rounded === 1 ? '' : 's'} ago`;
}
