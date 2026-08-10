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

describe('webview file list', () => {
  it('renders one row per file with its status', () => {
    const dom = runWebviewScript(HTML);
    dom.send(
      filesMessage({
        files: [
          { relPath: 'src/a.ts', status: 'M' },
          { relPath: 'b.ts', status: '?' },
        ],
      }),
    );
    const rows = (dom.byId.get('files-list') as FakeElement).children.flatMap((c) =>
      c.tagName === '#fragment' ? c.children : [c],
    );
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(
      rows.map((r) => r.getAttribute('data-rel')),
      ['src/a.ts', 'b.ts'],
    );
  });
});
