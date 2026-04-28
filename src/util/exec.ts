import { execFile, ExecFileOptions } from 'child_process';

export interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  /** Exit code; -1 if the process failed to spawn. */
  code: number;
}

export class ExecError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly stderr: string,
    public readonly args: readonly string[],
  ) {
    super(message);
    this.name = 'ExecError';
  }
}

export function execGit(
  gitPath: string,
  args: readonly string[],
  cwd: string,
  options: { allowNonZero?: boolean; maxBuffer?: number } = {},
): Promise<ExecResult> {
  const opts: ExecFileOptions = {
    cwd,
    maxBuffer: options.maxBuffer ?? 50 * 1024 * 1024,
    encoding: 'buffer',
    windowsHide: true,
  };
  return new Promise((resolve, reject) => {
    execFile(gitPath, [...args], opts, (err, stdout, stderr) => {
      const out = stdout as unknown as Buffer;
      const errBuf = stderr as unknown as Buffer;

      if (err) {
        const e = err as NodeJS.ErrnoException & { code?: number | string };
        // Spawn failure (e.g. ENOENT) — string code; always reject.
        if (typeof e.code === 'string') {
          reject(
            new ExecError(
              `git ${args.join(' ')} failed: ${e.message}`,
              -1,
              errBuf.toString('utf8'),
              args,
            ),
          );
          return;
        }
        // Non-zero exit — numeric code on the Error.
        const exit = typeof e.code === 'number' ? e.code : 1;
        if (options.allowNonZero) {
          resolve({ stdout: out, stderr: errBuf, code: exit });
          return;
        }
        reject(
          new ExecError(
            `git ${args.join(' ')} failed: ${errBuf.toString('utf8').trim() || err.message}`,
            exit,
            errBuf.toString('utf8'),
            args,
          ),
        );
        return;
      }
      resolve({ stdout: out, stderr: errBuf, code: 0 });
    });
  });
}
