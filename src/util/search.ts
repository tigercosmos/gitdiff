export interface SearchOptions {
  query: string;
  matchCase: boolean;
  matchWholeWord: boolean;
  useRegex: boolean;
}

export interface CompiledSearch {
  /** Regex ready to test() against multi-line file content. */
  regex: RegExp;
}

/**
 * Compile the Search input + modifier toggles into a RegExp, matching the
 * semantics of VSCode's built-in Search:
 *
 *  - useRegex off: input is escaped, treated as literal text.
 *  - useRegex on : input is used as a regex source.
 *  - matchWholeWord on: input is wrapped in `\b...\b` *after* escape/parse,
 *    so `\b` is added at the boundary regardless of which flag is on.
 *  - matchCase off: case-insensitive flag added.
 *
 * Returns `{ error }` when useRegex is on and the pattern doesn't parse, so
 * the caller can surface the message to the user (as VSCode Search does).
 */
export function compileSearch(
  opts: SearchOptions,
): CompiledSearch | { error: string } | undefined {
  const q = opts.query;
  if (!q) return undefined;

  let body = opts.useRegex ? q : escapeRegex(q);
  if (opts.matchWholeWord) {
    // Use lookarounds rather than `\b` so queries that start or end with a
    // non-word character (`.env`, `C++`, `foo.`) still match standalone —
    // `\b` only fires at a word/non-word transition, so it never matches
    // before `.` or after `+`. The non-capturing group is required so the
    // boundaries bind to the whole pattern, not just the first/last
    // alternative (e.g. `foo|bar`).
    body = `(?<!\\w)(?:${body})(?!\\w)`;
  }
  // `m` so `^`/`$` work line-by-line; `i` when matchCase is off.
  const flags = opts.matchCase ? 'm' : 'mi';
  try {
    return { regex: new RegExp(body, flags) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
