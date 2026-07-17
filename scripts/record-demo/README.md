# Recording `demo/demo.gif`

Scripts that regenerate the README demo GIF by driving GitDiff in a throwaway VS
Code Extension Development Host and screen-recording it. macOS only.

## Files

| File | Purpose |
|---|---|
| `setup-demo-repo.sh` | Builds a throwaway git repo (5 commits, varied authors/PR subjects, a `release` branch, uncommitted edits + an untracked file) so every feature has real content. |
| `record-demo.sh` | End-to-end orchestrator: build → demo repo → launch Dev Host → **fullscreen** → prep clean state → record → drive → `ffmpeg` → `demo/demo.gif`. |
| `drive.sh` | The choreography (cliclick + System Events) that walks all 12 features. Coordinates are for a fullscreen 1920×1080 window at **`window.zoomLevel: 2`**; edit the vars near the top if you change the zoom/resolution. |

## One-time setup

```bash
brew install cliclick ffmpeg
```

Grant your terminal app both **Screen Recording** and **Accessibility** in
System Settings → Privacy & Security.

## Run

```bash
scripts/record-demo/record-demo.sh
```

That's it — it fullscreens the Dev Host, records ~90s, and overwrites
`demo/demo.gif` (1280px wide, 10 fps, ~5–6 MB).

**Resolution:** the UI runs at `window.zoomLevel: 2` so text is large in the
recording, and the frame is cropped to the top `CROP_H` px (drops the empty lower
half) before a gentle downscale to `GIF_WIDTH`. Recording a 1920px window and
scaling hard to <1000px makes the font unreadable — keep the zoom up and the
downscale mild. Tune `GIF_WIDTH` / `CROP_H` for the size↔crispness tradeoff.

## Features exercised (choreography order)

1. Current-line blame (dim end-of-line annotation) as the cursor moves
2. Blame on hover (author/date/subject/SHA + commit & PR links)
3. Compare with Branch… → `release` (side-by-side diff opens)
4. Blame in the diff's working-tree pane
5. Editable right pane — type a line and save
6. Changed-Files sidebar + Set Comparison Target…
7. Click through changed files (active-file highlight follows)
8. Sidebar content search + `files to include` glob
9. Revert a file to target (guarded confirmation)
10. Type a target directly → `HEAD~2` (Change Target…)
11. Refresh (re-resolve branch tips)
12. Clear Comparison Target

## Gotchas (why the scripts are shaped this way)

- **`--user-data-dir` must be short** (`/private/tmp/gdd`): VS Code's IPC socket
  path must be < 103 chars or launch fails with `IPC handle ... too long`.
- **Launch with `open -n -a "Visual Studio Code"`** — the `code` shim routes into
  a running instance; the raw `Electron` binary's window crashes.
- **Fullscreen the window.** On Macs with "Displays have separate Spaces" on, a
  fresh window can open on a background Space that `screencapture` can't capture.
  Fullscreen gives it a dedicated Space that captures reliably and won't drift
  when focus changes. Set `RECORD_DISPLAY` to the display it lands on.
- **A file editor must be active** before `Compare with Branch…` — that command is
  hidden from the palette otherwise. `record-demo.sh` opens `app.ts` first and
  `drive.sh` never closes it before the file-dependent steps.
- **macOS ships bash 3.2** — no associative arrays; the scripts avoid them.
- Waits in `drive.sh` are deliberately generous to absorb screen-recording lag.

## Knobs (env vars)

`REPO_ROOT`, `DEMO_DIR`, `PROFILE`, `OUT_GIF`, `RECORD_DISPLAY`, `GIF_WIDTH`,
`GIF_FPS`. Per-step coordinates/timings live at the top of `drive.sh`.
