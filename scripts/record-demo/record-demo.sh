#!/usr/bin/env bash
#
# record-demo.sh — regenerate demo/demo.gif by driving GitDiff in a throwaway VS
# Code Extension Development Host and screen-recording it. macOS only. This is the
# PROVEN flow: it fullscreens the Dev Host (giving it a dedicated Space that won't
# drift), records that display, and drives the UI with cliclick + System Events.
#
# ─────────────────────────────────────────────────────────────────────────────
# REQUIREMENTS
#   brew install cliclick ffmpeg
#   Grant the controlling terminal BOTH (System Settings → Privacy & Security):
#     • Screen Recording   (screencapture -v)
#     • Accessibility      (cliclick + System Events)
#
# WHY THE FLOW LOOKS LIKE THIS (lessons learned — see README.md)
#   - --user-data-dir MUST be short (< 103-char IPC socket limit): /private/tmp/gdd.
#   - Launch with `open -n -a "Visual Studio Code"` (the `code` shim routes into a
#     running instance; the raw Electron binary's window crashes).
#   - FULLSCREEN the window (Ctrl+Cmd+F). It then owns a dedicated Space that
#     `screencapture -D` captures reliably and that doesn't drift when focus moves.
#     This sidesteps the "new window lands on a background Space" problem on Macs
#     with "Displays have separate Spaces" on.
#   - File-dependent commands ("Compare with Branch") are HIDDEN from the palette
#     when no file editor is active — so app.ts is opened+activated before them and
#     is never closed mid-run. Waits are generous to absorb screen-recording lag.
#
# USAGE
#   scripts/record-demo/record-demo.sh
#   RECORD_DISPLAY=2 scripts/record-demo/record-demo.sh   # record a different display
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$HERE/../.." && pwd)}"
DEMO_DIR="${DEMO_DIR:-/private/tmp/gitdiff-demo}"
PROFILE="${PROFILE:-/private/tmp/gdd}"          # short path — IPC socket limit
OUT_GIF="${OUT_GIF:-$REPO_ROOT/demo/demo.gif}"
RECORD_DISPLAY="${RECORD_DISPLAY:-1}"
GIF_WIDTH="${GIF_WIDTH:-1280}"
GIF_FPS="${GIF_FPS:-10}"
TRIM_START="${TRIM_START:-6.5}"   # seconds trimmed off the front (idle intro before driving)
# Crop the recorded 1920x1080 frame to the content region (drops the empty lower
# half so the content isn't tiny in-frame). Full width, top CROP_H px.
CROP_W="${CROP_W:-1920}"; CROP_H="${CROP_H:-600}"; CROP_X="${CROP_X:-0}"; CROP_Y="${CROP_Y:-0}"
RAW="$PROFILE/raw.mov"

say () { printf '\033[36m▶ %s\033[0m\n' "$*"; }
k () { osascript -e "tell application \"System Events\" to $1" >/dev/null 2>&1; }
t () { osascript -e "tell application \"System Events\" to keystroke \"$1\"" >/dev/null 2>&1; }
enter () { k "key code 36"; }
palrun () { cliclick c:960,540 >/dev/null 2>&1; sleep 0.4; k "keystroke \"p\" using {command down, shift down}"; sleep 0.9; t "$1"; sleep 1.5; enter; sleep 1.2; }

devhost_windows () { osascript -e 'tell application "System Events" to get name of windows of (every process whose name is "Code" or name is "Electron")' 2>/dev/null; }
devhost_fullscreen () {  # AXFullScreen state of the Dev Host window, or NOTFOUND
  osascript <<'AS' 2>/dev/null
tell application "System Events"
  repeat with p in (every process whose name is "Code" or name is "Electron")
    try
      repeat with w in (windows of p)
        try
          if (name of w) contains "Extension Development Host" then return (value of attribute "AXFullScreen" of w) as string
        end try
      end repeat
    end try
  end repeat
  return "NOTFOUND"
end tell
AS
}

# ---- 1. build + demo repo + profile ----------------------------------------
say "Building dev bundle"; ( cd "$REPO_ROOT" && npm run build:dev >/dev/null 2>&1 )
say "Creating demo repo at $DEMO_DIR"; DEMO_DIR="$DEMO_DIR" bash "$HERE/setup-demo-repo.sh" >/dev/null
say "Preparing isolated profile at $PROFILE"
pkill -f "user-data-dir=$PROFILE/u" 2>/dev/null || true; sleep 2
rm -rf "$PROFILE/u" "$PROFILE/e"; mkdir -p "$PROFILE/u/User" "$PROFILE/e"
cat > "$PROFILE/u/User/settings.json" <<'EOF'
{
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.startupEditor": "none",
  "editor.fontSize": 14,
  "editor.lineHeight": 20,
  "editor.minimap.enabled": false,
  "editor.cursorBlinking": "solid",
  "breadcrumbs.enabled": false,
  "window.commandCenter": false,
  "window.menuBarVisibility": "compact",
  "window.restoreWindows": "none",
  "window.zoomLevel": 2,
  "chat.commandCenter.enabled": false,
  "security.workspace.trust.enabled": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "git.openRepositoryInParentFolders": "always",
  "gitdiff.lineBlame.enabled": true
}
EOF

# ---- 2. launch + fullscreen -------------------------------------------------
say "Launching Extension Development Host"
open -n -a "Visual Studio Code" --args \
  --user-data-dir="$PROFILE/u" --extensions-dir="$PROFILE/e" \
  --extensionDevelopmentPath="$REPO_ROOT" --new-window \
  "$DEMO_DIR" "$DEMO_DIR/src/app.ts"
for i in $(seq 1 30); do sleep 1; devhost_windows | grep -q "Extension Development Host" && break; [ "$i" = 30 ] && { echo "window never appeared"; exit 1; }; done
sleep 3
say "Fullscreen (Ctrl+Cmd+F) → dedicated Space"
k "key code 3 using {control down, command down}"; sleep 3     # f=3
k "key code 53"; sleep 0.3; k "key code 53"; sleep 0.5         # dismiss any Copilot welcome modal
cliclick c:960,540 >/dev/null 2>&1; sleep 0.3
k "key code 11 using {command down, option down}"; sleep 0.8   # close secondary side bar (chat)
[ "$(devhost_fullscreen)" = "true" ] || echo "WARNING: window not fullscreen; check RECORD_DISPLAY/geometry"

# ---- 3. prep clean state (not recorded) -------------------------------------
say "Prepping clean state"
palrun "GitDiff: Clear Comparison Target"
palrun "Remove All Breakpoints"
palrun "View: Close All Editors"; sleep 0.5
palrun "Go to File"; t "app.ts"; sleep 1.2; enter; sleep 1.5
sleep 1

# ---- 4. record + drive ------------------------------------------------------
say "Recording display $RECORD_DISPLAY"
rm -f "$RAW"; screencapture -v -D "$RECORD_DISPLAY" -x "$RAW" & REC=$!
trap 'kill -INT "$REC" 2>/dev/null || true' EXIT
sleep 2
bash "$HERE/drive.sh"
sleep 1
say "Stopping recording"; kill -INT "$REC" 2>/dev/null || true; trap - EXIT
for i in $(seq 1 20); do sleep 0.5; kill -0 "$REC" 2>/dev/null || break; done
sleep 1

# ---- 5. convert to gif ------------------------------------------------------
say "Converting to $OUT_GIF"
PAL="$PROFILE/palette.png"
VF="crop=${CROP_W}:${CROP_H}:${CROP_X}:${CROP_Y},fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos"
ffmpeg -y -ss "$TRIM_START" -i "$RAW" -vf "${VF},palettegen=stats_mode=diff" "$PAL" >/dev/null 2>&1
ffmpeg -y -ss "$TRIM_START" -i "$RAW" -i "$PAL" -lavfi "${VF}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" "$OUT_GIF" >/dev/null 2>&1
say "Done: $OUT_GIF"; ls -la "$OUT_GIF"
say "Closing Dev Host"; pkill -f "user-data-dir=$PROFILE/u" 2>/dev/null || true
