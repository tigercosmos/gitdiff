#!/usr/bin/env bash
# Session driver — fullscreen Dev Host on display 1 (1920x1080).
# PRECONDITION (caller ensures): app.ts open + active, NO comparison target set.
# Robust to screen-recording lag: generous waits, never closes the active file
# before the file-dependent commands run.
set -uo pipefail

k () { osascript -e "tell application \"System Events\" to $1" >/dev/null 2>&1; }
t () { osascript -e "tell application \"System Events\" to keystroke \"$1\"" >/dev/null 2>&1; }
enter () { k "key code 36"; }
click () { cliclick "c:$1,$2" >/dev/null 2>&1; }
hover () { cliclick "m:$1,$2" >/dev/null 2>&1; }
away () { cliclick m:960,760 >/dev/null 2>&1; }
pal () { click 960 540; sleep 0.5; k "keystroke \"p\" using {command down, shift down}"; sleep 1.0; t "$1"; sleep 1.8; enter; sleep 1.4; }
save () { k "keystroke \"s\" using {command down}"; }

# Coordinates for a FULLSCREEN 1920x1080 window at window.zoomLevel 2.
line_y () { echo $((81 + $1*29)); }
CODE_X=560
RIGHT_X=1400
ROW_X=135
ROW_APP=304; ROW_CONFIG=331; ROW_UTILS=415
SEARCH_XY="150 122"; INCLUDE_XY="150 162"
REVERT_X=400

echo "== 1 current-line blame =="
click $CODE_X $(line_y 5); sleep 1.6
click $CODE_X $(line_y 6); sleep 1.6

echo "== 2 hover blame =="
hover $CODE_X $(line_y 5); sleep 3.0
away; sleep 0.5

echo "== 3 compare with branch -> release =="
pal "GitDiff: Compare with Branch"
t "release"; sleep 1.8; enter; sleep 3.0

echo "== 4 blame in the diff (working-tree pane) =="
click $RIGHT_X $(line_y 6); sleep 1.4
hover $RIGHT_X $(line_y 6); sleep 3.0
away; sleep 0.5

echo "== 5 edit the right pane + save =="
click $RIGHT_X $(line_y 8); sleep 0.6; k "key code 124 using {command down}"; sleep 0.3
enter; sleep 0.3; t "// tweaked live — still editable"; sleep 1.6
save; sleep 1.6

echo "== 6 open sidebar + set target -> release =="
pal "GitDiff: Focus on Changed Files View"; sleep 0.6
pal "GitDiff: Set Comparison Target"
t "release"; sleep 1.8; enter; sleep 2.5

echo "== 7 click through changed files (active highlight follows) =="
click $ROW_X $ROW_CONFIG; sleep 2.2
click $ROW_X $ROW_UTILS; sleep 2.2

echo "== 8 search + path filters =="
click $SEARCH_XY; sleep 0.6; t "sum"; sleep 2.2
k "key code 51"; k "key code 51"; k "key code 51"; sleep 1.0
click $INCLUDE_XY; sleep 0.6; t "*.ts"; sleep 2.2
click $INCLUDE_XY; sleep 0.3; for _ in 1 2 3 4; do k "key code 51"; done; sleep 1.2

echo "== 9 revert a file to target (guarded) =="
hover $ROW_X $ROW_CONFIG; sleep 1.0
click $REVERT_X $ROW_CONFIG; sleep 1.6
enter; sleep 2.2

echo "== 10 type a target directly -> HEAD~2 =="
click $ROW_X $ROW_APP; sleep 1.6
pal "GitDiff: Change Target"
t "HEAD~2"; sleep 1.6; enter; sleep 1.2; enter; sleep 2.8

echo "== 11 refresh =="
pal "GitDiff: Refresh Diff"; sleep 1.6

echo "== 12 clear comparison target =="
pal "GitDiff: Clear Comparison Target"; sleep 2.0
echo "== done =="
