import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * B-1421: throwaway git project for websocket tests that reach the real session
 * workspace overlay. Launches create overlay state under the project's common
 * `.git`, so using `process.cwd()` wrote launch aliases into the real checkout's
 * `.git/nassaj-session-overlays`, where they persisted and collided across
 * checkouts ("launch key is already bound to another project").
 *
 * Import this module FIRST in a test file: `WORKSPACES_ROOT` is read when
 * `@/shared/utils.js` loads, and the fixture lives under the case TMPDIR, which
 * must be the allowed workspace root. It also becomes the default launch `cwd`
 * of `dispatchAuthorizedProviderCommand` for this process.
 */
function createTestGitProject(): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'nassaj-ws-project-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(path.join(directory, 'README.md'), 'fixture\n');
  git('add', 'README.md');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
  return directory;
}

export const TEST_GIT_PROJECT = createTestGitProject();
process.env.WORKSPACES_ROOT = realpathSync(os.tmpdir());
process.env.NASSAJ_TEST_GIT_PROJECT = TEST_GIT_PROJECT;
