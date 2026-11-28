import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitDiffExports } from '../../../src/extension';
import { parseNameStatusZ } from '../../../src/gitService';
import { decodeGitdiffUri } from '../../../src/util/uri';
import { closeAllTabs, commit, git, makeRepo, realRepoPath, settle } from './helpers';

describe('three-dot branch review (e2e)', function () {
  this.timeout(30000);
  let api: GitDiffExports;
  let root: string;
  let base: string;
  let head: string;
  const config = vscode.workspace.getConfiguration('gitdiff');

  before(async () => {
    api = await vscode.extensions.getExtension('tigercosmos.gitdiff')!.activate();
    await config.update('branchComparison', 'mergeBase', vscode.ConfigurationTarget.Global);
    await config.update('defaultTarget', 'main', vscode.ConfigurationTarget.Global);
  });

  beforeEach(async () => {
    await closeAllTabs();
    await api.changedFiles.clearTarget();
    root = realRepoPath(makeRepo());
    fs.writeFileSync(path.join(root, 'a.ts'), 'before\n');
    fs.writeFileSync(path.join(root, 'gone.txt'), 'deleted on feature\n');
    fs.writeFileSync(path.join(root, 'old.txt'), 'renamed contents\n');
    commit(root, 'base');
    base = git(root, ['rev-parse', 'HEAD']).trim();
    git(root, ['checkout', '-qb', 'feature']);
    fs.writeFileSync(path.join(root, 'a.ts'), 'committed feature\n');
    fs.writeFileSync(path.join(root, 'added.txt'), 'committed addition\n');
    fs.renameSync(path.join(root, 'old.txt'), path.join(root, 'renamed.txt'));
    fs.unlinkSync(path.join(root, 'gone.txt'));
    commit(root, 'feature');
    head = git(root, ['rev-parse', 'HEAD']).trim();
    git(root, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(root, 'main-only.txt'), 'advanced main\n');
    commit(root, 'advance main');
    git(root, ['checkout', '-q', 'feature']);
    fs.writeFileSync(path.join(root, 'a.ts'), 'unstaged contents\n');
    fs.writeFileSync(path.join(root, 'staged.txt'), 'staged addition\n');
    git(root, ['add', 'staged.txt']);
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'untracked addition\n');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'a.ts')));
    await vscode.window.showTextDocument(document);
    await api.changedFiles.clearTarget();
  });

  afterEach(async () => {
    await api.changedFiles.clearTarget();
    await closeAllTabs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  after(async () => {
    await config.update('branchComparison', undefined, vscode.ConfigurationTarget.Global);
    await config.update('defaultTarget', undefined, vscode.ConfigurationTarget.Global);
  });

  it('automatically selects main and lists exactly git diff main...HEAD', () => {
    assert.strictEqual(api.changedFiles.isDefaultTarget(), true);
    assert.deepStrictEqual(api.changedFiles.getCurrentTarget(), {
      ref: base, head, display: 'main...HEAD', branch: 'main',
    });
    const expected = parseNameStatusZ(git(root, ['diff', '--name-status', '-z', 'main...HEAD']))
      .sort((a, b) => a.relPath.localeCompare(b.relPath));
    assert.deepStrictEqual(api.changedFiles.getAllFiles().map(({ absPath, ...file }) => file), expected);
  });

  it('opens committed contents for modified, added, deleted, and renamed files', async () => {
    for (const file of api.changedFiles.getAllFiles()) {
      await vscode.commands.executeCommand('gitdiff.changedFiles.openFile', file);
      const input = vscode.window.tabGroups.activeTabGroup.activeTab!.input;
      assert.ok(input instanceof vscode.TabInputTextDiff);
      const left = decodeGitdiffUri(input.original);
      const right = decodeGitdiffUri(input.modified);
      assert.strictEqual(left.ref, base);
      assert.strictEqual(right.ref, head);
      assert.strictEqual(left.relPath, file.origPath ?? file.relPath);
      assert.strictEqual(right.relPath, file.relPath);
      const leftDoc = await vscode.workspace.openTextDocument(input.original);
      const rightDoc = await vscode.workspace.openTextDocument(input.modified);
      if (file.relPath === 'a.ts') assert.strictEqual(rightDoc.getText(), 'committed feature\n');
      if (file.status === 'A') assert.strictEqual(leftDoc.getText(), '');
      if (file.status === 'D') assert.strictEqual(rightDoc.getText(), '');
      if (file.status === 'R') assert.strictEqual(leftDoc.getText(), rightDoc.getText());
    }
  });

  it('uses committed contents in the multi-file diff', async () => {
    await vscode.commands.executeCommand('gitdiff.changedFiles.openAll');
    await settle(150);
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const tab = tabs.find((entry) => entry.label.startsWith('All changes (vs main...HEAD)'));
    assert.ok(tab, `expected branch review tab, got: ${tabs.map((entry) => entry.label).join(' | ')}`);
    const diffs = (tab.input as { textDiffs: { original: vscode.Uri; modified: vscode.Uri }[] }).textDiffs;
    assert.ok(diffs.length >= 1);
    for (const diff of diffs) {
      assert.strictEqual(decodeGitdiffUri(diff.original).ref, base);
      assert.strictEqual(decodeGitdiffUri(diff.modified).ref, head);
    }
  });

  it('refreshes the pinned HEAD after a commit', async () => {
    const file = api.changedFiles.getAllFiles().find((entry) => entry.relPath === 'a.ts')!;
    await vscode.commands.executeCommand('gitdiff.changedFiles.openFile', file);
    commit(root, 'another feature commit');
    const nextHead = git(root, ['rev-parse', 'HEAD']).trim();
    await api.changedFiles.refresh();
    assert.strictEqual(api.changedFiles.getCurrentTarget()!.head, nextHead);
    await vscode.commands.executeCommand('gitdiff.refresh');
    const input = vscode.window.tabGroups.activeTabGroup.activeTab!.input;
    assert.ok(input instanceof vscode.TabInputTextDiff);
    assert.strictEqual(decodeGitdiffUri(input.modified).ref, nextHead);
  });

  it('recomputes the comparison when checking out another branch', async () => {
    git(root, ['reset', '--hard', 'HEAD']);
    git(root, ['checkout', '-q', 'main']);
    await api.changedFiles.refresh();
    const main = git(root, ['rev-parse', 'HEAD']).trim();
    assert.strictEqual(api.changedFiles.getCurrentTarget()!.ref, main);
    assert.strictEqual(api.changedFiles.getCurrentTarget()!.head, main);
    assert.deepStrictEqual(api.changedFiles.getAllFiles(), []);
  });
});
