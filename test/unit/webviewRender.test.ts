import * as assert from 'assert';
import { runWebviewScript, extractScript, FakeElement } from './_fake-dom';

// `changedFilesProvider.ts` imports `vscode` at module load time. Stub it
// before requiring the module — same pattern as the other unit tests.
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') {
    return require.resolve('./_vscode-stub-full');
  }
  return originalResolve.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderHtml } = require('../../src/changedFilesProvider');

const HTML: string = renderHtml({ cspSource: 'vscode-webview://test' });

function filesMessage(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'files',
    hasTarget: true,
    targetLabel: 'upstream/master',
    files: [{ relPath: 'src/a.ts', status: 'M' }],
    ...extra,
  };
}

describe('webview script', () => {
  // The script lives in a template literal, so tsc never parses it: a typo
  // there ships silently and breaks the whole sidebar at runtime.
  it('is syntactically valid JavaScript', () => {
    assert.doesNotThrow(() => new Function(extractScript(HTML)));
  });

  it('loads and announces itself as ready', () => {
    const dom = runWebviewScript(HTML);
    assert.deepStrictEqual(dom.posted, [{ type: 'ready' }]);
  });
});

describe('webview target bar', () => {
  function targetBar(payload: Record<string, unknown>): FakeElement {
    const dom = runWebviewScript(HTML);
    dom.send(payload);
    return dom.byId.get('target-bar') as FakeElement;
  }

  it('names the repo alongside the target', () => {
    const bar = targetBar(
      filesMessage({ repoLabel: 'agent-mvp-step3', repoPath: '/repo/.worktrees/agent-mvp-step3' }),
    );
    assert.strictEqual(bar.textContent, 'Comparing vs upstream/master in agent-mvp-step3');
    assert.strictEqual(bar.style.display, '');
  });

  it('carries the full repo root as the repo label tooltip', () => {
    const bar = targetBar(
      filesMessage({ repoLabel: 'agent-mvp-step3', repoPath: '/repo/.worktrees/agent-mvp-step3' }),
    );
    const repo = bar.find('.target-repo');
    assert.ok(repo, 'expected a .target-repo span');
    assert.strictEqual(repo.title, '/repo/.worktrees/agent-mvp-step3');
  });

  it('falls back to the repo label as tooltip when no path is supplied', () => {
    const bar = targetBar(filesMessage({ repoLabel: 'proj' }));
    assert.strictEqual(bar.find('.target-repo')?.title, 'proj');
  });

  it('omits the repo entirely when the message carries none', () => {
    const bar = targetBar(filesMessage());
    assert.strictEqual(bar.textContent, 'Comparing vs upstream/master');
    assert.strictEqual(bar.find('.target-repo'), undefined);
  });

  // Re-rendering must not accumulate repo spans: textContent assignment has to
  // clear the previously appended one.
  it('does not stack repo labels across renders', () => {
    const dom = runWebviewScript(HTML);
    dom.send(filesMessage({ repoLabel: 'proj', repoPath: '/proj' }));
    dom.send(filesMessage({ repoLabel: 'other', repoPath: '/other' }));
    const bar = dom.byId.get('target-bar') as FakeElement;
    assert.strictEqual(bar.textContent, 'Comparing vs upstream/master in other');
    assert.strictEqual(bar.children.filter((c) => c.classList.contains('target-repo')).length, 1);
  });

  it('hides the bar when there is no target', () => {
    const bar = targetBar({ type: 'files', hasTarget: false, targetLabel: '', files: [] });
    assert.strictEqual(bar.style.display, 'none');
    assert.strictEqual(bar.textContent, '');
  });

  // A repo path is an arbitrary filesystem string; it must reach the DOM as
  // text, never as markup.
  it('treats a markup-shaped repo path as text', () => {
    const bar = targetBar(
      filesMessage({ repoLabel: '<img src=x onerror=alert(1)>', repoPath: '/tmp/x' }),
    );
    assert.strictEqual(
      bar.textContent,
      'Comparing vs upstream/master in <img src=x onerror=alert(1)>',
    );
  });
});

/** The rows of #files-list, in document order. */
function rows(dom: ReturnType<typeof runWebviewScript>): FakeElement[] {
  return (dom.byId.get('files-list') as FakeElement).children;
}
/** One string per row: `D <depth> <path>` for folders, `F <depth> <path>` for files. */
function outline(dom: ReturnType<typeof runWebviewScript>): string[] {
  return rows(dom).map((r) => {
    const dir = r.getAttribute('data-dir');
    const depth = r.getAttribute('data-depth') ?? '-';
    return dir !== null ? `D ${depth} ${dir}` : `F ${depth} ${r.getAttribute('data-rel')}`;
  });
}
const init = (viewMode: 'tree' | 'list') => ({ type: 'init', filter: {}, viewMode });

describe('webview file list (list mode)', () => {
  it('renders one flat row per file, in the order sent, with the dir dimmed after the name', () => {
    const dom = runWebviewScript(HTML);
    dom.send(init('list'));
    dom.send(
      filesMessage({
        files: [
          { relPath: 'src/a.ts', status: 'M' },
          { relPath: 'b.ts', status: '?' },
        ],
      }),
    );
    assert.deepStrictEqual(outline(dom), ['F - src/a.ts', 'F - b.ts']);
    const first = rows(dom)[0];
    assert.strictEqual(first.find('.name')?.textContent, 'a.ts');
    assert.strictEqual(first.find('.dir')?.textContent, 'src');
    assert.strictEqual(first.find('.status')?.textContent, 'M');
    assert.strictEqual(first.find('.twistie'), undefined);
  });
});

describe('webview file tree', () => {
  const FILES = [
    { relPath: 'src/util/glob.ts', status: 'M' },
    { relPath: 'src/a.ts', status: 'M' },
    { relPath: 'README.md', status: 'M' },
    { relPath: 'b.ts', status: '?' },
    { relPath: 'src/util/search.ts', status: 'D' },
  ];

  it('is the default layout before any init arrives', () => {
    const dom = runWebviewScript(HTML);
    dom.send(filesMessage({ files: [{ relPath: 'src/a.ts', status: 'M' }] }));
    assert.deepStrictEqual(outline(dom), ['D 0 src', 'F 1 src/a.ts']);
  });

  it('nests files under their folders: folders first, then files, each alphabetical', () => {
    const dom = runWebviewScript(HTML);
    dom.send(init('tree'));
    dom.send(filesMessage({ files: FILES }));
    assert.deepStrictEqual(outline(dom), [
      'D 0 src',
      'D 1 src/util',
      'F 2 src/util/glob.ts',
      'F 2 src/util/search.ts',
      'F 1 src/a.ts',
      'F 0 b.ts',
      'F 0 README.md',
    ]);
  });

  it('labels tree file rows with the basename only and keeps their status', () => {
    const dom = runWebviewScript(HTML);
    dom.send(filesMessage({ files: FILES }));
    const glob = rows(dom).find((r) => r.getAttribute('data-rel') === 'src/util/glob.ts')!;
    assert.strictEqual(glob.find('.name')?.textContent, 'glob.ts');
    assert.strictEqual(glob.find('.dir'), undefined);
    assert.strictEqual(glob.find('.status')?.textContent, 'M');
    assert.ok(glob.find('.twistie')?.classList.contains('leaf'), 'file rows carry a blank twistie for alignment');
    assert.strictEqual(glob.title, 'src/util/glob.ts');
  });

  it('indents each level further than its parent', () => {
    const dom = runWebviewScript(HTML);
    dom.send(filesMessage({ files: FILES }));
    const pad = (i: number) => parseInt(rows(dom)[i].style.paddingLeft, 10);
    assert.ok(pad(0) < pad(1) && pad(1) < pad(2), `expected increasing indent, got ${pad(0)},${pad(1)},${pad(2)}`);
  });

  // explorer.compactFolders: a/b/c with nothing but one sub-folder at each
  // step collapses into a single "a/b/c" row keyed by the innermost path.
  it('compacts single-child folder chains into one row', () => {
    const dom = runWebviewScript(HTML);
    dom.send(
      filesMessage({
        files: [
          { relPath: 'a/b/c/d.ts', status: 'A' },
          { relPath: 'a/b/c/e.ts', status: 'A' },
        ],
      }),
    );
    assert.deepStrictEqual(outline(dom), ['D 0 a/b/c', 'F 1 a/b/c/d.ts', 'F 1 a/b/c/e.ts']);
    const dir = rows(dom)[0];
    assert.strictEqual(dir.find('.name')?.textContent, 'a/b/c');
    assert.strictEqual(dir.title, 'a/b/c');
    assert.strictEqual(dir.getAttribute('aria-expanded'), 'true');
    assert.ok(dir.find('.twistie')?.classList.contains('expanded'));
  });

  it('does not compact a folder that also holds a file', () => {
    const dom = runWebviewScript(HTML);
    dom.send(
      filesMessage({
        files: [
          { relPath: 'a/b/c.ts', status: 'A' },
          { relPath: 'a/d.ts', status: 'A' },
        ],
      }),
    );
    assert.deepStrictEqual(outline(dom), ['D 0 a', 'D 1 a/b', 'F 2 a/b/c.ts', 'F 1 a/d.ts']);
  });

  it('hides the descendants of a folder persisted as collapsed', () => {
    const dom = runWebviewScript(HTML, { collapsed: ['src/util'] });
    dom.send(filesMessage({ files: FILES }));
    assert.deepStrictEqual(outline(dom), [
      'D 0 src',
      'D 1 src/util',
      'F 1 src/a.ts',
      'F 0 b.ts',
      'F 0 README.md',
    ]);
    const util = rows(dom)[1];
    assert.strictEqual(util.getAttribute('aria-expanded'), 'false');
    assert.ok(!util.find('.twistie')?.classList.contains('expanded'));
  });

  it('keeps the layout persisted in webview state until init says otherwise', () => {
    const dom = runWebviewScript(HTML, { viewMode: 'list' });
    dom.send(filesMessage({ files: FILES }));
    assert.strictEqual(outline(dom).filter((l) => l.startsWith('D')).length, 0);
    dom.send(init('tree'));
    dom.send(filesMessage({ files: FILES }));
    assert.strictEqual(outline(dom)[0], 'D 0 src');
  });

  it('re-renders the last list when the layout toggles, without a new files message', () => {
    const dom = runWebviewScript(HTML);
    dom.send(filesMessage({ files: FILES }));
    dom.send({ type: 'viewMode', viewMode: 'list' });
    assert.deepStrictEqual(
      outline(dom),
      FILES.map((f) => `F - ${f.relPath}`),
      'list mode keeps the order the extension sent',
    );
    dom.send({ type: 'viewMode', viewMode: 'tree' });
    assert.strictEqual(outline(dom)[0], 'D 0 src');
    assert.deepStrictEqual((dom.state as { viewMode: string }).viewMode, 'tree');
  });

  // The Explorer reveals the active editor's file; so does the tree — a
  // collapsed ancestor is expanded so the highlighted row is actually visible.
  it('expands collapsed ancestors to reveal the active file', () => {
    const dom = runWebviewScript(HTML, { collapsed: ['src', 'src/util'] });
    dom.send(filesMessage({ files: FILES, activeRelPath: 'src/util/glob.ts' }));
    const glob = rows(dom).find((r) => r.getAttribute('data-rel') === 'src/util/glob.ts');
    assert.ok(glob, 'active file row should now be rendered');
    assert.ok(glob!.classList.contains('active-file'));
    assert.deepStrictEqual((dom.state as { collapsed: string[] }).collapsed, []);
  });

  it('leaves collapsed folders alone when the active file is not in the list', () => {
    const dom = runWebviewScript(HTML, { collapsed: ['src'] });
    dom.send(filesMessage({ files: FILES, activeRelPath: 'src/not-listed.ts' }));
    assert.deepStrictEqual(outline(dom), ['D 0 src', 'F 0 b.ts', 'F 0 README.md']);
    assert.deepStrictEqual((dom.state as { collapsed: string[] }).collapsed, ['src']);
  });

  it('treats a markup-shaped path as text in folder and file rows', () => {
    const dom = runWebviewScript(HTML);
    dom.send(filesMessage({ files: [{ relPath: '<b>x</b>/<i>y<i>.ts', status: 'M' }] }));
    assert.strictEqual(rows(dom)[0].find('.name')?.textContent, '<b>x</b>');
    assert.strictEqual(rows(dom)[1].find('.name')?.textContent, '<i>y<i>.ts');
  });
});

// Regression (Codex review): a folder collapsed on its own can later be merged
// into a compact chain when a filter/refresh removes its other children. The
// compact row must honour the collapse of every directory it stands for.
describe('webview file tree — collapse survives compaction', () => {
  it('keeps a compact row shut when an outer directory in its chain is collapsed', () => {
    const dom = runWebviewScript(HTML, { collapsed: ['a'] });
    dom.send(
      filesMessage({
        files: [
          { relPath: 'a/x.ts', status: 'M' },
          { relPath: 'a/b/y.ts', status: 'M' },
        ],
      }),
    );
    assert.deepStrictEqual(outline(dom), ['D 0 a']);
    // Filter narrows the list to a/b/y.ts: `a` now compacts into `a/b`.
    dom.send(filesMessage({ files: [{ relPath: 'a/b/y.ts', status: 'M' }] }));
    assert.deepStrictEqual(outline(dom), ['D 0 a/b'], 'a/b must stay collapsed because a is');
    const row = rows(dom)[0];
    assert.strictEqual(row.getAttribute('aria-expanded'), 'false');
    assert.deepStrictEqual(JSON.parse(row.getAttribute('data-chain')!), ['a', 'a/b']);
  });

  it('records every directory of a compact row so expanding it can clear them all', () => {
    const dom = runWebviewScript(HTML);
    dom.send(filesMessage({ files: [{ relPath: 'a/b/c/d.ts', status: 'A' }] }));
    assert.deepStrictEqual(JSON.parse(rows(dom)[0].getAttribute('data-chain')!), ['a', 'a/b', 'a/b/c']);
  });
});
