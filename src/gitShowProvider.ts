import * as vscode from 'vscode';
import { GitService } from './gitService';
import { decodeGitdiffUri } from './util/uri';

export const GITDIFF_SCHEME = 'gitdiff';

export class GitShowProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly git: GitService) {}

  refresh(uri: vscode.Uri): void {
    this._onDidChange.fire(uri);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { ref, repoRoot, relPath } = decodeGitdiffUri(uri);
    // ref in the URI is a verified full SHA written by DiffOpener.
    const result = await this.git.showFileAtSha(repoRoot, ref, relPath);
    if (!result.exists) return '';
    if (result.kind === 'binary') {
      return `// GitDiff: binary file at ${ref.slice(0, 8)} — diff not supported in v1.\n`;
    }
    if (result.kind === 'nonUtf8') {
      return `// GitDiff: file at ${ref.slice(0, 8)} is not valid UTF-8 — only UTF-8 text is supported in v1.\n`;
    }
    return result.bytes.toString('utf8');
  }
}
