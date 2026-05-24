import * as M from 'minimatch';

export interface GlobMatcher {
  test(repoRelPath: string): boolean;
}

type IMinimatch = InstanceType<typeof M.Minimatch>;

/**
 * Compile a VSCode-Search-style comma-separated pattern list into a matcher.
 *
 * Sugar (matches the VSCode Search inputs the user is mirroring):
 *  - bare segment without `/` or `*` (e.g. `node_modules`) → match anywhere
 *    in the tree (`{name,**\/name,name/**,**\/name/**}`)
 *  - trailing `/` (e.g. `src/`) → everything under that folder (`src/**`)
 *  - patterns containing `/` or `*` are used as-is (so `**\/*.ts`, `*.md`,
 *    `src/**\/*.test.ts` all behave like the user expects)
 *
 * Returns undefined when the input is empty, so callers can short-circuit
 * (no matcher == no filter).
 */
export function compilePatterns(input: string | undefined): GlobMatcher | undefined {
  if (!input) return undefined;
  const patterns = splitTopLevelCommas(input)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (patterns.length === 0) return undefined;

  const matchers: IMinimatch[] = [];
  for (const raw of patterns) {
    const expanded = expandPattern(raw);
    try {
      // matchBase: a pattern that contains no slashes (e.g. `*.ts`) also
      // matches against the basename of every multi-segment path. VSCode's
      // Search treats `*.ts` and `**/*.ts` the same — without this, slashless
      // wildcard patterns silently miss everything under a subdirectory.
      matchers.push(new M.Minimatch(expanded, { dot: true, nocomment: true, matchBase: true }));
    } catch {
      // Skip patterns minimatch can't parse rather than poisoning the whole list.
    }
  }
  if (matchers.length === 0) return undefined;
  return {
    test(p: string): boolean {
      for (const m of matchers) {
        if (m.match(p)) return true;
      }
      return false;
    },
  };
}

/**
 * Split on commas only at the *top* level — commas inside `{a,b}` brace
 * alternation are part of the glob and must not be treated as pattern
 * separators. Without this, `*.{ts,tsx}` would split into `*.{ts` and `tsx}`
 * and silently match nothing. Backslashes escape the next character.
 */
export function splitTopLevelCommas(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\\' && i + 1 < input.length) {
      cur += ch + input[++i];
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function expandPattern(pattern: string): string {
  let p = pattern;
  // `src/` → everything inside src
  if (p.endsWith('/')) {
    return p + '**';
  }
  // Bare segment like `node_modules` or `README.md` — match anywhere.
  if (!p.includes('/') && !p.includes('*') && !p.includes('?')) {
    return `{${p},**/${p},${p}/**,**/${p}/**}`;
  }
  return p;
}
