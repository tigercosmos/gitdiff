/**
 * Result of classifying a blob from `git show`.
 * - `text`: UTF-8 decodable, no NULs in the sniff window.
 * - `binary`: contains NUL bytes in the first ~8KB.
 * - `nonUtf8`: no NULs but UTF-8 strict decode failed (likely UTF-16/latin-1).
 */
export type BlobKind = 'text' | 'binary' | 'nonUtf8';

const SNIFF_BYTES = 8 * 1024;

export function classifyBlob(buf: Buffer): BlobKind {
  const head = buf.subarray(0, Math.min(buf.length, SNIFF_BYTES));
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0) return 'binary';
  }
  // No NULs — try strict UTF-8.
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(buf);
    return 'text';
  } catch {
    return 'nonUtf8';
  }
}
