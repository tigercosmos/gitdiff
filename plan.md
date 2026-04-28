# gitdiff — VSCode Extension Development Plan

A VSCode extension that lets you diff the current working-tree state of a file (including unstaged edits) against any branch or commit, while keeping the file editable inside the diff view.

## 1. Goals & Non-goals

### Goals
- Compare the **current working-tree file** (staged + unstaged) against the same path at any **branch tip**.
- Compare the **current working-tree file** against the same path at any **commit (SHA)**.
- The current side of the diff remains a **live, editable** buffer — saving writes through to the real file on disk.
- Provide a **commit/branch picker** UI so the user can choose what to diff against.

### Non-goals (v1)
- Three-way merge conflict resolution.
- Diffing whole folders / multi-file diffs (single active file only in v1; folder diff is a v2 stretch).
- Rewriting Git history, staging hunks, or replacing the built-in Source Control view.
- Remote-only refs that aren't fetched locally (rely on whatever `git` already knows).
- **Virtual / web workspaces** (`vscode.dev`, GitHub Codespaces browser, Remote – Repositories without a real workspace folder). We require a local `file:` workspace and a local `git` binary. Declared in the manifest as `capabilities.virtualWorkspaces: false`. If we later support remote extension hosts, we'll set `extensionKind: ["workspace"]`.
- "Swap sides" — would invert which pane is the live editable file and break the right-pane-is-editable invariant. Not in v1.

## 2. User-facing Features

### F1 — "Compare with Branch"
- Command: `gitdiff.compareWithBranch`
- Flow: command palette → quick-pick of local + remote-tracking branches (excluding symbolic `refs/remotes/*/HEAD`) → diff view opens with left = `<branch>:<path>` (read-only via virtual document), right = the working-tree file (`file:` URI, editable).

### F2 — "Compare with Commit"
- Command: `gitdiff.compareWithCommit`
- Flow: command palette → quick-pick of recent commits (subject + short SHA + relative date), with a "Enter SHA…" option for arbitrary commits → diff view opens.

### F3 — Editable right-hand side
- The right pane is the actual workspace file (`file:` URI), so all standard edit/save behavior works.
- The left pane is a virtual read-only document backed by `git show <ref>:<path>`. Read-only is enforced by *not* registering a `FileSystemProvider` (a `TextDocumentContentProvider` only services reads).

### F4 — Re-pick / refresh target
- Title-bar action on a gitdiff diff editor: **Change Target…** (`gitdiff.changeTarget`) re-opens the picker.
- Title-bar action: **Refresh** (`gitdiff.refresh`) re-fires the content provider's `onDidChange` for the visible left URI.
- Both buttons are gated on a custom `gitdiff.activeDiff` context key — see §3.

### F5 — Context-menu entry
- Right-click on a file in the Explorer or editor tab → "Compare with Branch…" / "Compare with Commit…", scoped to local files only and excluding folders.

### F6 — Status indication
- The diff editor's tab title shows the target, e.g. `index.ts (vs main)` or `index.ts (vs a1b2c3d)`.

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  extension.ts (activation, command + provider registration)  │
├──────────────────────────────────────────────────────────────┤
│  GitService         — shells out to `git` (execFile, args[]) │
│  RefPicker          — QuickPick UI for branches & commits    │
│  DiffOpener         — builds the URIs and calls vscode.diff  │
│  GitShowProvider    — TextDocumentContentProvider for left   │
│                       pane (scheme: gitdiff)                 │
│  ActiveDiffTracker  — maintains the gitdiff.activeDiff       │
│                       context key by inspecting tab inputs   │
└──────────────────────────────────────────────────────────────┘
```

### Left pane: virtual document URI design

A naive `gitdiff://<ref>/<path>` does not round-trip: refs like `feature/x`, `origin/main`, or names with reserved URI characters collide with the URI's authority/path split, and the URI alone tells the provider nothing about *which* repo to read from (multi-root, nested repos, submodules).

We use:

```
scheme:   gitdiff
authority: (empty)
path:     /<repo-relative-POSIX-path>     // the file path, never the ref
query:    ref=<percent-encoded-ref>
          &repo=<percent-encoded-absolute-repo-root>
fragment: (empty)
```

Example for `main` in repo `/Users/me/proj`, file `src/index.ts`:

```
gitdiff:/src/index.ts?ref=main&repo=%2FUsers%2Fme%2Fproj
```

For a feature branch:

```
gitdiff:/src/index.ts?ref=feature%2Fx&repo=%2FUsers%2Fme%2Fproj
```

The `uri.ts` codec percent-encodes both `ref` and `repo` via `encodeURIComponent` and reconstructs `vscode.Uri` with `with({ query: ... })` so escaping is uniform. The provider parses `query` to recover `{ ref, repoRoot, relPath }`.

### Right pane: real workspace file
- Just the file's normal `file://` URI — VSCode's diff editor handles edits & saves natively.
- Confirmed behavior: when the modified (right) input of `vscode.diff` is a `file:` URI with no read-only filesystem provider, the right pane is editable and saves go through to disk. The left, served by our `TextDocumentContentProvider`, is read-only because content providers don't expose write operations.

### Opening the diff
```ts
vscode.commands.executeCommand(
  'vscode.diff',
  leftUri,                             // gitdiff:/<path>?ref=...&repo=...
  rightUri,                            // file://<abs-path>
  `${path.basename(file)} (vs ${displayRef})`,
  { preview: false }
);
```

### GitService — exact arg arrays (no shell)

All calls go through `child_process.execFile('git', [...args], { cwd: repoRoot, maxBuffer: 50 * 1024 * 1024, encoding: 'buffer' })`. The `encoding: 'buffer'` option is required — without it, Node's default decodes stdout/stderr as UTF-8 strings, which corrupts binary blobs (`git show` of an image) and silently mangles non-UTF-8 text before we get a chance to detect it. With `'buffer'`, both `stdout` and `stderr` are `Buffer`s; we decode as UTF-8 only when we know the payload is text (see §4 binary handling). NUL is used as the field separator everywhere we parse structured output, so subjects/author names/paths containing `|`, `\t`, or newlines parse safely.

| Method | argv |
|---|---|
| `repoRoot(forFile)` | `['-C', dir, 'rev-parse', '--show-toplevel']` |
| `listBranchesLocal()` | `['for-each-ref', '--format=%(refname:short)', 'refs/heads']` |
| `listBranchesRemote()` | `['for-each-ref', '--format=%(refname:short)', '--exclude=refs/remotes/*/HEAD', 'refs/remotes']` |
| `listCommits(path?, limit)` | `['log', '-z', `--pretty=format:%h%x00%s%x00%cI%x00%an`, `-n`, String(limit), ...(path ? ['--', path] : [])]` |
| `showFileAtRef(ref, path)` | `['show', `${ref}:${path}`]` (returns `{ exists: true, content }`) |
| `fileExistsAtRef(ref, path)` | `['cat-file', '-e', `${ref}:${path}`]` (exit 0 → exists, non-zero → not present — see §4) |

Notes on the `log` format: `%cI` (strict ISO date) is parseable for sorting/labels; we render relative dates client-side. The `-z` flag NUL-terminates **records**; `%x00` NUL-separates **fields** within each record. So a record looks like `<sha>NUL<subject>NUL<isoDate>NUL<authorNUL>` followed by a record-terminating NUL. The parser splits on NULs in groups of 4.

Branch picker concatenates `listBranchesLocal()` then `listBranchesRemote()` with a separator label (`Local` / `Remote`).

### ActiveDiffTracker — context key for menus

`resourceScheme` reflects only the focused side of a diff and is not a reliable proxy for "a gitdiff diff is the active tab." Instead:

- Subscribe to `vscode.window.tabGroups.onDidChangeTabs` and `onDidChangeTabGroups` (these are the only `TabGroups` events; there is no `onDidChangeActiveTab`). The `onDidChangeTabs` payload (`TabChangeEvent`) reports opened/closed/changed tabs, which covers active-tab changes because the previously-active tab and the newly-active tab both surface as "changed".
- On every change, read `window.tabGroups.activeTabGroup.activeTab?.input`.
- If it is a `vscode.TabInputTextDiff` whose `original.scheme === 'gitdiff'`, set:
  ```ts
  vscode.commands.executeCommand('setContext', 'gitdiff.activeDiff', true);
  ```
  Otherwise set it to `false`.
- The Refresh and Change-Target buttons in `editor/title` are gated by `when: gitdiff.activeDiff`.
- The same tracker also exposes a helper that returns `{ leftUri, rightUri }` for the active diff so command handlers don't have to re-derive them.

### Refresh strategy
- `GitShowProvider` exposes `onDidChange`.
- Fired on:
  - `gitdiff.refresh` (manual button).
  - `workspace.onDidChangeConfiguration` for our settings (e.g. `gitPath`).
- v1 does **not** auto-watch git refs; manual refresh is enough.

## 4. Edge Cases

| Case | Handling |
|---|---|
| File doesn't exist at the chosen ref | `GitService.showFileAtRef` returns `{ exists: false, content: '' }`. Provider returns empty string for diff rendering, but the existence flag is carried into the tab title (`<file> (new vs <ref>)`) and into a status message. Distinguished from "exists but empty" via `cat-file -e` (no false-positive labelling). |
| File deleted in working tree but exists at ref | Show information message; offer to open ref content in a new untitled doc. |
| Workspace folder isn't a git repo | Command shows error: "Not a git repository". |
| Multi-root workspace / nested repos / submodules | Repo root is resolved per-file via `rev-parse --show-toplevel` and **encoded into the virtual URI's query** so the provider always reads from the right repo, even after restore. |
| File path contains spaces / unicode / `|` / quotes | All git calls use `execFile` with arg arrays — no shell quoting. Path passed as a single argv element. |
| Ref names with reserved URI chars (`feature/x`, `origin/main`) | `encodeURIComponent` in the URI codec; round-trip tested. |
| Binary or non-UTF-8 file | Scope v1 to UTF-8 text only. Detect via `git check-attr -z binary` or by inspecting the blob for NUL bytes in the first ~8KB. On binary: show "Binary file — diff not supported in v1" and abort. On non-UTF-8 text: show "Unsupported encoding (v1: UTF-8 only)" and abort. These are reported as separate cases — non-UTF-8 ≠ binary. |
| Detached HEAD / no branches yet | `listBranchesLocal()` may return empty; the branch picker degrades to "no branches found — try Compare with Commit" and the commit picker remains usable. |
| Remote `origin/HEAD` and other symbolic remote refs | Excluded via `--exclude=refs/remotes/*/HEAD` in `for-each-ref`. |
| Very large repo / slow `git log` | Cap commits at `gitdiff.commitPickerLimit` (default 100); QuickPick has a "Load more…" entry that re-queries with `2 × limit` (or accepts a free-form SHA). |
| User edits right side, then re-picks target | Right side stays as-is (it's the live file); left side updates to new ref. |
| User invokes a command on a non-`file:` editor (e.g. Output, Settings JSON, untitled) | Command handler guards `uri.scheme === 'file'` and shows "Open a file from your workspace first." |
| Restored `gitdiff:` tabs after window reload | VSCode restores tab inputs eagerly at window-open, *before* extensions activate, so there is no activation event that guarantees the provider is registered in time for the first restore read. We mitigate with three layers: (a) `activationEvents: ["*"]` (eager activation — the strongest available; `onStartupFinished` is best-effort and still runs after restore); (b) on `activate()`, walk `window.tabGroups.all` and for any tab whose input is a `TabInputTextDiff` with `original.scheme === 'gitdiff'`, fire `GitShowProvider.onDidChange(uri)` so the pane re-reads via the now-registered provider; (c) on `deactivate()`, close any `gitdiff:` diff tabs so they aren't persisted into the next session. The combination means even on cold-start the user sees correct content within one re-render frame. |

## 5. Project Layout

```
gitdiff/
├── package.json              # extension manifest, commands, menus, capabilities
├── tsconfig.json
├── .vscodeignore
├── .vscode/
│   ├── launch.json           # F5 → Extension Development Host
│   └── tasks.json
├── icons/
│   ├── refresh.svg           # title-bar refresh icon (light + dark via theme color)
│   └── change-target.svg
├── src/
│   ├── extension.ts          # activate / deactivate / wiring
│   ├── gitService.ts         # all git CLI calls (execFile, NUL-separated)
│   ├── gitShowProvider.ts    # TextDocumentContentProvider for `gitdiff:`
│   ├── refPicker.ts          # QuickPick for branches & commits
│   ├── diffOpener.ts         # builds URIs, calls vscode.diff, sets tab title
│   ├── activeDiffTracker.ts  # maintains gitdiff.activeDiff context key
│   └── util/
│       ├── uri.ts            # gitdiff: encode/decode {ref, repoRoot, path}
│       ├── exec.ts           # promisified execFile wrapper
│       └── encoding.ts       # binary / non-UTF-8 detection
├── test/
│   └── suite/
│       ├── gitService.test.ts
│       ├── uri.test.ts
│       ├── encoding.test.ts
│       └── integration.test.ts
└── plan.md                   # this file
```

## 6. `package.json` Highlights

- `engines.vscode`: `^1.85.0` (provides `TabInputTextDiff` and the tab-groups API used by ActiveDiffTracker).
- `capabilities.virtualWorkspaces`: `false` (we require a local git binary and `file:` URIs).
- `capabilities.untrustedWorkspaces.supported`: `false` (we shell out to git).
- `activationEvents`: `["*"]` (eager activation). Tab restore happens before extension activation, and there is no activation event that fires for `TextDocumentContentProvider` URIs (`onCommand:*` is too late; `onFileSystem:` is for `FileSystemProvider`s only; `onStartupFinished` is best-effort and runs *after* restore). With eager activation plus the on-activate restore-sweep described in §4, we get the earliest possible provider registration and a defensive re-render of any tabs that beat us. We also clean up `gitdiff:` tabs in `deactivate()` so the restore problem is rare in practice.
- `contributes.commands`:
  - `gitdiff.compareWithBranch` — "Gitdiff: Compare with Branch…"
  - `gitdiff.compareWithCommit` — "Gitdiff: Compare with Commit…"
  - `gitdiff.refresh` — "Gitdiff: Refresh Diff" (icon: `$(refresh)`)
  - `gitdiff.changeTarget` — "Gitdiff: Change Target…" (icon: `$(git-compare)`)
- `contributes.menus`:
  - `commandPalette`:
    - `gitdiff.compareWithBranch`, `gitdiff.compareWithCommit`: `when: resourceScheme == file && !explorerResourceIsFolder` (also guarded in code).
    - `gitdiff.refresh`, `gitdiff.changeTarget`: `when: gitdiff.activeDiff` — hides them from the global palette unless a gitdiff diff is the active tab.
  - `explorer/context`:
    - Both compare commands, `when: resourceScheme == file && !explorerResourceIsFolder`.
  - `editor/title/context`:
    - Both compare commands, `when: resourceScheme == file`.
  - `editor/title`:
    - `gitdiff.refresh`, `gitdiff.changeTarget`, `when: gitdiff.activeDiff`, with `group: navigation` and `icon` set so they render as toolbar buttons.
- `contributes.configuration`:
  - `gitdiff.commitPickerLimit` (default 100)
  - `gitdiff.gitPath` (default empty → resolve `git` from PATH)

## 7. Implementation Milestones

### M1 — Skeleton (½ day)
- Scaffold extension with `yo code` template (TypeScript).
- Set `activationEvents: ["*"]` and `capabilities.virtualWorkspaces: false`.
- Wire `gitdiff.compareWithBranch` to a stub that opens `vscode.diff` with two dummy URIs (an in-memory `gitdiff:` doc on the left, the active editor's `file:` URI on the right). Verify the right pane is editable and saves to disk.
- Verify F5 launch works.

### M2 — URI codec + Git plumbing (1 day)
- `util/uri.ts` with `encode({ref, repoRoot, relPath}) → Uri` and `decode(Uri) → {...}`. Round-trip tests for `feature/x`, `origin/main`, paths with spaces/unicode, refs with `?` and `#`.
- `GitService.repoRoot`, `listBranchesLocal/Remote`, `listCommits` (NUL-parsed), `showFileAtRef`, `fileExistsAtRef`.
- Unit tests against a tmp repo created in `beforeAll`. Use `git init -b main` (with a fallback for older git: `git init && git symbolic-ref HEAD refs/heads/main`) so the default branch name is deterministic regardless of the host's `init.defaultBranch` setting. Seed two commits on `main`, a `feature/x` branch, and a file later deleted.

### M3 — Virtual left-pane (½ day)
- Implement `GitShowProvider` registered for the `gitdiff` scheme in `activate()`.
- Manually verify left pane shows correct content at chosen ref, and that reload restores the tab correctly.

### M4 — Pickers, commands, ActiveDiffTracker (1 day)
- Branch picker (local + remote, no `*/HEAD`), commit picker (with "Enter SHA…" and "Load more…").
- `ActiveDiffTracker` toggles the `gitdiff.activeDiff` context key.
- `gitdiff.refresh` and `gitdiff.changeTarget` operate on the active diff via `window.tabGroups.activeTabGroup.activeTab.input as TabInputTextDiff`.
- Both compare commands fully working end-to-end; right side editable, left side updates.

### M5 — Polish & edge cases (½ day)
- Tab title formatting (`<file> (vs <ref>)`, `(new vs <ref>)` when `fileExistsAtRef` is false).
- Title-bar icons rendering as toolbar buttons.
- Edge cases: file-not-at-ref, binary detection, non-UTF-8 encoding, non-`file:` editor guard, detached HEAD, no branches.
- Context-menu entries with `!explorerResourceIsFolder`.

### M6 — Tests + packaging (½ day)
- Integration test using `@vscode/test-electron`: invoke `gitdiff.compareWithBranch` and assert `window.tabGroups.activeTabGroup.activeTab.input` is a `TabInputTextDiff` whose `original` is a `gitdiff:` URI with the expected query and `modified` is the workspace file.
- `vsce package` produces a `.vsix` that installs cleanly.
- README with screenshots.

**Total: ~4 working days.**

## 8. Testing Strategy

- **Unit — gitService**: real temp repo in `os.tmpdir()`, initialised with `git init -b main` (fallback `git init && git symbolic-ref HEAD refs/heads/main` for git < 2.28) so the default branch is deterministic across hosts. Seeded with commits, branches, deletions, a binary file, a non-UTF-8 file. Covers ref lookup, NUL-parsed `log`, `cat-file -e` existence, multi-root via two tmp repos.
- **Unit — uri.ts**: round-trip `encode/decode` for refs (`feature/x`, `origin/main`, names with `?`/`#`/`&`/`%`), repo roots with spaces/unicode, paths with spaces.
- **Unit — encoding.ts**: binary-vs-text classification on fixtures (PNG bytes, UTF-8 text, UTF-16 text, latin-1 text).
- **Integration**: `@vscode/test-electron` launches the Extension Development Host, runs `gitdiff.compareWithBranch`, then asserts:
  - `window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputTextDiff`
  - `input.original.scheme === 'gitdiff'` and the decoded `{ref, repoRoot, relPath}` match the expectation.
  - `input.modified.scheme === 'file'` and equals the seeded workspace file URI.
  - Editing the modified document and saving writes through to disk.
  - We do **not** rely on `window.activeTextEditor` to verify the pair, since it only ever points to the focused side.
- **Manual smoke**: matrix of {branch, commit, missing-file at ref, deleted in WT, binary, non-UTF-8, multi-root, submodule, detached HEAD, restored tab after reload}.

## 9. Open Questions (please confirm before M1)

1. **Minimum VSCode version** — `^1.85.0` works for `TabInputTextDiff`; bump higher if you need a feature added later.
2. **Right-side scope** — confirm v1 is "currently active editor file only" (not a folder diff).
3. **Remote branches** — include local + remote-tracking branches in the picker (excluding `*/HEAD`), or local only?
4. **Authoring** — publisher name & display name for `package.json` (`tigercosmos`?).
5. **Marketplace** — publish to the VSCode Marketplace, or keep it as a local `.vsix`?
6. **Virtual workspaces** — confirmed off-scope for v1 (declared via `capabilities.virtualWorkspaces: false`)?

---

Once you've reviewed and answered the open questions, I'll start at **M1**.
