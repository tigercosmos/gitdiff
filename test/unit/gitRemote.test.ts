import * as assert from 'assert';
import {
  buildCommitUrl,
  buildPrUrl,
  detectPullRequest,
  parseRemoteWebBase,
} from '../../src/util/gitRemote';

describe('parseRemoteWebBase', () => {
  it('parses an https URL and strips the .git suffix', () => {
    assert.deepStrictEqual(parseRemoteWebBase('https://github.com/owner/repo.git'), {
      host: 'github.com',
      base: 'https://github.com/owner/repo',
    });
  });

  it('parses the SCP-like ssh form', () => {
    assert.deepStrictEqual(parseRemoteWebBase('git@github.com:owner/repo.git'), {
      host: 'github.com',
      base: 'https://github.com/owner/repo',
    });
  });

  it('parses an ssh:// URL with a user and port', () => {
    assert.deepStrictEqual(parseRemoteWebBase('ssh://git@gitlab.com:22/group/sub/repo.git'), {
      host: 'gitlab.com',
      base: 'https://gitlab.com/group/sub/repo',
    });
  });

  it('handles a trailing slash and missing .git', () => {
    assert.deepStrictEqual(parseRemoteWebBase('https://bitbucket.org/owner/repo/'), {
      host: 'bitbucket.org',
      base: 'https://bitbucket.org/owner/repo',
    });
  });

  it('keeps a nested GitLab group path', () => {
    assert.deepStrictEqual(parseRemoteWebBase('git@gitlab.example.com:a/b/c.git'), {
      host: 'gitlab.example.com',
      base: 'https://gitlab.example.com/a/b/c',
    });
  });

  it('lower-cases the host', () => {
    assert.strictEqual(parseRemoteWebBase('git@GitHub.com:O/R.git')?.host, 'github.com');
  });

  it('returns undefined for unrecognised / local inputs', () => {
    assert.strictEqual(parseRemoteWebBase(''), undefined);
    assert.strictEqual(parseRemoteWebBase('   '), undefined);
    assert.strictEqual(parseRemoteWebBase('/local/path/repo.git'), undefined);
    assert.strictEqual(parseRemoteWebBase('git@github.com:'), undefined);
  });

  it('returns undefined for non-web URL schemes (file://, ftp://)', () => {
    assert.strictEqual(parseRemoteWebBase('file://server/share/repo.git'), undefined);
    assert.strictEqual(parseRemoteWebBase('ftp://host/path/repo.git'), undefined);
  });

  it('still accepts git:// remotes', () => {
    assert.deepStrictEqual(parseRemoteWebBase('git://github.com/owner/repo.git'), {
      host: 'github.com',
      base: 'https://github.com/owner/repo',
    });
  });

  it('preserves a non-default port for http(s) web origins', () => {
    assert.deepStrictEqual(parseRemoteWebBase('https://git.example.com:8443/group/repo.git'), {
      host: 'git.example.com',
      base: 'https://git.example.com:8443/group/repo',
    });
    assert.strictEqual(
      parseRemoteWebBase('http://git.example.com:8080/g/r')?.base,
      'https://git.example.com:8080/g/r',
    );
  });

  it('drops an ssh:// port (it is not the web port)', () => {
    assert.deepStrictEqual(parseRemoteWebBase('ssh://git@git.example.com:2222/group/repo.git'), {
      host: 'git.example.com',
      base: 'https://git.example.com/group/repo',
    });
  });

  it('returns undefined for Windows local-path remotes (drive letters)', () => {
    assert.strictEqual(parseRemoteWebBase('C:\\repos\\origin.git'), undefined);
    assert.strictEqual(parseRemoteWebBase('C:/repos/origin.git'), undefined);
    assert.strictEqual(parseRemoteWebBase('file:///c:/repos/origin.git'), undefined);
  });
});

describe('buildCommitUrl', () => {
  it('uses /commit for GitHub/GitLab', () => {
    assert.strictEqual(
      buildCommitUrl({ host: 'github.com', base: 'https://github.com/o/r' }, 'deadbeef'),
      'https://github.com/o/r/commit/deadbeef',
    );
  });

  it('uses /commits for Bitbucket', () => {
    assert.strictEqual(
      buildCommitUrl({ host: 'bitbucket.org', base: 'https://bitbucket.org/o/r' }, 'deadbeef'),
      'https://bitbucket.org/o/r/commits/deadbeef',
    );
  });
});

describe('detectPullRequest', () => {
  it('reads a GitHub merge-commit subject', () => {
    assert.deepStrictEqual(detectPullRequest('Merge pull request #123 from foo/bar'), {
      number: 123,
      kind: 'pull',
    });
  });

  it('reads a trailing squash reference', () => {
    assert.deepStrictEqual(detectPullRequest('Fix the thing (#456)'), {
      number: 456,
      kind: 'pull',
    });
  });

  it('reads a GitLab merge-request reference', () => {
    assert.deepStrictEqual(
      detectPullRequest("Merge branch 'x' into 'main' See merge request grp/proj!789"),
      { number: 789, kind: 'mr' },
    );
  });

  it('reads a trailing GitLab squash reference', () => {
    assert.deepStrictEqual(detectPullRequest('Do a thing (!42)'), { number: 42, kind: 'mr' });
  });

  it('prefers the strong merge-commit signal over a loose number', () => {
    assert.deepStrictEqual(detectPullRequest('Merge pull request #5 from a (#9 noise)'), {
      number: 5,
      kind: 'pull',
    });
  });

  it('falls back to a loose #n', () => {
    assert.deepStrictEqual(detectPullRequest('Close #7'), { number: 7, kind: 'pull' });
  });

  it('returns undefined when there is no number', () => {
    assert.strictEqual(detectPullRequest('Just a normal commit'), undefined);
    assert.strictEqual(detectPullRequest(''), undefined);
  });
});

describe('buildPrUrl', () => {
  const github = { host: 'github.com', base: 'https://github.com/o/r' };
  const gitlab = { host: 'gitlab.com', base: 'https://gitlab.com/o/r' };
  const bitbucket = { host: 'bitbucket.org', base: 'https://bitbucket.org/o/r' };

  it('builds a GitHub pull URL', () => {
    assert.strictEqual(
      buildPrUrl(github, { number: 1, kind: 'pull' }),
      'https://github.com/o/r/pull/1',
    );
  });

  it('builds a GitLab merge-request URL by host', () => {
    assert.strictEqual(
      buildPrUrl(gitlab, { number: 2, kind: 'pull' }),
      'https://gitlab.com/o/r/-/merge_requests/2',
    );
  });

  it('builds a Bitbucket pull-requests URL', () => {
    assert.strictEqual(
      buildPrUrl(bitbucket, { number: 3, kind: 'pull' }),
      'https://bitbucket.org/o/r/pull-requests/3',
    );
  });

  it('forces the merge-request path for an explicit !n even on a GitHub host', () => {
    assert.strictEqual(
      buildPrUrl(github, { number: 4, kind: 'mr' }),
      'https://github.com/o/r/-/merge_requests/4',
    );
  });
});
