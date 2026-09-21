import { strict as assert } from 'assert';
import { planAllChanges } from '../../src/allChanges';
import type { ChangedFile } from '../../src/changedFilesProvider';

const REPO = '/repo';
const file = (relPath: string, status: ChangedFile['status'], origPath?: string): ChangedFile => ({
  relPath,
  absPath: `${REPO}/${relPath}`,
  status,
  ...(origPath ? { origPath } : {}),
});

describe('planAllChanges', () => {
  it('gives a modified file both sides, pinned to the target sha', () => {
    const [entry] = planAllChanges([file('a.ts', 'M')], { ref: 'abc', branch: 'main' }, REPO);
    assert.deepEqual(entry, {
      absPath: '/repo/a.ts',
      hasRight: true,
      left: { ref: 'abc', repoRoot: REPO, relPath: 'a.ts', branch: 'main' },
    });
  });

  it('leaves out the target side for added and untracked files', () => {
    const entries = planAllChanges([file('n.ts', 'A'), file('u.ts', '?')], { ref: 'abc' }, REPO);
    assert.deepEqual(
      entries.map((e) => [e.left, e.hasRight]),
      [
        [undefined, true],
        [undefined, true],
      ],
    );
  });

  it('leaves out the working-tree side for a deleted file', () => {
    const [entry] = planAllChanges([file('gone.ts', 'D')], { ref: 'abc' }, REPO);
    assert.equal(entry.hasRight, false);
    assert.equal(entry.left?.relPath, 'gone.ts');
  });

  it('reads a renamed file from its old path at the target', () => {
    const [entry] = planAllChanges([file('new.ts', 'R', 'old.ts')], { ref: 'abc' }, REPO);
    assert.equal(entry.left?.relPath, 'old.ts');
    assert.equal(entry.absPath, '/repo/new.ts');
  });
});
