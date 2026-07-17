#!/usr/bin/env bash
#
# setup-demo-repo.sh — build a throwaway git repo whose history + working tree
# exercise every GitDiff feature, so the recorded demo has something real to show.
#
# Output: a repo at $DEMO_DIR (default below) containing
#   - 5 commits on `main` with varied authors, dates, and PR-numbered subjects
#     (so current-line blame + hover blame show different people, and the
#      commit/PR web links resolve from the subject via detectPullRequest())
#   - a `release` branch pinned at commit #2 (so a working-tree-vs-release diff
#     touches many files)
#   - a GitHub remote (so blame-hover renders "view commit"/"pull request" links)
#   - uncommitted working-tree edits + one untracked file (so the changed-files
#     sidebar, editable pane, and revert all have live content)
#
# Usage: DEMO_DIR=/tmp/gitdiff-demo ./setup-demo-repo.sh
set -euo pipefail

DEMO_DIR="${DEMO_DIR:-/private/tmp/gitdiff-demo}"

rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR/src"
cd "$DEMO_DIR"

git init -q -b main
git config user.email "dev@acme.dev"
git config user.name "Dev"
git config core.autocrlf false
git remote add origin https://github.com/acme/widget.git

commit () { # $1=iso-date  $2=author  $3=email  $4=message
  GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" \
  GIT_AUTHOR_NAME="$2" GIT_AUTHOR_EMAIL="$3" \
  GIT_COMMITTER_NAME="$2" GIT_COMMITTER_EMAIL="$3" \
  git commit -q -m "$4"
}

# ---- Commit 1: scaffold (Ada) ----
cat > README.md <<'EOF'
# Widget

A small widget library.

## Usage

```ts
import { greet } from "./src/app";
greet("world");
```
EOF
cat > src/app.ts <<'EOF'
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
EOF
cat > src/utils.ts <<'EOF'
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
EOF
git add -A
commit "2025-01-06T09:12:00" "Ada Lovelace" "ada@acme.dev" "Initial widget scaffold (#12)"

# ---- Commit 2: greeting options (Grace) — `release` will sit here ----
cat > src/app.ts <<'EOF'
export interface GreetOptions {
  shout?: boolean;
}

export function greet(name: string, opts: GreetOptions = {}): string {
  const msg = `Hello, ${name}!`;
  return opts.shout ? msg.toUpperCase() : msg;
}
EOF
git add -A
commit "2025-02-14T14:03:00" "Grace Hopper" "grace@acme.dev" "Add shout option to greet (#27)"

git branch release   # release := state after commit #2

# ---- Commit 3: math helpers (Alan) ----
cat > src/utils.ts <<'EOF'
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : sum(xs) / xs.length;
}
EOF
git add -A
commit "2025-03-30T11:47:00" "Alan Turing" "alan@acme.dev" "Add sum and mean helpers (#41)"

# ---- Commit 4: styling + docs (Grace) ----
cat > src/styles.css <<'EOF'
.widget {
  font-family: system-ui, sans-serif;
  padding: 8px 12px;
  border-radius: 8px;
}
EOF
cat > README.md <<'EOF'
# Widget

A small, friendly widget library.

## Usage

```ts
import { greet } from "./src/app";
greet("world", { shout: true });
```

## Helpers

- `clamp(n, lo, hi)`
- `sum(xs)`
- `mean(xs)`
EOF
git add -A
commit "2025-05-19T16:31:00" "Grace Hopper" "grace@acme.dev" "Polish README and add widget styles (#58)"

# ---- Commit 5: config module (Ada) ----
cat > src/config.ts <<'EOF'
export interface Config {
  locale: string;
  retries: number;
}

export const defaultConfig: Config = {
  locale: "en-US",
  retries: 3,
};
EOF
git add -A
commit "2025-06-24T10:05:00" "Ada Lovelace" "ada@acme.dev" "Introduce config module (#73)"

# ---- Uncommitted working-tree edits (what the demo diffs / edits / reverts) ----
cat > src/app.ts <<'EOF'
export interface GreetOptions {
  shout?: boolean;
}

export function greet(name: string, opts: GreetOptions = {}): string {
  const msg = `Hello, ${name}!`;
  return opts.shout ? msg.toUpperCase() : msg;
}

export function farewell(name: string): string {
  return `Goodbye, ${name}. See you soon!`;
}
EOF
cat > src/utils.ts <<'EOF'
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : sum(xs) / xs.length;
}

export function max(xs: number[]): number {
  return xs.reduce((a, b) => (b > a ? b : a), -Infinity);
}
EOF
cat > src/config.ts <<'EOF'
export interface Config {
  locale: string;
  retries: number;
}

export const defaultConfig: Config = {
  locale: "en-US",
  retries: 5,
};
EOF
# brand-new untracked file (shows as an addition vs the target)
cat > src/logger.ts <<'EOF'
export function log(msg: string): void {
  console.log(`[widget] ${msg}`);
}
EOF

echo "Demo repo ready at: $DEMO_DIR"
git --no-pager log --oneline --decorate
echo "--- working tree ---"
git --no-pager status --short
