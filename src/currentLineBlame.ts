import * as vscode from 'vscode';
import { ActiveDiffTracker } from './activeDiffTracker';
import { BlameInfo, GitService } from './gitService';
import { GITDIFF_SCHEME } from './gitShowProvider';
import { decodeGitdiffUri } from './util/uri';
import { formatInlineBlame, renderBlameMarkdown } from './blameFormat';
import { buildBlameLinks } from './blameHoverProvider';
import { parseRemoteWebBase, RemoteWeb } from './util/gitRemote';

/** The inline blame annotation applied to one editor line. */
export interface RenderedAnnotation {
  /** `document.uri.toString()` of the editor the annotation is on. */
  uri: string;
  /** Zero-based line the annotation decorates. */
  line: number;
  /** The annotation text (without the leading spacer), e.g. `Ada, 2026-06-07 • subject`. */
  text: string;
}

interface LineTarget {
  repoRoot: string;
  relPath: string;
  /** Pinned ref for gitdiff: panes; absent for working-tree files. */
  ref?: string;
  /** Live buffer contents, supplied only when the document is dirty. */
  contents?: string;
  /**
   * True for GitDiff's own diff views (the gitdiff: pane and the active diff's
   * editable working file). The hover provider already serves a rich popup on
   * any line there, so the decoration omits its own hover to avoid doubling up.
   */
  diffPane: boolean;
}

/**
 * Renders a dim end-of-line annotation (author, date, summary) on the cursor's
 * current line, in any file inside a git repo and in GitDiff's diff panes. In
 * plain files the annotation also carries the rich hover (commit/PR/open-diff
 * links); in diff panes the existing hover provider supplies that.
 */
export class CurrentLineBlameController implements vscode.Disposable {
  private static readonly DEBOUNCE_MS = 200;
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private enabled: boolean;
  private timer: ReturnType<typeof setTimeout> | undefined;
  // Monotonic guard: a slow blame for a stale cursor line must not overwrite
  // the annotation for a newer one.
  private seq = 0;

  // fsPath -> resolved repo location, or null when the path is outside any repo
  // (cached so a non-repo file isn't probed on every cursor move).
  private readonly pathCache = new Map<string, { repoRoot: string; relPath: string } | null>();
  private readonly remoteCache = new Map<string, Promise<RemoteWeb | undefined>>();

  // Test seam: the inline annotation currently shown on the active editor's
  // cursor line. Decorations have no read-back API, so this is how e2e tests
  // (and callers) observe what was rendered. Kept in sync with setDecorations.
  private lastAnnotation: RenderedAnnotation | undefined;

  constructor(
    private readonly git: GitService,
    private readonly tracker: ActiveDiffTracker,
  ) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
      after: {
        margin: '0 0 0 3em',
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
      },
    });
    this.enabled = readEnabled();

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) this.schedule();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('gitdiff.lineBlame')) return;
        this.enabled = readEnabled();
        // Disabling must also invalidate any pending debounce/in-flight blame,
        // or a refresh scheduled while enabled could repaint after the toggle.
        if (this.enabled) this.schedule();
        else this.invalidatePending();
      }),
    );

    this.schedule();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.decorationType.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.pathCache.clear();
    this.remoteCache.clear();
  }

  /**
   * Clear the stale annotation immediately, then (debounced) recompute it for
   * the active editor's cursor line. Clearing up front means the annotation
   * never lingers on the line you just left while the blame is in flight.
   */
  private schedule(): void {
    this.invalidatePending();
    if (!this.enabled) return;
    const seq = this.seq;
    this.timer = setTimeout(() => {
      void this.refresh(seq);
    }, CurrentLineBlameController.DEBOUNCE_MS);
  }

  /**
   * Cancel any pending debounce and abandon any in-flight blame (by bumping the
   * sequence so its late result is ignored), then clear the visible annotation.
   */
  private invalidatePending(): void {
    this.seq++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.clearAll();
  }

  private clearAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.decorationType, []);
    }
    this.lastAnnotation = undefined;
  }

  /**
   * The inline annotation currently applied to the active editor's cursor line,
   * or undefined when none is shown. Exposed for integration tests, which can't
   * read editor decorations through the VS Code API.
   */
  getRenderedAnnotation(): RenderedAnnotation | undefined {
    return this.lastAnnotation;
  }

  private async refresh(seq: number): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!this.enabled || !editor || seq !== this.seq) return;

    const line = editor.selection.active.line;
    const target = await this.resolveTarget(editor.document);
    if (!target || seq !== this.seq) return;

    let info: BlameInfo | undefined;
    try {
      info =
        target.contents !== undefined
          ? await this.git.blameLineForContents(
              target.repoRoot,
              target.relPath,
              line + 1,
              target.contents,
              target.ref,
            )
          : await this.git.blameLine(target.repoRoot, target.relPath, line + 1, target.ref);
    } catch {
      return;
    }
    if (!info || seq !== this.seq) return;
    // The buffer may have shrunk since we captured `line`; re-validate.
    if (line >= editor.document.lineCount) return;

    let hoverMessage: vscode.MarkdownString | undefined;
    if (!target.diffPane) {
      const links = await buildBlameLinks(info, target.repoRoot, target.relPath, (root) =>
        this.remote(root),
      );
      if (seq !== this.seq) return;
      hoverMessage = renderBlameMarkdown(info, links);
    }

    const text = formatInlineBlame(info);
    const eol = editor.document.lineAt(line).range.end;
    editor.setDecorations(this.decorationType, [
      {
        range: new vscode.Range(eol, eol),
        renderOptions: { after: { contentText: ` ${text}` } },
        hoverMessage,
      },
    ]);
    this.lastAnnotation = { uri: editor.document.uri.toString(), line, text };
  }

  private async resolveTarget(document: vscode.TextDocument): Promise<LineTarget | undefined> {
    if (document.uri.scheme === GITDIFF_SCHEME) {
      try {
        const { repoRoot, relPath, ref } = decodeGitdiffUri(document.uri);
        return { repoRoot, relPath, ref, diffPane: true };
      } catch {
        return undefined;
      }
    }
    if (document.uri.scheme !== 'file') return undefined;

    // Editable working-tree pane of the active diff: blame its repo location
    // (taken from the left side) and live contents, as the hover does.
    const active = this.tracker.getActiveGitdiffPair();
    if (active && active.right.toString() === document.uri.toString()) {
      try {
        const { repoRoot, relPath } = decodeGitdiffUri(active.left);
        return { repoRoot, relPath, contents: document.getText(), diffPane: true };
      } catch {
        // fall through to plain-file resolution
      }
    }

    const loc = await this.locate(document.uri.fsPath);
    if (!loc) return undefined;
    return {
      repoRoot: loc.repoRoot,
      relPath: loc.relPath,
      // Only pipe contents through stdin when the buffer differs from disk;
      // a clean file is blamed directly (no stdin), which is cheaper.
      contents: document.isDirty ? document.getText() : undefined,
      diffPane: false,
    };
  }

  private async locate(
    fsPath: string,
  ): Promise<{ repoRoot: string; relPath: string } | undefined> {
    if (this.pathCache.has(fsPath)) return this.pathCache.get(fsPath) ?? undefined;
    let loc: { repoRoot: string; relPath: string } | null = null;
    try {
      const repoRoot = await this.git.repoRoot(fsPath);
      const relPath = this.git.relPath(repoRoot, fsPath);
      // A path resolving outside the repo (leading "..") isn't blameable here.
      loc = relPath && !relPath.startsWith('..') ? { repoRoot, relPath } : null;
    } catch {
      loc = null;
    }
    this.pathCache.set(fsPath, loc);
    return loc ?? undefined;
  }

  private remote(repoRoot: string): Promise<RemoteWeb | undefined> {
    let cached = this.remoteCache.get(repoRoot);
    if (!cached) {
      cached = Promise.resolve()
        .then(() => this.git.remoteUrl(repoRoot))
        .then((url) => (url ? parseRemoteWebBase(url) : undefined))
        .catch(() => undefined);
      this.remoteCache.set(repoRoot, cached);
    }
    return cached;
  }
}

function readEnabled(): boolean {
  return vscode.workspace.getConfiguration('gitdiff').get<boolean>('lineBlame.enabled', true);
}
