import { describe, expect, it } from 'vitest';

import { SOURCE_REPO_URL, githubRepoParts } from './sourceRepo';

describe('public repository boundaries', () => {
  it('uses the public OSS repository for source links', () => {
    expect(SOURCE_REPO_URL).toBe('https://github.com/AlKindy-OSS/nassaj');
  });

  it('accepts only an exact public GitHub repository URL', () => {
    expect(githubRepoParts('https://github.com/example/project.git')).toEqual({
      owner: 'example',
      name: 'project',
    });
    expect(githubRepoParts('https://git.example.test/private/project')).toEqual({ owner: '', name: '' });
    expect(githubRepoParts('https://github.com/example/project/releases')).toEqual({ owner: '', name: '' });
  });
});
