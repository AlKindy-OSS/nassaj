/**
 * B-1373 — a project rooted at the service user's home (or at a root holding
 * credentials) is never registered or served, and project file access never
 * resolves into a secret location.
 *
 * A throwaway "home" is built under os.tmpdir() and installed as $HOME, so the
 * real operator home is never read. The passwd home is also protected by the
 * guard; it is asserted separately without touching its contents.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { createProject } from '@/modules/projects/services/project-management.service.js';
import {
  findForbiddenProjectRootReason,
  getSecretLocations,
  isForbiddenProjectRoot,
  isSecretPath,
  resetSecretPathGuardCache,
} from '@/shared/secret-path-guard.js';
import { AppError } from '@/shared/utils.js';

import { isResolvedPathInsideRootReal, resolveReadPathInProject } from '../utils/path-guard.js';

let sandbox = '';
let fakeHome = '';
let project = '';
let originalHome: string | undefined;

before(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-b1373-')));
  fakeHome = path.join(sandbox, 'home', 'svc');
  project = path.join(fakeHome, 'Project', 'app');
  fs.mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.ssh', 'id_ed25519'), 'PRIVATE');
  fs.mkdirSync(path.join(fakeHome, '.config', 'nassaj'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.config', 'nassaj', 'signing.key'), 'KEY');
  fs.mkdirSync(path.join(fakeHome, '.nassaj-users', '1', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.nassaj-users', '1', '.claude', '.credentials.json'), '{}');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), 'hello');
  // A project may keep its own .claude/ settings; only home-level ones are secret.
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), '{}');
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('the home itself, its ancestors and / are forbidden project roots', () => {
  assert.equal(findForbiddenProjectRootReason(fakeHome), 'home');
  assert.equal(findForbiddenProjectRootReason(`${fakeHome}/`), 'home');
  assert.equal(findForbiddenProjectRootReason(path.dirname(fakeHome)), 'home');
  assert.equal(findForbiddenProjectRootReason('/'), 'home');
});

test('the passwd home of the service user is protected even when $HOME differs', () => {
  const passwdHome = os.userInfo().homedir;
  assert.equal(isForbiddenProjectRoot(passwdHome), true);
  assert.equal(isSecretPath(path.join(passwdHome, '.ssh', 'id_rsa')), true);
});

test('roots inside or containing secret locations are forbidden', () => {
  assert.equal(findForbiddenProjectRootReason(path.join(fakeHome, '.ssh')), 'secret');
  assert.equal(findForbiddenProjectRootReason(path.join(fakeHome, '.nassaj-users')), 'secret');
  assert.equal(findForbiddenProjectRootReason(path.join(fakeHome, '.nassaj-users', '1')), 'secret');
  assert.equal(findForbiddenProjectRootReason(path.join(fakeHome, '.config')), 'secret');
  assert.equal(findForbiddenProjectRootReason(path.join(fakeHome, '.claude')), 'secret');
});

test('legitimate subproject roots under ~/Project stay allowed', () => {
  assert.equal(findForbiddenProjectRootReason(project), null);
  assert.equal(findForbiddenProjectRootReason(path.join(fakeHome, 'Project')), null);
  assert.equal(findForbiddenProjectRootReason(path.join(fakeHome, '.claude', 'external-projects', 'x')), null);
  assert.equal(isSecretPath(path.join(project, '.claude', 'settings.json')), false);
});

test('a symlink pointing into a secret location is recognised after realpath', () => {
  const link = path.join(sandbox, 'innocent-link');
  fs.symlinkSync(path.join(fakeHome, '.ssh'), link);
  assert.equal(isSecretPath(path.join(link, 'id_ed25519')), true);
  assert.equal(isForbiddenProjectRoot(link), true);
});

test('reads under an existing home-rooted project are refused (FORBIDDEN_ROOT)', async () => {
  for (const requested of ['.ssh/id_ed25519', '.config/nassaj/signing.key', 'Project/app/README.md']) {
    const guard = await resolveReadPathInProject(fakeHome, requested);
    assert.equal(guard.valid, false, requested);
    assert.equal((guard as { code: string }).code, 'FORBIDDEN_ROOT');
  }
});

test('reads under a legitimate project still work and cannot reach secrets', async () => {
  const ok = await resolveReadPathInProject(project, 'README.md');
  assert.equal(ok.valid, true);
  const traversal = await resolveReadPathInProject(project, '../../.ssh/id_ed25519');
  assert.equal(traversal.valid, false);
  fs.symlinkSync(path.join(fakeHome, '.ssh', 'id_ed25519'), path.join(project, 'src', 'key'));
  const viaLink = await resolveReadPathInProject(project, 'src/key');
  assert.equal(viaLink.valid, false);
});

test('writes under a home-rooted project or into secret locations are refused', () => {
  assert.equal(isResolvedPathInsideRootReal(fakeHome, path.join(fakeHome, '.ssh', 'authorized_keys')), false);
  assert.equal(isResolvedPathInsideRootReal(fakeHome, path.join(fakeHome, 'notes.txt')), false);
  assert.equal(isResolvedPathInsideRootReal(project, path.join(project, 'new.txt')), true);
});

test('createProject refuses the home directory with PROJECT_ROOT_FORBIDDEN', async () => {
  let persisted = false;
  await assert.rejects(
    async () => createProject(
      { projectPath: fakeHome },
      {
        validatePath: async () => ({ valid: true, resolvedPath: fakeHome }),
        ensureWorkspaceDirectory: async () => undefined,
        persistProjectPath: () => {
          persisted = true;
          return { outcome: 'created', project: null };
        },
        getProjectByPath: () => null,
        isPathAdmitted: () => true,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'PROJECT_ROOT_FORBIDDEN');
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
  assert.equal(persisted, false);
});

// ---------------------------------------------------------------------------
// Round 2: structural hidden-entry rule, allowlist and memoisation
// ---------------------------------------------------------------------------

/** Every location the round-2 review showed reachable through the fixed list. */
const HIDDEN_LOCATIONS = [
  '.cloudflared',
  '.nassaj-provider-secrets',
  '.nassaj-provider-secrets.key',
  '.pgpass',
  '.mcp-auth',
  '.gemini',
  '.kimi-code',
  '.local/share/opencode',
  '.config/opencode',
  '.claude.json',
  '.codex',
  '.claude/projects',
];

/** createProject with every collaborator stubbed except the guard. */
function createWithResolvedPath(resolvedPath: string) {
  return createProject(
    { projectPath: resolvedPath },
    {
      validatePath: async () => ({ valid: true, resolvedPath }),
      ensureWorkspaceDirectory: async () => undefined,
      persistProjectPath: () => ({ outcome: 'created', project: null }),
      getProjectByPath: () => null,
      isPathAdmitted: () => true,
    },
  );
}

for (const entry of HIDDEN_LOCATIONS) {
  test(`hidden home location ~/${entry} can be neither a project root nor a read target`, async () => {
    const location = path.join(fakeHome, entry);
    assert.equal(isForbiddenProjectRoot(location), true, 'root itself');
    assert.equal(isSecretPath(location), true, 'location itself');
    assert.equal(isSecretPath(path.join(location, 'nested', 'file')), true, 'anything under it');
    // A directory below it is refused as a root too (a member cannot narrow in).
    assert.equal(isForbiddenProjectRoot(path.join(location, 'sub')), true, 'nested root');
    await assert.rejects(createWithResolvedPath(location),
      (error: unknown) => error instanceof AppError && error.code === 'PROJECT_ROOT_FORBIDDEN');
  });
}

test('~/.claude/external-projects is the explicit allowlisted hidden root', async () => {
  const clone = path.join(fakeHome, '.claude', 'external-projects', 'abc123');
  fs.mkdirSync(clone, { recursive: true });
  fs.writeFileSync(path.join(clone, 'README.md'), 'cloned');
  assert.equal(findForbiddenProjectRootReason(clone), null);
  assert.equal((await resolveReadPathInProject(clone, 'README.md')).valid, true);
  // The allowlist never reaches siblings or the credentials beside it.
  assert.equal(isSecretPath(path.join(fakeHome, '.claude', 'external-projects', '..', '.credentials.json')), true);
  assert.equal(isForbiddenProjectRoot(path.join(fakeHome, '.claude')), true);
  // A symlink inside the allowlisted clone that points at a secret is refused.
  fs.symlinkSync(path.join(fakeHome, '.ssh', 'id_ed25519'), path.join(clone, 'key'));
  assert.equal((await resolveReadPathInProject(clone, 'key')).valid, false);
});

test('a non-hidden home entry stays allowed; a symlinked root into a hidden entry does not', () => {
  assert.equal(findForbiddenProjectRootReason(path.join(fakeHome, 'notes')), null);
  const disguised = path.join(fakeHome, 'Project', 'disguised');
  fs.mkdirSync(path.join(fakeHome, '.cloudflared'), { recursive: true });
  fs.symlinkSync(path.join(fakeHome, '.cloudflared'), disguised);
  assert.equal(isForbiddenProjectRoot(disguised), true);
});

test('the derived policy is memoised and re-derived when $HOME changes', (t) => {
  resetSecretPathGuardCache();
  isSecretPath(path.join(project, 'README.md')); // warm the cache
  const realpathSpy = t.mock.method(fs, 'realpathSync');
  isSecretPath(path.join(project, 'README.md'));
  findForbiddenProjectRootReason(project);
  // Only the forms of the two arguments are resolved, never the ~30 policy paths.
  assert.ok(realpathSpy.mock.callCount() <= 2, `realpath calls: ${realpathSpy.mock.callCount()}`);
  realpathSpy.mock.restore();

  const otherHome = path.join(sandbox, 'other-home');
  fs.mkdirSync(otherHome, { recursive: true });
  process.env.HOME = otherHome;
  try {
    assert.ok(getSecretLocations().includes(path.join(otherHome, '.ssh')), 'new HOME applied at once');
  } finally {
    process.env.HOME = fakeHome;
  }
  assert.ok(getSecretLocations().includes(path.join(fakeHome, '.ssh')));
});
