import * as assert from 'assert';
import {
  AUTO_DEFAULT_TARGETS,
  defaultTargetCandidates,
  lookupDefaultTarget,
  resolveDefaultTarget,
} from '../../src/defaultTarget';

/** A repo whose refs are `refs` (name → SHA); every name in `branches` is a branch. */
function fakeGit(
  refs: Record<string, string>,
  branches: string[] = Object.keys(refs),
  originHead?: string,
) {
  return {
    remoteHead: async (): Promise<string | undefined> => originHead,
    verifyRef: async (_root: string, name: string): Promise<string> => {
      const sha = refs[name];
      if (!sha) throw new Error(`'${name}' is not a valid revision`);
      return sha;
    },
    isBranch: async (_root: string, name: string): Promise<boolean> => branches.includes(name),
  };
}

const MAIN = 'a'.repeat(40);
const MASTER = 'b'.repeat(40);
const DEVELOP = 'c'.repeat(40);

describe('defaultTargetCandidates', () => {
  it('tries origin/main, then origin/master, when the setting is empty', () => {
    assert.deepStrictEqual(AUTO_DEFAULT_TARGETS, ['origin/main', 'origin/master']);
    assert.deepStrictEqual(defaultTargetCandidates(''), ['origin/main', 'origin/master']);
    assert.deepStrictEqual(defaultTargetCandidates('   '), ['origin/main', 'origin/master']);
    assert.deepStrictEqual(defaultTargetCandidates(undefined), ['origin/main', 'origin/master']);
    assert.deepStrictEqual(defaultTargetCandidates(42), ['origin/main', 'origin/master']);
  });

  it('uses only the typed name when the setting is set', () => {
    assert.deepStrictEqual(defaultTargetCandidates(' upstream/develop '), ['upstream/develop']);
    assert.deepStrictEqual(
      defaultTargetCandidates('upstream/develop', 'origin/trunk'),
      ['upstream/develop'],
    );
  });

  it('tries the branch origin/HEAD points at first, without duplicates', () => {
    assert.deepStrictEqual(defaultTargetCandidates('', 'origin/master'), [
      'origin/master',
      'origin/main',
    ]);
    assert.deepStrictEqual(defaultTargetCandidates('', 'origin/trunk'), [
      'origin/trunk',
      'origin/main',
      'origin/master',
    ]);
  });
});

describe('resolveDefaultTarget', () => {
  it('prefers origin/main over origin/master', async () => {
    const git = fakeGit({ 'origin/main': MAIN, 'origin/master': MASTER });
    const picked = await resolveDefaultTarget(git, '/repo', AUTO_DEFAULT_TARGETS);
    assert.deepStrictEqual(picked, { ref: MAIN, display: 'origin/main', branch: 'origin/main' });
  });

  it('falls back to origin/master', async () => {
    const git = fakeGit({ 'origin/master': MASTER });
    const picked = await resolveDefaultTarget(git, '/repo', AUTO_DEFAULT_TARGETS);
    assert.strictEqual(picked?.display, 'origin/master');
    assert.strictEqual(picked?.ref, MASTER);
  });

  it('returns undefined when nothing resolves', async () => {
    const git = fakeGit({});
    assert.strictEqual(await resolveDefaultTarget(git, '/repo', AUTO_DEFAULT_TARGETS), undefined);
  });

  it('pins a non-branch ref (tag, SHA) without branch semantics', async () => {
    const git = fakeGit({ 'v1.0': DEVELOP }, []);
    const picked = await resolveDefaultTarget(git, '/repo', ['v1.0']);
    assert.deepStrictEqual(picked, { ref: DEVELOP, display: 'v1.0' });
  });
});

describe('lookupDefaultTarget', () => {
  it('follows origin/HEAD when both origin/main and origin/master exist', async () => {
    const git = fakeGit({ 'origin/main': MAIN, 'origin/master': MASTER }, undefined, 'origin/master');
    assert.deepStrictEqual(await lookupDefaultTarget(git, '/repo', ''), {
      kind: 'found',
      picked: { ref: MASTER, display: 'origin/master', branch: 'origin/master' },
    });
  });

  it('falls back to origin/main when reading origin/HEAD fails', async () => {
    const git = fakeGit({ 'origin/main': MAIN, 'origin/master': MASTER });
    git.remoteHead = async () => {
      throw new Error('git crashed');
    };
    const found = await lookupDefaultTarget(git, '/repo', undefined);
    assert.strictEqual(found?.kind === 'found' && found.picked.display, 'origin/main');
  });

  it('uses the name typed in the setting, ignoring origin/HEAD', async () => {
    let askedHead = false;
    const git = fakeGit({ 'origin/main': MAIN, develop: DEVELOP }, undefined, 'origin/main');
    git.remoteHead = async () => {
      askedHead = true;
      return 'origin/main';
    };
    const found = await lookupDefaultTarget(git, '/repo', ' develop ');
    assert.deepStrictEqual(found, {
      kind: 'found',
      picked: { ref: DEVELOP, display: 'develop', branch: 'develop' },
    });
    assert.strictEqual(askedHead, false);
  });

  it('reports a typed name that does not resolve', async () => {
    const git = fakeGit({ 'origin/main': MAIN });
    assert.deepStrictEqual(await lookupDefaultTarget(git, '/repo', 'orgin/main'), {
      kind: 'missing',
      name: 'orgin/main',
    });
  });

  // A repo with no remote and an empty setting is normal: no row, no warning.
  it('finds nothing, without a warning, when the setting is empty and no remote exists', async () => {
    assert.strictEqual(await lookupDefaultTarget(fakeGit({}), '/repo', ''), undefined);
  });
});
