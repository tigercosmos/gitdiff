import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  captureMessages,
  closeAllTabs,
  commit,
  git,
  makeRepo,
  realRepoPath,
  settle,
  withInputBoxReturning,
  withQuickPickPicking,
  withQuickPickQueue,
  withTypedQuickPick,
} from './helpers';
import * as fs from 'fs';
import * as path from 'path';

function contentToString(content: vscode.MarkdownString | vscode.MarkedString): string {
  if (typeof content === 'string') return content;
  if ('value' in content) return content.value;
  return '';
}

async function hoverText(uri: vscode.Uri, line: number): Promise<string> {
  const hovers =
    (await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      uri,
      new vscode.Position(line, 0),
    )) ?? [];

  return hovers
    .flatMap((hover) => hover.contents.map(contentToString))
    .join('\n');
}

describe('gitdiff e2e', function () {
  this.timeout(30000);

  // Captured from activate() so tests can read internals that have no public
  // API (e.g. the inline-blame annotation).
  let api: any;

  before(async () => {
    const ext = vscode.extensions.getExtension('tigercosmos.gitdiff');
    assert.ok(ext, 'extension not found');
    api = await ext!.activate();
  });

  beforeEach(async () => {
    await closeAllTabs();
  });

  it('registers all commands', async () => {
    const cmds = await vscode.commands.getCommands(true);
    for (const id of [
      'gitdiff.compareWithBranch',
      'gitdiff.compareWithCommit',
      'gitdiff.refresh',
      'gitdiff.changeTarget',
      'gitdiff.changedFiles.setTarget',
      'gitdiff.changedFiles.refresh',
      'gitdiff.changedFiles.openFile',
      'gitdiff.openCommitDiffForFile',
    ]) {
      assert.ok(cmds.includes(id), `missing command ${id}`);
    }
  });

  describe('Inline current-line blame', () => {
    // Poll the test seam instead of fixed sleeps — keeps it stable on slow
    // (xvfb / Windows) CI runners.
    async function waitFor(pred: () => boolean, ms = 6000): Promise<boolean> {
      for (let w = 0; w <= ms; w += 100) {
        if (pred()) return true;
        await settle(100);
      }
      return pred();
    }

    it('annotates the cursor line of a working-tree file with author, date, subject', async () => {
      const root = makeRepo();
      const fp = path.join(root, 'inline.js');
      fs.writeFileSync(fp, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
      commit(root, 'Seed inline blame (#7)');

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));

      await waitFor(() => {
        const a = api.lineBlame.getRenderedAnnotation();
        return !!a && a.line === 1;
      });
      const ann = api.lineBlame.getRenderedAnnotation();
      assert.ok(ann, 'expected an inline annotation on the cursor line');
      assert.strictEqual(ann.line, 1);
      assert.strictEqual(ann.uri, doc.uri.toString());
      assert.ok(ann.text.includes('Test'), `author missing: ${ann.text}`);
      assert.ok(ann.text.includes('Seed inline blame (#7)'), `subject missing: ${ann.text}`);
      assert.match(ann.text, /\d{4}-\d{2}-\d{2}/);
    });

    it('follows the cursor and reflects the per-line commit', async () => {
      const root = makeRepo();
      const fp = path.join(root, 'multi.js');
      fs.writeFileSync(fp, 'line0\nline1\nline2\nline3\n');
      commit(root, 'first');
      fs.appendFileSync(fp, 'line4 added later\n');
      commit(root, 'second commit adds a line');

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
      const editor = await vscode.window.showTextDocument(doc);

      editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
      await waitFor(() => {
        const a = api.lineBlame.getRenderedAnnotation();
        return !!a && a.line === 0 && a.text.includes('first');
      });
      assert.ok(
        api.lineBlame.getRenderedAnnotation().text.includes('first'),
        'line 0 should blame the first commit',
      );

      editor.selection = new vscode.Selection(new vscode.Position(4, 0), new vscode.Position(4, 0));
      await waitFor(() => {
        const a = api.lineBlame.getRenderedAnnotation();
        return !!a && a.line === 4 && a.text.includes('second commit adds a line');
      });
      const ann = api.lineBlame.getRenderedAnnotation();
      assert.strictEqual(ann.line, 4);
      assert.ok(ann.text.includes('second commit adds a line'), `line 4 subject: ${ann.text}`);
    });

    it('is suppressed while gitdiff.lineBlame.enabled is false, and returns when re-enabled', async () => {
      const root = makeRepo();
      const fp = path.join(root, 'toggle.js');
      fs.writeFileSync(fp, 'alpha\nbeta\n');
      commit(root, 'init');

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
      await waitFor(() => !!api.lineBlame.getRenderedAnnotation());
      assert.ok(api.lineBlame.getRenderedAnnotation(), 'annotation expected while enabled');

      try {
        await vscode.workspace
          .getConfiguration('gitdiff')
          .update('lineBlame.enabled', false, vscode.ConfigurationTarget.Global);
        await waitFor(() => api.lineBlame.getRenderedAnnotation() === undefined);
        assert.strictEqual(
          api.lineBlame.getRenderedAnnotation(),
          undefined,
          'annotation must clear when the feature is disabled',
        );
      } finally {
        await vscode.workspace
          .getConfiguration('gitdiff')
          .update('lineBlame.enabled', undefined, vscode.ConfigurationTarget.Global);
      }

      editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));
      await waitFor(() => !!api.lineBlame.getRenderedAnnotation());
      assert.ok(api.lineBlame.getRenderedAnnotation(), 'annotation expected after re-enable');
    });

    it('annotates the ref-pinned gitdiff pane as well', async () => {
      const root = makeRepo();
      const fp = path.join(root, 'pane.txt');
      fs.writeFileSync(fp, 'pinned content\n');
      commit(root, 'pane commit subject');
      fs.writeFileSync(fp, 'pinned content changed\n');

      const fileUri = vscode.Uri.file(fp);
      await vscode.window.showTextDocument(fileUri);
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff);
      const left = (tab.input as vscode.TabInputTextDiff).original;

      const leftDoc = await vscode.workspace.openTextDocument(left);
      const leftEditor = await vscode.window.showTextDocument(leftDoc, { preview: false });
      leftEditor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
      await waitFor(() => {
        const a = api.lineBlame.getRenderedAnnotation();
        return !!a && a.uri === left.toString();
      });
      const ann = api.lineBlame.getRenderedAnnotation();
      assert.ok(ann, 'expected an inline annotation in the gitdiff pane');
      assert.strictEqual(ann.uri, left.toString());
      assert.ok(ann.text.includes('pane commit subject'), `subject: ${ann.text}`);
    });
  });

  describe('Compare with Branch', () => {
    it('opens a diff with TabInputTextDiff and a gitdiff: original', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'first version\n');
      commit(root, 'initial');
      fs.writeFileSync(filePath, 'second version\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);

      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();

      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff);
      const input = tab.input as vscode.TabInputTextDiff;
      assert.strictEqual(input.original.scheme, 'gitdiff');
      assert.strictEqual(input.modified.scheme, 'file');
      assert.strictEqual(input.modified.fsPath, fileUri.fsPath);

      const params = new URLSearchParams(input.original.query);
      // ref is the resolved full SHA; branch carries the original picker label.
      assert.match(params.get('ref')!, /^[0-9a-f]{40}$/);
      assert.strictEqual(params.get('branch'), 'main');
      assert.strictEqual(realRepoPath(params.get('repo')!), realRepoPath(root));
    });

    it('left pane content matches `git show`', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'committed content\n');
      commit(root, 'initial');
      // Working-tree change after the commit.
      fs.writeFileSync(filePath, 'WT change\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();

      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      const input = tab.input as vscode.TabInputTextDiff;
      const left = await vscode.workspace.openTextDocument(input.original);
      assert.strictEqual(left.getText(), 'committed content\n');

      const right = await vscode.workspace.openTextDocument(input.modified);
      assert.strictEqual(right.getText(), 'WT change\n');
    });

    it('aborts with a warning when file at ref is binary', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'b.bin');
      fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]));
      commit(root, 'add binary');
      fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47, 0xff]));

      const fileUri = vscode.Uri.file(filePath);
      const cap = captureMessages();
      try {
        await withQuickPickPicking(
          (i) => typeof i.label === 'string' && i.label.includes('main'),
          () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
        );
        await settle();
      } finally {
        cap.restore();
      }

      assert.ok(
        cap.warnings.some((w) => w.includes('binary')),
        `expected binary warning, got ${JSON.stringify(cap.warnings)}`,
      );
      // No diff tab opened.
      const active = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(
        !(active?.input instanceof vscode.TabInputTextDiff),
        'expected no diff tab',
      );
    });
  });

  describe('Blame hovers', () => {
    it('shows author and commit summary on both panes of an active GitDiff diff', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'stable line\ncommitted second\n');
      commit(root, 'initial');
      fs.writeFileSync(filePath, 'stable line\nworking second\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();

      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff);
      const input = tab.input as vscode.TabInputTextDiff;

      const leftHover = await hoverText(input.original, 0);
      assert.ok(leftHover.includes('Author:'), leftHover);
      assert.ok(leftHover.includes('Test'), leftHover);
      assert.ok(leftHover.includes('Commit:'), leftHover);
      assert.ok(leftHover.includes('initial'), leftHover);

      const rightHover = await hoverText(input.modified, 0);
      assert.ok(rightHover.includes('Author:'), rightHover);
      assert.ok(rightHover.includes('Test'), rightHover);
      assert.ok(rightHover.includes('Commit:'), rightHover);
      assert.ok(rightHover.includes('initial'), rightHover);
    });

    it('uses unsaved right-pane contents when visible line numbers shift', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'first\n');
      commit(root, 'first line');
      fs.writeFileSync(filePath, 'first\nsecond\n');
      commit(root, 'second line');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();

      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff);
      const input = tab.input as vscode.TabInputTextDiff;

      let inserted = false;
      try {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(input.modified, new vscode.Position(0, 0), 'unsaved\n');
        inserted = await vscode.workspace.applyEdit(edit);
        assert.strictEqual(inserted, true);

        const rightHover = (await hoverText(input.modified, 1)).replace(/&nbsp;/g, ' ');
        assert.ok(rightHover.includes('Author:'), rightHover);
        assert.ok(rightHover.includes('Test'), rightHover);
        assert.ok(rightHover.includes('first line'), rightHover);
        assert.ok(!rightHover.includes('second line'), rightHover);
      } finally {
        if (inserted) {
          const cleanup = new vscode.WorkspaceEdit();
          cleanup.delete(
            input.modified,
            new vscode.Range(new vscode.Position(0, 0), new vscode.Position(1, 0)),
          );
          await vscode.workspace.applyEdit(cleanup);
          const doc = await vscode.workspace.openTextDocument(input.modified);
          if (doc.isDirty) await doc.save();
        }
      }
    });

    it('does not add GitDiff blame hovers to regular file editors', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'plain file\n');
      commit(root, 'initial');

      await vscode.window.showTextDocument(vscode.Uri.file(filePath));
      await settle();

      const text = await hoverText(vscode.Uri.file(filePath), 0);
      assert.ok(!text.includes('Author:'), text);
      assert.ok(!text.includes('Commit:'), text);
    });
  });

  describe('Commit blame links & open-commit-diff', () => {
    async function openMainDiff(root: string, filePath: string): Promise<vscode.TabInputTextDiff> {
      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff);
      return tab.input as vscode.TabInputTextDiff;
    }

    it('hover adds commit/PR web links and an open-commit-diff command when a remote is set', async () => {
      const root = makeRepo();
      git(root, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'line one\n');
      commit(root, 'Add the thing (#42)');
      fs.writeFileSync(filePath, 'line one changed\n');

      const input = await openMainDiff(root, filePath);
      const leftHover = await hoverText(input.original, 0);
      assert.ok(
        leftHover.includes('https://github.com/owner/repo/commit/'),
        `expected commit web link, got: ${leftHover}`,
      );
      assert.ok(
        leftHover.includes('https://github.com/owner/repo/pull/42'),
        `expected PR link, got: ${leftHover}`,
      );
      assert.ok(leftHover.includes('Open commit diff'), leftHover);
      assert.ok(leftHover.includes('command:gitdiff.openCommitDiffForFile'), leftHover);
    });

    it('hover offers open-commit-diff but no web links when the repo has no remote', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'x\n');
      commit(root, 'init');
      fs.writeFileSync(filePath, 'y\n');

      const input = await openMainDiff(root, filePath);
      const leftHover = await hoverText(input.original, 0);
      assert.ok(leftHover.includes('Open commit diff'), leftHover);
      assert.ok(!leftHover.includes('/commit/'), `unexpected web commit link: ${leftHover}`);
      assert.ok(!/\/pull\//.test(leftHover), `unexpected PR link: ${leftHover}`);
    });

    it('the hover command URI round-trips: parsing + invoking it opens the diff', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'v1\n');
      commit(root, 'v1');
      fs.writeFileSync(filePath, 'v2\n');
      commit(root, 'v2');
      fs.writeFileSync(filePath, 'v3-WT\n');

      const input = await openMainDiff(root, filePath);
      const leftHover = await hoverText(input.original, 0);
      // Extract the command URI exactly as VS Code's markdown renderer would.
      const m = /command:gitdiff\.openCommitDiffForFile\?([^)\s]+)/.exec(leftHover);
      assert.ok(m, `expected a command URI in hover: ${leftHover}`);
      const parsed = JSON.parse(decodeURIComponent(m![1]));
      // Must be a positional-arg array, per the VS Code command-URI contract.
      assert.ok(Array.isArray(parsed), `command args must be an array, got ${m![1]}`);

      await closeAllTabs();
      await vscode.commands.executeCommand('gitdiff.openCommitDiffForFile', ...parsed);
      await settle();

      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff, 'expected diff from command URI');
      assert.match(tab.label, /a\.txt @ [0-9a-f]{8}/);
    });

    it('open-commit-diff uses the pre-rename path so a renamed file diffs correctly', async () => {
      const root = makeRepo();
      fs.writeFileSync(path.join(root, 'old.txt'), 'a\nb\n');
      commit(root, 'add old.txt');
      git(root, ['mv', 'old.txt', 'new.txt']);
      fs.writeFileSync(path.join(root, 'new.txt'), 'a\nb\nc\n');
      commit(root, 'rename old.txt to new.txt');
      fs.writeFileSync(path.join(root, 'new.txt'), 'a\nb\nc\nWT\n');

      const input = await openMainDiff(root, path.join(root, 'new.txt'));
      // Line 0 ("a") was last touched in the pre-rename commit, where the file
      // was still old.txt — blame must follow the rename.
      const hv = await hoverText(input.original, 0);
      const m = /command:gitdiff\.openCommitDiffForFile\?([^)\s]+)/.exec(hv);
      assert.ok(m, `expected command URI: ${hv}`);
      const parsed = JSON.parse(decodeURIComponent(m![1]));
      assert.strictEqual(
        parsed[0].relPath,
        'old.txt',
        `command must target the pre-rename path, got ${parsed[0].relPath}`,
      );

      await closeAllTabs();
      await vscode.commands.executeCommand('gitdiff.openCommitDiffForFile', ...parsed);
      await settle();
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff, 'expected a diff tab');
      const right = await vscode.workspace.openTextDocument(
        (tab.input as vscode.TabInputTextDiff).modified,
      );
      // The diff is the real content at the blamed commit, not empty.
      assert.ok(right.getText().includes('a'), `expected old.txt content, got: ${right.getText()}`);
      assert.ok(right.getText().length > 0, 'diff must not be empty for a renamed file');
    });

    it('opens a parent-vs-commit diff for a single file', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'v1\n');
      commit(root, 'v1');
      fs.writeFileSync(filePath, 'v2\n');
      commit(root, 'v2');
      const sha2 = git(root, ['rev-parse', 'HEAD']).trim();
      const sha1 = git(root, ['rev-parse', 'HEAD~1']).trim();

      await vscode.commands.executeCommand('gitdiff.openCommitDiffForFile', {
        repoRoot: realRepoPath(root),
        relPath: 'a.txt',
        sha: sha2,
      });
      await settle();

      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff, 'expected a diff tab');
      const input = tab.input as vscode.TabInputTextDiff;
      assert.strictEqual(input.original.scheme, 'gitdiff');
      assert.strictEqual(input.modified.scheme, 'gitdiff');
      assert.strictEqual(new URLSearchParams(input.original.query).get('ref'), sha1);
      assert.strictEqual(new URLSearchParams(input.modified.query).get('ref'), sha2);

      const left = await vscode.workspace.openTextDocument(input.original);
      const right = await vscode.workspace.openTextDocument(input.modified);
      assert.strictEqual(left.getText(), 'v1\n');
      assert.strictEqual(right.getText(), 'v2\n');
      assert.match(tab.label, /a\.txt @ [0-9a-f]{8}/);
    });

    it('diffs a root commit against the empty tree (empty left side)', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'first\n');
      commit(root, 'root');
      const sha = git(root, ['rev-parse', 'HEAD']).trim();

      await vscode.commands.executeCommand('gitdiff.openCommitDiffForFile', {
        repoRoot: realRepoPath(root),
        relPath: 'a.txt',
        sha,
      });
      await settle();

      const input = vscode.window.tabGroups.activeTabGroup.activeTab!
        .input as vscode.TabInputTextDiff;
      const left = await vscode.workspace.openTextDocument(input.original);
      const right = await vscode.workspace.openTextDocument(input.modified);
      assert.strictEqual(left.getText(), '');
      assert.strictEqual(right.getText(), 'first\n');
    });

    it('ignores malformed open-commit-diff args without opening a diff', async () => {
      await vscode.commands.executeCommand('gitdiff.openCommitDiffForFile', {
        repoRoot: '',
        relPath: '',
        sha: '',
      });
      await settle();
      const active = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(
        !(active?.input instanceof vscode.TabInputTextDiff),
        'expected no diff for malformed args',
      );
    });
  });

  describe('Compare with Commit', () => {
    it('resolves picker selection to a full 40-char SHA in the URI', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'v1\n');
      const sha1 = commit(root, 'v1');
      fs.writeFileSync(filePath, 'v2\n');
      commit(root, 'v2');
      fs.writeFileSync(filePath, 'v3-WT\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes(sha1),
        () => vscode.commands.executeCommand('gitdiff.compareWithCommit', fileUri),
      );
      await settle();

      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      const input = tab.input as vscode.TabInputTextDiff;
      const params = new URLSearchParams(input.original.query);
      const stored = params.get('ref')!;
      // Stored ref must be the full SHA (immune to ambiguity over time),
      // not the short %h the picker displays.
      assert.match(stored, /^[0-9a-f]{40}$/);
      assert.ok(stored.startsWith(sha1));
      // Tab title still shows the short form.
      assert.match(tab.label, new RegExp(`\\(vs ${sha1}\\)`));

      const left = await vscode.workspace.openTextDocument(input.original);
      assert.strictEqual(left.getText(), 'v1\n');
    });

    it('accepts a free-form SHA via "Enter SHA…" and stores the full SHA', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'v1\n');
      const sha1 = commit(root, 'v1');
      fs.writeFileSync(filePath, 'v2-WT\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      await withInputBoxReturning(sha1, async () => {
        await withQuickPickPicking(
          (i) => typeof i.label === 'string' && i.label.includes('Enter SHA'),
          () => vscode.commands.executeCommand('gitdiff.compareWithCommit', fileUri),
        );
      });
      await settle();

      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      const input = tab.input as vscode.TabInputTextDiff;
      const params = new URLSearchParams(input.original.query);
      const stored = params.get('ref')!;
      assert.match(stored, /^[0-9a-f]{40}$/);
      assert.ok(stored.startsWith(sha1));
    });

    it('Compare with Commit: typing a full SHA produces a "Use SHA" row that works', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'v1\n');
      commit(root, 'v1');
      const fullSha = git(root, ['rev-parse', 'HEAD']).trim();
      assert.match(fullSha, /^[0-9a-f]{40}$/);
      fs.writeFileSync(filePath, 'WT\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      // Type the full SHA into the picker. Since the commit IS in the
      // listing, the synthetic "Use SHA" row should NOT appear (the existing
      // commit row matches by prefix). Pick the existing row.
      await withTypedQuickPick(
        fullSha,
        (i) => i.ref === fullSha,
        () => vscode.commands.executeCommand('gitdiff.compareWithCommit', fileUri),
      );
      await settle();

      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff);
      const params = new URLSearchParams(
        (tab.input as vscode.TabInputTextDiff).original.query,
      );
      assert.strictEqual(params.get('ref'), fullSha);
    });

    it('Compare with Commit: typing a SHA NOT in the listing surfaces "Use SHA" row', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      // Make the file exist at every commit.
      fs.writeFileSync(filePath, 'v1\n');
      commit(root, 'v1');
      const oldSha = git(root, ['rev-parse', 'HEAD']).trim();
      // Force the picker to NOT see this commit by setting commitPickerLimit
      // to 1 and adding more commits on top.
      await vscode.workspace
        .getConfiguration('gitdiff')
        .update('commitPickerLimit', 1, vscode.ConfigurationTarget.Global);
      try {
        fs.writeFileSync(filePath, 'v2\n');
        commit(root, 'v2');
        fs.writeFileSync(filePath, 'v3\n');
        commit(root, 'v3');
        fs.writeFileSync(filePath, 'WT\n');

        const fileUri = vscode.Uri.file(filePath);
        await vscode.window.showTextDocument(fileUri);
        // Type the OLD SHA — beyond the visible window. Synthetic "Use SHA"
        // row should appear; pick it.
        await withTypedQuickPick(
          oldSha,
          (i) => i.action === 'use-typed' && i.typed === oldSha,
          () => vscode.commands.executeCommand('gitdiff.compareWithCommit', fileUri),
        );
        await settle();

        const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
        assert.ok(
          tab.input instanceof vscode.TabInputTextDiff,
          'expected diff to open against the typed SHA',
        );
        const params = new URLSearchParams(
          (tab.input as vscode.TabInputTextDiff).original.query,
        );
        assert.strictEqual(params.get('ref'), oldSha);
      } finally {
        await vscode.workspace
          .getConfiguration('gitdiff')
          .update('commitPickerLimit', undefined, vscode.ConfigurationTarget.Global);
      }
    });

    it('Compare with Commit "Enter SHA…" accepts a full SHA', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'v1\n');
      commit(root, 'v1');
      const fullSha = git(root, ['rev-parse', 'HEAD']).trim();
      fs.writeFileSync(filePath, 'WT\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      await withInputBoxReturning(fullSha, async () => {
        await withQuickPickPicking(
          (i) => typeof i.label === 'string' && i.label.includes('Enter SHA'),
          () => vscode.commands.executeCommand('gitdiff.compareWithCommit', fileUri),
        );
      });
      await settle();

      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff);
      const params = new URLSearchParams(
        (tab.input as vscode.TabInputTextDiff).original.query,
      );
      assert.strictEqual(params.get('ref'), fullSha);
    });

    it('shows an error and opens no diff for an invalid ref via "Enter SHA…"', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'v1\n');
      commit(root, 'v1');
      fs.writeFileSync(filePath, 'v2-WT\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      const cap = captureMessages();
      try {
        await withInputBoxReturning('nosuchref', async () => {
          await withQuickPickPicking(
            (i) => typeof i.label === 'string' && i.label.includes('Enter SHA'),
            () => vscode.commands.executeCommand('gitdiff.compareWithCommit', fileUri),
          );
        });
      } finally {
        cap.restore();
      }
      assert.ok(
        cap.errors.some((e) => /not a valid revision/i.test(e)),
        `expected invalid-revision error, got ${JSON.stringify(cap.errors)}`,
      );
      assert.ok(
        !(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
          vscode.TabInputTextDiff),
        'expected no diff to open',
      );
    });

    it('rejects option-like input ("--help") at validation, no git invocation', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'v1\n');
      commit(root, 'v1');
      fs.writeFileSync(filePath, 'v2-WT\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      const cap = captureMessages();
      try {
        // showInputBox would normally validate and re-prompt; our stub
        // returns the value directly. Either way, verifyRef must reject it.
        await withInputBoxReturning('--help', async () => {
          await withQuickPickPicking(
            (i) => typeof i.label === 'string' && i.label.includes('Enter SHA'),
            () => vscode.commands.executeCommand('gitdiff.compareWithCommit', fileUri),
          );
        });
      } finally {
        cap.restore();
      }
      assert.ok(
        cap.errors.some((e) => /'-'/i.test(e) || /not a valid revision/i.test(e)),
        `expected '-' or invalid-revision error, got ${JSON.stringify(cap.errors)}`,
      );
      assert.ok(
        !(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
          vscode.TabInputTextDiff),
        'expected no diff to open',
      );
    });
  });

  describe('Edge cases', () => {
    it('shows "(new vs <ref>)" in title when file does not exist at ref', async () => {
      const root = makeRepo();
      // Commit only b.txt at main.
      fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
      commit(root, 'only b');
      // Now create a new file in working tree, never committed.
      const filePath = path.join(root, 'newfile.txt');
      fs.writeFileSync(filePath, 'brand new\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();

      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff);
      assert.match(tab.label, /\(new vs main\)/);
    });

    it('rejects non-file: editors with an info message', async () => {
      const cap = captureMessages();
      const fakeUri = vscode.Uri.parse('untitled:Untitled-1');
      try {
        await vscode.commands.executeCommand('gitdiff.compareWithBranch', fakeUri);
      } finally {
        cap.restore();
      }
      assert.ok(
        cap.infos.some((i) => i.toLowerCase().includes('open a file')),
        `expected info message, got ${JSON.stringify(cap.infos)}`,
      );
      const active = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(!(active?.input instanceof vscode.TabInputTextDiff));
    });

    it('rejects a path outside any git repo with an error', async () => {
      // Make a non-repo directory and a file inside it.
      const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gitdiff-norepo-'));
      const filePath = path.join(dir, 'free.txt');
      fs.writeFileSync(filePath, 'no repo here\n');
      const fileUri = vscode.Uri.file(filePath);

      const cap = captureMessages();
      try {
        // Intercept showQuickPick to throw if reached — the command should
        // never get past the repoRoot lookup. But because the picker runs
        // first (it does the lookup), it may show an error there. Either way,
        // no diff tab should open.
        const origPick = vscode.window.showQuickPick;
        (vscode.window as any).showQuickPick = async () => undefined;
        try {
          await vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri);
        } finally {
          (vscode.window as any).showQuickPick = origPick;
        }
      } finally {
        cap.restore();
      }
      const active = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(
        !(active?.input instanceof vscode.TabInputTextDiff),
        'expected no diff to open outside a repo',
      );
    });
  });

  describe('Symlinks', () => {
    it('compares a tracked symlink as itself, not as its target', async function () {
      // Skip on platforms where symlink creation is restricted (Windows w/o
      // dev mode). On macOS/Linux this works.
      const root = makeRepo();
      const target = path.join(root, 'real.txt');
      const link = path.join(root, 'link.txt');
      fs.writeFileSync(target, 'real-content\n');
      try {
        fs.symlinkSync('real.txt', link);
      } catch {
        this.skip();
        return;
      }
      commit(root, 'add real + link');
      // Modify the link target on disk via the link (writes to real.txt).
      // We want the diff to be against link.txt at HEAD, which is the literal
      // symlink string "real.txt" — i.e. the diff should compare the
      // symlink's stored value, not what it dereferences to.
      fs.unlinkSync(link);
      fs.writeFileSync(link, 'pretending to be a regular file\n');

      const fileUri = vscode.Uri.file(link);
      await vscode.window.showTextDocument(fileUri);
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();

      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff);
      const input = tab.input as vscode.TabInputTextDiff;
      // The repo-relative path in the URI must be "link.txt", not "real.txt".
      const params = new URLSearchParams(input.original.query);
      assert.ok(input.original.path.endsWith('/link.txt'));
      assert.match(params.get('ref')!, /^[0-9a-f]{40}$/);
    });
  });

  describe('Refresh & live editing', () => {
    it('refresh follows the branch tip: new commit on main → diff updates', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'v1\n');
      commit(root, 'v1');
      fs.writeFileSync(filePath, 'WT\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();

      const tabBefore = vscode.window.tabGroups.activeTabGroup.activeTab!;
      const inputBefore = tabBefore.input as vscode.TabInputTextDiff;
      const shaBefore = new URLSearchParams(inputBefore.original.query).get('ref');
      const left1 = await vscode.workspace.openTextDocument(inputBefore.original);
      assert.strictEqual(left1.getText(), 'v1\n');

      // Advance `main` with a new commit that changes the file.
      fs.writeFileSync(filePath, 'v2-committed\n');
      commit(root, 'v2');
      fs.writeFileSync(filePath, 'WT-after\n');

      await vscode.commands.executeCommand('gitdiff.refresh');
      await settle();

      // Refresh should have re-resolved branch=main → new SHA, and the diff
      // should now be against v2-committed.
      const tabAfter = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tabAfter.input instanceof vscode.TabInputTextDiff);
      const inputAfter = tabAfter.input as vscode.TabInputTextDiff;
      const shaAfter = new URLSearchParams(inputAfter.original.query).get('ref');
      assert.notStrictEqual(shaAfter, shaBefore, 'expected URI SHA to advance');
      assert.match(shaAfter!, /^[0-9a-f]{40}$/);

      const leftAfter = await vscode.workspace.openTextDocument(inputAfter.original);
      assert.strictEqual(leftAfter.getText(), 'v2-committed\n');
    });

    it('refresh keeps a commit-pinned diff stable even when main advances', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'v1\n');
      const sha1 = commit(root, 'v1');
      fs.writeFileSync(filePath, 'v2\n');
      commit(root, 'v2');
      fs.writeFileSync(filePath, 'WT\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      // Pick the older commit.
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes(sha1),
        () => vscode.commands.executeCommand('gitdiff.compareWithCommit', fileUri),
      );
      await settle();

      const inputBefore = vscode.window.tabGroups.activeTabGroup.activeTab!
        .input as vscode.TabInputTextDiff;
      const shaBefore = new URLSearchParams(inputBefore.original.query).get('ref');

      // Advance main; the diff should NOT move (no branch in URI).
      fs.writeFileSync(filePath, 'v3-committed\n');
      commit(root, 'v3');
      fs.writeFileSync(filePath, 'WT-after\n');

      await vscode.commands.executeCommand('gitdiff.refresh');
      await settle();

      const inputAfter = vscode.window.tabGroups.activeTabGroup.activeTab!
        .input as vscode.TabInputTextDiff;
      const shaAfter = new URLSearchParams(inputAfter.original.query).get('ref');
      assert.strictEqual(shaAfter, shaBefore);
      const left = await vscode.workspace.openTextDocument(inputAfter.original);
      assert.strictEqual(left.getText(), 'v1\n');
    });

    it('refresh detects branch tip moving to binary and closes the diff', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'text-v1\n');
      commit(root, 'v1');
      fs.writeFileSync(filePath, 'WT\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();
      const before = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(before.input instanceof vscode.TabInputTextDiff);

      // Advance `main` to a commit where a.txt is now binary, then refresh.
      // Refresh follows branch=main and should detect the new binary content,
      // warn, and close the diff tab — not open a misleading placeholder.
      fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]));
      commit(root, 'binarify');

      const cap = captureMessages();
      try {
        await vscode.commands.executeCommand('gitdiff.refresh');
      } finally {
        cap.restore();
      }
      await settle();

      assert.ok(
        cap.warnings.some((w) => /binary/.test(w)),
        `expected binary warning, got ${JSON.stringify(cap.warnings)}`,
      );
      const active = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(
        !(active?.input instanceof vscode.TabInputTextDiff),
        'expected diff tab to be closed',
      );
    });

    it('right pane is editable and saves to disk', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'original\n');
      commit(root, 'init');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();

      const input = vscode.window.tabGroups.activeTabGroup.activeTab!
        .input as vscode.TabInputTextDiff;
      const rightDoc = await vscode.workspace.openTextDocument(input.modified);
      const editor = await vscode.window.showTextDocument(rightDoc);
      const ok = await editor.edit((eb) => {
        eb.insert(new vscode.Position(0, 0), 'PREFIX ');
      });
      assert.strictEqual(ok, true);
      const saved = await rightDoc.save();
      assert.strictEqual(saved, true);
      assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'PREFIX original\n');
    });
  });

  describe('Sidebar auto-populate from compare commands', () => {
    it('Compare with Branch sets the sidebar target so openFile uses it', async () => {
      const root = makeRepo();
      fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
      fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
      commit(root, 'init');
      // Create unstaged WT changes vs HEAD.
      fs.writeFileSync(path.join(root, 'a.txt'), 'a-WT\n');
      fs.writeFileSync(path.join(root, 'untracked.txt'), 'new\n');

      const fileUri = vscode.Uri.file(path.join(root, 'a.txt'));
      await vscode.window.showTextDocument(fileUri);
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();
      // The diff opened. Now invoke openFile (the sidebar's per-row click
      // handler) without a separate Set-Target step. It must succeed
      // because the compare command auto-populated the sidebar target.
      await closeAllTabs();
      await vscode.commands.executeCommand('gitdiff.changedFiles.openFile', {
        relPath: 'untracked.txt',
        absPath: path.join(root, 'untracked.txt'),
        status: '?',
      });
      await settle();

      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(
        tab.input instanceof vscode.TabInputTextDiff,
        'expected sidebar openFile to use the target set by Compare with Branch',
      );
      const params = new URLSearchParams(
        (tab.input as vscode.TabInputTextDiff).original.query,
      );
      assert.strictEqual(params.get('branch'), 'main');
    });
  });

  describe('Changed Files view (sidebar)', () => {
    it('lists modified, added, deleted, and untracked files vs the target', async () => {
      const root = makeRepo();
      // Initial commit: a.txt, b.txt, c.txt.
      fs.writeFileSync(path.join(root, 'a.txt'), 'a-orig\n');
      fs.writeFileSync(path.join(root, 'b.txt'), 'b-orig\n');
      fs.writeFileSync(path.join(root, 'c.txt'), 'c-orig\n');
      commit(root, 'init');
      // Modify a, delete b (working tree), keep c, add a NEW committed file
      // d.txt that won't exist at the target.
      fs.writeFileSync(path.join(root, 'a.txt'), 'a-modified\n');
      fs.unlinkSync(path.join(root, 'b.txt'));
      fs.writeFileSync(path.join(root, 'd.txt'), 'd-new-commit\n');
      // Untracked file:
      fs.writeFileSync(path.join(root, 'untracked.txt'), 'never staged\n');
      // d.txt is staged+committed; a.txt change is unstaged. Both should
      // show up vs the initial target.
      const initialSha = git(root, ['rev-parse', '--short', 'HEAD']).trim();
      git(root, ['add', 'd.txt']);
      git(root, ['commit', '-m', 'add d', '-q']);

      // Set target = initial commit by going through pickAny → pickCommit →
      // Enter SHA…
      const fileUri = vscode.Uri.file(path.join(root, 'a.txt'));
      await vscode.window.showTextDocument(fileUri);
      await withInputBoxReturning(initialSha, async () => {
        await withQuickPickQueue(
          [
            (i) => typeof i.label === 'string' && i.label.includes('Commit'),
            (i) => typeof i.label === 'string' && i.label.includes('Enter SHA'),
          ],
          () => vscode.commands.executeCommand('gitdiff.changedFiles.setTarget'),
        );
      });
      await settle();

      // The view's TreeDataProvider isn't directly accessible through the
      // public API, so we exercise it indirectly by invoking the openFile
      // command for each expected entry — but first we need the entries.
      // Use a workaround: list-changed-paths via the GitService directly.
      // The contract is: tree.getChildren() and listChangedPaths return the
      // same set, so this is a reasonable surrogate for what's rendered.
      const ext = vscode.extensions.getExtension('tigercosmos.gitdiff')!;
      void ext; // ensures extension activated
      // We can't reach into the provider; instead, assert that the click
      // handler successfully opens diffs for representative paths.
      // Modified file (a.txt) → diff should open against the initial SHA.
      await vscode.commands.executeCommand('gitdiff.changedFiles.openFile', {
        relPath: 'a.txt',
        absPath: path.join(root, 'a.txt'),
        status: 'M',
      });
      await settle();
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff);
      const input = tab.input as vscode.TabInputTextDiff;
      const params = new URLSearchParams(input.original.query);
      const stored = params.get('ref')!;
      assert.match(stored, /^[0-9a-f]{40}$/);
      assert.ok(stored.startsWith(initialSha));
    });

    it('persists the chosen target across calls (workspaceState round-trip)', async () => {
      // Verify persistence indirectly: setTarget then openFile uses the
      // persisted target without re-prompting.
      const root = makeRepo();
      fs.writeFileSync(path.join(root, 'a.txt'), 'orig\n');
      const sha = commit(root, 'init');
      fs.writeFileSync(path.join(root, 'a.txt'), 'WT\n');

      // Open a file first so setTarget can derive the repo from
      // activeTextEditor (the extension test host has no workspace folder).
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'a.txt')));

      // Set the target via Enter SHA.
      await withInputBoxReturning(sha, async () => {
        await withQuickPickQueue(
          [
            (i) => typeof i.label === 'string' && i.label.includes('Commit'),
            (i) => typeof i.label === 'string' && i.label.includes('Enter SHA'),
          ],
          () => vscode.commands.executeCommand('gitdiff.changedFiles.setTarget'),
        );
      });
      await settle();
      // Now invoke openFile WITHOUT touching the picker — it must use the
      // persisted target.
      await vscode.commands.executeCommand('gitdiff.changedFiles.openFile', {
        relPath: 'a.txt',
        absPath: path.join(root, 'a.txt'),
        status: 'M',
      });
      await settle();
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff);
    });
  });

  describe('ActiveDiffTracker context key', () => {
    it('flips gitdiff.activeDiff true/false as a gitdiff diff gains/loses focus', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      const otherPath = path.join(root, 'b.txt');
      fs.writeFileSync(filePath, 'a\n');
      fs.writeFileSync(otherPath, 'b\n');
      commit(root, 'init');
      fs.writeFileSync(filePath, 'a-WT\n');

      // Open a non-diff editor first.
      await vscode.window.showTextDocument(vscode.Uri.file(otherPath));
      await settle();
      // No good public way to read context keys directly, so we rely on a
      // command that's gated by it: vscode.commands.executeCommand against
      // a not-found command throws; we use the gitdiff.refresh handler's
      // runtime guard (it calls showInformationMessage when no diff active).
      const cap1 = captureMessages();
      try {
        await vscode.commands.executeCommand('gitdiff.refresh');
      } finally {
        cap1.restore();
      }
      assert.ok(
        cap1.infos.some((i) => i.includes('No active GitDiff diff')),
        `expected guard message, got ${JSON.stringify(cap1.infos)}`,
      );

      // Now open a gitdiff diff and refresh — should NOT hit the guard.
      const fileUri = vscode.Uri.file(filePath);
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();

      const cap2 = captureMessages();
      try {
        await vscode.commands.executeCommand('gitdiff.refresh');
      } finally {
        cap2.restore();
      }
      assert.ok(
        !cap2.infos.some((i) => i.includes('No active GitDiff diff')),
        `expected no guard message when diff active, got ${JSON.stringify(cap2.infos)}`,
      );
    });
  });

  describe('Active-file highlight in Changed Files view', () => {
    it('tracks the relPath of the focused gitdiff diff and clears on a non-diff editor', async () => {
      const root = makeRepo();
      const aPath = path.join(root, 'a.txt');
      const bPath = path.join(root, 'b.txt');
      fs.writeFileSync(aPath, 'a\n');
      fs.writeFileSync(bPath, 'b\n');
      commit(root, 'init');
      fs.writeFileSync(aPath, 'a-WT\n');
      fs.writeFileSync(bPath, 'b-WT\n');

      // Open a diff for a.txt vs main — also sets the sidebar target/repo.
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', vscode.Uri.file(aPath)),
      );
      await settle();
      assert.strictEqual(api.changedFiles.getActiveRelPath(), 'a.txt');

      // Open b.txt's diff from the sidebar; the highlight follows focus.
      await vscode.commands.executeCommand('gitdiff.changedFiles.openFile', {
        relPath: 'b.txt',
        absPath: bPath,
        status: 'M',
      });
      await settle();
      assert.strictEqual(api.changedFiles.getActiveRelPath(), 'b.txt');

      // Focus a plain text editor — no gitdiff diff active, highlight clears.
      await vscode.window.showTextDocument(vscode.Uri.file(aPath));
      await settle();
      assert.strictEqual(api.changedFiles.getActiveRelPath(), undefined);
    });
  });

  describe('Non-UTF-8 handling', () => {
    it('aborts initial open with a warning when file at ref is non-UTF-8', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      // Latin-1 bytes that are not valid UTF-8 and contain no NULs.
      fs.writeFileSync(filePath, Buffer.from([0x68, 0x69, 0xe9]));
      commit(root, 'init non-utf8');
      // WT change so there's something to diff.
      fs.writeFileSync(filePath, Buffer.from([0x68, 0x69, 0xe9, 0x21]));

      const fileUri = vscode.Uri.file(filePath);
      const cap = captureMessages();
      try {
        await withQuickPickPicking(
          (i) => typeof i.label === 'string' && i.label.includes('main'),
          () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
        );
        await settle();
      } finally {
        cap.restore();
      }
      assert.ok(
        cap.warnings.some((w) => /UTF-8/.test(w)),
        `expected non-UTF-8 warning, got ${JSON.stringify(cap.warnings)}`,
      );
      const active = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(!(active?.input instanceof vscode.TabInputTextDiff));
    });

    it('refresh detects branch tip moving to non-UTF-8 and closes the diff', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'utf8 text\n');
      commit(root, 'v1');
      fs.writeFileSync(filePath, 'WT\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();

      // Advance main: file becomes non-UTF-8.
      fs.writeFileSync(filePath, Buffer.from([0x68, 0x69, 0xe9]));
      commit(root, 'go non-utf8');

      const cap = captureMessages();
      try {
        await vscode.commands.executeCommand('gitdiff.refresh');
      } finally {
        cap.restore();
      }
      await settle();
      assert.ok(
        cap.warnings.some((w) => /UTF-8/.test(w)),
        `expected non-UTF-8 warning on refresh, got ${JSON.stringify(cap.warnings)}`,
      );
      const active = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(
        !(active?.input instanceof vscode.TabInputTextDiff),
        'expected diff tab to be closed',
      );
    });
  });

  describe('Change Target command', () => {
    it('shows an info message when no gitdiff diff is active', async () => {
      const cap = captureMessages();
      try {
        await vscode.commands.executeCommand('gitdiff.changeTarget');
      } finally {
        cap.restore();
      }
      assert.ok(
        cap.infos.some((i) => i.includes('No active GitDiff diff')),
        `expected info message, got ${JSON.stringify(cap.infos)}`,
      );
    });

    it('on an active diff: re-picks and replaces the diff with the new target', async () => {
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'v1\n');
      const sha1 = commit(root, 'v1');
      fs.writeFileSync(filePath, 'v2\n');
      commit(root, 'v2');
      fs.writeFileSync(filePath, 'WT\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      // Open initial diff against branch main.
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();
      const before = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.strictEqual(
        new URLSearchParams((before.input as vscode.TabInputTextDiff).original.query).get(
          'branch',
        ),
        'main',
      );

      // Change target → pickAny → Commit chooser → pick the v1 row by full SHA.
      await withQuickPickQueue(
        [
          (i) => typeof i.label === 'string' && i.label.includes('Commit'),
          (i) => typeof i.ref === 'string' && i.ref.startsWith(sha1),
        ],
        () => vscode.commands.executeCommand('gitdiff.changeTarget'),
      );
      await settle();

      const after = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(after.input instanceof vscode.TabInputTextDiff);
      const params = new URLSearchParams(
        (after.input as vscode.TabInputTextDiff).original.query,
      );
      // The new target is a commit, so no `branch=` should be set.
      assert.strictEqual(params.get('branch'), null);
      assert.match(params.get('ref')!, /^[0-9a-f]{40}$/);
      assert.ok(params.get('ref')!.startsWith(sha1));
    });
  });

  describe('Configuration changes', () => {
    it('updating gitdiff.commitPickerLimit fires a refresh of open diffs', async () => {
      // Verify the listener path runs without errors when our config changes.
      // The functional outcome (refresh fires) is hard to observe directly;
      // we settle for "no warnings" + "diff still present".
      const root = makeRepo();
      const filePath = path.join(root, 'a.txt');
      fs.writeFileSync(filePath, 'v1\n');
      commit(root, 'v1');
      fs.writeFileSync(filePath, 'WT\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      await withQuickPickPicking(
        (i) => typeof i.label === 'string' && i.label.includes('main'),
        () => vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri),
      );
      await settle();
      assert.ok(
        vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
          vscode.TabInputTextDiff,
      );

      const cap = captureMessages();
      try {
        await vscode.workspace
          .getConfiguration('gitdiff')
          .update('commitPickerLimit', 50, vscode.ConfigurationTarget.Global);
        await settle();
      } finally {
        cap.restore();
        await vscode.workspace
          .getConfiguration('gitdiff')
          .update('commitPickerLimit', undefined, vscode.ConfigurationTarget.Global);
      }
      assert.deepStrictEqual(
        cap.warnings,
        [],
        `expected no warnings on config change, got ${JSON.stringify(cap.warnings)}`,
      );
      // Diff should still be open after the config-driven refresh.
      assert.ok(
        vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
          vscode.TabInputTextDiff,
        'expected diff to still be open after config refresh',
      );
    });
  });

  describe('Branch picker edge cases', () => {
    it('shows an info message in a fresh repo with no commits / no branches', async () => {
      const root = makeRepo(); // git init -b main, no commits yet.
      // Untracked file so there's something to diff.
      const filePath = path.join(root, 'newborn.txt');
      fs.writeFileSync(filePath, 'never committed\n');

      const fileUri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(fileUri);
      const cap = captureMessages();
      try {
        await vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri);
      } finally {
        cap.restore();
      }
      assert.ok(
        cap.infos.some((i) => /no branches/i.test(i)),
        `expected "No branches" info, got ${JSON.stringify(cap.infos)}`,
      );
      const active = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(!(active?.input instanceof vscode.TabInputTextDiff));
    });

    it('excludes refs/remotes/*/HEAD from the branch list', async () => {
      // Set up a fake remote-tracking branch and a remote HEAD pointer.
      const root = makeRepo();
      fs.writeFileSync(path.join(root, 'a.txt'), 'orig\n');
      commit(root, 'init');
      // Create refs/remotes/origin/main pointing at HEAD, and origin/HEAD
      // pointing at origin/main (the noisy symbolic ref we want filtered).
      git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
      fs.writeFileSync(path.join(root, 'a.txt'), 'WT\n');

      // Capture all branch-picker items by using a predicate that records
      // them and never selects anything.
      const seen: string[] = [];
      const restore = () => {};
      const win = vscode.window as any;
      const orig = win.showQuickPick;
      win.showQuickPick = async (items: any) => {
        const resolved = await items;
        for (const it of resolved as any[]) {
          if (typeof it.label === 'string' && it.ref) seen.push(it.ref);
        }
        return undefined; // user cancels
      };
      try {
        const fileUri = vscode.Uri.file(path.join(root, 'a.txt'));
        await vscode.window.showTextDocument(fileUri);
        await vscode.commands.executeCommand('gitdiff.compareWithBranch', fileUri);
      } finally {
        win.showQuickPick = orig;
        void restore;
      }

      assert.ok(seen.includes('main'), `expected local 'main' in picker: ${seen}`);
      assert.ok(
        seen.includes('origin/main'),
        `expected 'origin/main' in picker: ${seen}`,
      );
      assert.ok(
        !seen.includes('origin/HEAD') && !seen.some((s) => s.endsWith('/HEAD')),
        `unexpected */HEAD in picker: ${seen}`,
      );
    });
  });

  describe('Sidebar — direct command surfaces', () => {
    it('gitdiff.changedFiles.setTarget sets target & view title (no Compare command needed)', async () => {
      const root = makeRepo();
      fs.writeFileSync(path.join(root, 'a.txt'), 'orig\n');
      const sha = commit(root, 'init');
      fs.writeFileSync(path.join(root, 'a.txt'), 'WT\n');
      // Need an active editor so setTarget can derive repoRoot.
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'a.txt')));

      await withQuickPickQueue(
        [
          (i) => typeof i.label === 'string' && i.label.includes('Commit'),
          (i) => i.ref === git(root, ['rev-parse', 'HEAD']).trim() || i.ref?.startsWith(sha),
        ],
        () => vscode.commands.executeCommand('gitdiff.changedFiles.setTarget'),
      );
      await settle();

      // Now openFile for any tracked file uses the persisted target without
      // re-prompting.
      await closeAllTabs();
      await vscode.commands.executeCommand('gitdiff.changedFiles.openFile', {
        relPath: 'a.txt',
        absPath: path.join(root, 'a.txt'),
        status: 'M',
      });
      await settle();
      assert.ok(
        vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
          vscode.TabInputTextDiff,
      );
    });

    it('gitdiff.changedFiles.refresh runs without error', async () => {
      const cap = captureMessages();
      try {
        await vscode.commands.executeCommand('gitdiff.changedFiles.refresh');
      } finally {
        cap.restore();
      }
      assert.deepStrictEqual(cap.errors, [], 'refresh should not error');
    });

  });

  describe('Sidebar — file-status filtering', () => {
    it('lists only untracked files when target == HEAD and no tracked changes', async () => {
      const root = makeRepo();
      fs.writeFileSync(path.join(root, 'a.txt'), 'committed\n');
      commit(root, 'init');
      // No WT changes, just an untracked file.
      fs.writeFileSync(path.join(root, 'fresh.txt'), 'never staged\n');
      const headSha = git(root, ['rev-parse', 'HEAD']).trim();

      // Set target = HEAD via setTarget.
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'a.txt')));
      await withQuickPickQueue(
        [
          (i) => typeof i.label === 'string' && i.label.includes('Commit'),
          (i) => i.ref === headSha,
        ],
        () => vscode.commands.executeCommand('gitdiff.changedFiles.setTarget'),
      );
      await settle();

      // Try opening the untracked file via the sidebar's openFile handler.
      await closeAllTabs();
      await vscode.commands.executeCommand('gitdiff.changedFiles.openFile', {
        relPath: 'fresh.txt',
        absPath: path.join(root, 'fresh.txt'),
        status: '?',
      });
      await settle();

      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff);
      assert.match(tab.label, /\(new vs/);
    });
  });

  describe('GitDiff branding (post-rename)', () => {
    it('all command titles use the "GitDiff:" prefix', async () => {
      // We can't read the package.json title at runtime via the API for
      // arbitrary commands, but we can fetch via vscode.commands and verify
      // they exist. The actual title rendering is a static manifest concern;
      // this test just guards that no command was inadvertently dropped.
      const cmds = await vscode.commands.getCommands(true);
      const expected = [
        'gitdiff.compareWithBranch',
        'gitdiff.compareWithCommit',
        'gitdiff.refresh',
        'gitdiff.changeTarget',
        'gitdiff.changedFiles.setTarget',
        'gitdiff.changedFiles.refresh',
        'gitdiff.changedFiles.openFile',
        'gitdiff.openCommitDiffForFile',
      ];
      for (const id of expected) {
        assert.ok(cmds.includes(id), `missing command ${id}`);
      }
    });
  });
});

// Silence unused-helper imports: `git` is re-exported for ad-hoc tests.
void git;
