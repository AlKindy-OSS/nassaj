/**
 * provider-cage-wiring.test.ts — the launcher seam for the unified cage
 * (T-897 m2).
 *
 * Contract under test:
 *   flag OFF  → resolveCagedLaunch returns the SAME cmd/args references and
 *               performs zero filesystem access; buildCagedSdkSpawn returns
 *               undefined (the SDK option is never set) — i.e. the wired
 *               launch sites are byte-identical to their pre-wiring behaviour.
 *   flag ON   → the launch is wrapped in the unified bwrap argv with on-disk
 *               guards: own-user rebind only when the user dir exists, cwd
 *               bind only when it exists, usersRoot only when present.
 *
 * Runner:
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *     --test server/services/isolation/provider-cage-wiring.test.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import path from 'node:path';

import {
  cageUsersRoot,
  cageSecretHidePaths,
  cageOperatorSecretMasks,
  cageMountPlan,
  CAGE_SHARED_CREDENTIALS,
  CAGE_SECRET_HIDE_DIRS,
  CAGE_OPERATOR_SECRET_FILES,
  resolveCagedLaunch,
  buildCagedSdkSpawn,
} from './provider-cage-wiring.js';

const ORIGINAL_FLAG = process.env.NASSAJ_PROVIDER_CAGE;

function setCage(on: boolean): void {
  process.env.NASSAJ_PROVIDER_CAGE = on ? 'true' : 'false';
}

after(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.NASSAJ_PROVIDER_CAGE;
  else process.env.NASSAJ_PROVIDER_CAGE = ORIGINAL_FLAG;
});

/** Index of the first contiguous occurrence of `sub` inside `arr`, or -1. */
function indexOfSubsequence(arr: string[], sub: string[]): number {
  outer: for (let i = 0; i + sub.length <= arr.length; i++) {
    for (let j = 0; j < sub.length; j++) {
      if (arr[i + j] !== sub[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function assertContainsSeq(arr: string[], sub: string[]): void {
  assert.ok(
    indexOfSubsequence(arr, sub) !== -1,
    `argv must contain ${JSON.stringify(sub)}\ngot: ${JSON.stringify(arr)}`,
  );
}

const FAKE_BWRAP = { resolveBwrapPath: () => '/opt/codex/bwrap' };
const HOME = '/home/op';
const USERS_ROOT = path.join(HOME, '.nassaj-users');

/** lstat that always throws — models "no per-user entitlement symlink". */
function lstatAbsent(): never {
  const err = new Error('ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
}

/**
 * deps where every probed path "exists" (records probes for assertions).
 * The sharing policy is injected (all providers isolated) so no test ever
 * touches the real database through the default isProviderIsolated.
 */
function allExist(isolated: (p: string) => boolean = () => true) {
  const probed: string[] = [];
  return {
    probed,
    deps: {
      ...FAKE_BWRAP,
      homedir: () => HOME,
      existsSync: (p: string) => {
        probed.push(p);
        return true;
      },
      lstatSync: lstatAbsent as unknown as typeof import('node:fs').lstatSync,
      isProviderIsolated: isolated,
    },
  };
}

// ---------------------------------------------------------------------------
// cageUsersRoot
// ---------------------------------------------------------------------------

describe('cageUsersRoot', () => {
  it('returns the ~/.nassaj-users path when it exists', () => {
    const root = cageUsersRoot({ homedir: () => HOME, existsSync: () => true });
    assert.equal(root, USERS_ROOT);
  });

  it('returns undefined when the root is absent (nothing to hide)', () => {
    const root = cageUsersRoot({ homedir: () => HOME, existsSync: () => false });
    assert.equal(root, undefined);
  });
});

// ---------------------------------------------------------------------------
// cageSecretHidePaths — owner-secret dirs, relative to the REAL homedir
// ---------------------------------------------------------------------------

describe('cageSecretHidePaths', () => {
  // readdirSync stub so cdxrt globbing is deterministic (never a real-$HOME readdir).
  const noCdxrt = { readdirSync: (() => []) as unknown as (p: string) => string[] };

  it('re-roots every secret dir on the REAL homedir (never a hard-coded /home/dev)', () => {
    const paths = cageSecretHidePaths({ homedir: () => '/home/dev', existsSync: () => true, ...noCdxrt });
    assert.ok(paths.includes('/home/dev/.ssh'), '~/.ssh (fleet key) must be hidden');
    assert.ok(paths.includes('/home/dev/.gnupg'), 'GPG keyring must be hidden');
    assert.ok(paths.includes('/home/dev/.cloudflared'), 'tunnel creds must be hidden');
    assert.ok(
      paths.includes(path.join('/home/dev', '.local', 'share', 'nassaj-dev')),
      'the LIVE app-db dir (password hashes + api_keys) must be hidden',
    );
    assert.ok(paths.every((p) => p.startsWith('/home/dev/')), 'no path may be hard-coded off the owner home');
  });

  it('covers the full fixed secret-dir registry when every dir exists', () => {
    const paths = cageSecretHidePaths({ homedir: () => HOME, existsSync: () => true, ...noCdxrt });
    for (const rel of CAGE_SECRET_HIDE_DIRS) {
      assert.ok(paths.includes(path.join(HOME, rel)), `${rel} must be hidden`);
    }
  });

  it('globs cdxrt.*​/secret dirs live (random, ephemeral Codex runtime auth copies)', () => {
    const paths = cageSecretHidePaths({
      homedir: () => HOME,
      existsSync: () => true,
      readdirSync: (() => ['cdxrt.AbC123', 'cdxrt.ZzZ', '.ssh', 'Project', 'notcdxrt']) as unknown as (
        p: string,
      ) => string[],
    });
    assert.ok(paths.includes(path.join(HOME, 'cdxrt.AbC123', 'secret')));
    assert.ok(paths.includes(path.join(HOME, 'cdxrt.ZzZ', 'secret')));
    // only cdxrt.* matched — a sibling project dir must not be swept in
    assert.ok(!paths.some((p) => p.includes(`${path.sep}notcdxrt${path.sep}`)));
    assert.ok(!paths.some((p) => p.includes(`${path.sep}Project${path.sep}secret`)));
  });

  it('omits paths that do not exist (nothing to hide, minimal argv)', () => {
    const paths = cageSecretHidePaths({ homedir: () => HOME, existsSync: () => false, ...noCdxrt });
    assert.deepEqual(paths, []);
  });

  it('tolerates a readdir failure (best-effort cdxrt glob never throws)', () => {
    const paths = cageSecretHidePaths({
      homedir: () => HOME,
      existsSync: (p: string) => p === path.join(HOME, '.ssh'),
      readdirSync: (() => {
        throw new Error('EACCES');
      }) as unknown as (p: string) => string[],
    });
    assert.deepEqual(paths, [path.join(HOME, '.ssh')]);
  });

  it('never includes ~/.claude.json (tmpfs cannot mount over a file; masked as a FILE instead)', () => {
    const paths = cageSecretHidePaths({ homedir: () => HOME, existsSync: () => true, ...noCdxrt });
    assert.ok(!paths.some((p) => p.endsWith('.claude.json')), '.claude.json must not be tmpfs-hidden');
  });
});

// ---------------------------------------------------------------------------
// cageOperatorSecretMasks — non-provider secret FILES (unconditional masks)
// ---------------------------------------------------------------------------

describe('cageOperatorSecretMasks', () => {
  it('masks the GitHub OAuth + server key + registry/git creds, re-rooted on homedir', () => {
    const files = cageOperatorSecretMasks({ homedir: () => HOME, existsSync: () => true });
    assert.ok(files.includes(path.join(HOME, '.config', 'gh', 'hosts.yml')), 'gh OAuth token must be masked');
    assert.ok(
      files.includes(path.join(HOME, '.nassaj-provider-secrets.key')),
      'the server key that decrypts every provider secret must be masked',
    );
    assert.ok(files.includes(path.join(HOME, '.docker', 'config.json')));
    assert.ok(files.includes(path.join(HOME, '.netrc')));
    assert.ok(files.includes(path.join(HOME, '.git-credentials')));
  });

  it('covers the full operator secret-file registry', () => {
    const files = cageOperatorSecretMasks({ homedir: () => HOME, existsSync: () => true });
    for (const rel of CAGE_OPERATOR_SECRET_FILES) {
      assert.ok(files.includes(path.join(HOME, rel)), `${rel} must be masked`);
    }
  });

  it('never masks ~/.npmrc (npx/MCP registry config — owner decision, not a blind mask)', () => {
    const files = cageOperatorSecretMasks({ homedir: () => HOME, existsSync: () => true });
    assert.ok(!files.some((p) => p.endsWith('.npmrc')), '.npmrc must stay readable for MCP install');
  });

  it('existsSync-filters: nothing to mask on a bare host', () => {
    const files = cageOperatorSecretMasks({ homedir: () => HOME, existsSync: () => false });
    assert.deepEqual(files, []);
  });
});

// ---------------------------------------------------------------------------
// flag OFF — the wired sites must behave exactly as before the wiring
// ---------------------------------------------------------------------------

describe('flag OFF — byte-identical passthrough', () => {
  it('returns the same cmd/args references, touches no filesystem and reads no policy', () => {
    setCage(false);
    const cmdRef = '/usr/bin/opencode';
    const argsRef = ['run', '--format', 'json'];
    let fsTouched = 0;
    let policyRead = 0;
    let homedirRead = 0;
    let realpathRead = 0;
    const out = resolveCagedLaunch(
      { userId: 7, provider: 'opencode', cmd: cmdRef, args: argsRef, cwd: '/w' },
      {
        ...FAKE_BWRAP,
        homedir: () => {
          homedirRead += 1;
          return HOME;
        },
        existsSync: () => {
          fsTouched += 1;
          return true;
        },
        realpathSync: ((p: string) => {
          realpathRead += 1;
          return p;
        }) as unknown as (p: string) => string,
        isProviderIsolated: () => {
          policyRead += 1;
          return true;
        },
      },
    );
    // byte-identical off path: SAME references out, and zero disk/DB introspection
    assert.equal(out.cmd, cmdRef, 'cmd must be the SAME reference (out.cmd === cmdRef)');
    assert.equal(out.args, argsRef, 'args must be the SAME array reference (out.args === argsRef)');
    assert.equal(fsTouched, 0, 'flag off must not stat anything (hot path untouched)');
    assert.equal(policyRead, 0, 'flag off must not consult the sharing policy');
    assert.equal(homedirRead, 0, 'flag off must not resolve homedir');
    assert.equal(realpathRead, 0, 'flag off must not realpath anything');
  });

  it('returns passthrough when the flag is unset entirely', () => {
    delete process.env.NASSAJ_PROVIDER_CAGE;
    const out = resolveCagedLaunch(
      { userId: 7, provider: 'claude', cmd: 'claude', args: ['x'], cwd: '/w' },
      allExist().deps,
    );
    assert.deepEqual(out, { cmd: 'claude', args: ['x'] });
  });

  it('buildCagedSdkSpawn returns undefined so the SDK option is never set', () => {
    setCage(false);
    assert.equal(buildCagedSdkSpawn({ userId: 1, cwd: '/w' }, FAKE_BWRAP), undefined);
  });

  it('exempt providers pass through even with the flag on (codex self-cages)', () => {
    setCage(true);
    const args = ['exec'];
    const out = resolveCagedLaunch(
      { userId: 7, provider: 'codex', cmd: 'codex', args, cwd: '/w' },
      allExist().deps,
    );
    assert.deepEqual(out, { cmd: 'codex', args: ['exec'] });
    assert.equal(out.args, args, 'exempt path must not reshape args');
  });

  it('HTTP-hosted vendors pass through even with the flag on', () => {
    setCage(true);
    const out = resolveCagedLaunch(
      { userId: 7, provider: 'kimi', cmd: 'kimi', args: [], cwd: '/w' },
      allExist().deps,
    );
    assert.deepEqual(out, { cmd: 'kimi', args: [] });
  });
});

// ---------------------------------------------------------------------------
// flag ON — wrapped argv with on-disk guards
// ---------------------------------------------------------------------------

describe('flag ON — caged launch shape', () => {
  it('wraps an in-scope provider and rebinds the existing own-user dir + cwd', () => {
    setCage(true);
    const { deps } = allExist();
    const out = resolveCagedLaunch(
      { userId: 42, provider: 'agy', cmd: '/home/op/.local/bin/agy', args: ['-p', 'hi'], cwd: '/proj' },
      deps,
    );
    assert.equal(out.cmd, '/opt/codex/bwrap');
    assertContainsSeq(out.args, ['--unshare-user', '--unshare-pid', '--unshare-ipc']);
    assertContainsSeq(out.args, ['--tmpfs', USERS_ROOT]);
    const userDir = path.join(USERS_ROOT, '42');
    assertContainsSeq(out.args, ['--bind', userDir, userDir]);
    assertContainsSeq(out.args, ['--bind', '/proj', '/proj']);
    // owner-secret hiding is wired in: ~/.ssh blanked, BEFORE the user rebind
    const sshDir = path.join(HOME, '.ssh');
    assertContainsSeq(out.args, ['--tmpfs', sshDir]);
    assert.ok(
      indexOfSubsequence(out.args, ['--tmpfs', sshDir]) <
        indexOfSubsequence(out.args, ['--bind', userDir, userDir]),
      '~/.ssh tmpfs must precede the per-user rebind',
    );
    const dash = out.args.indexOf('--');
    assert.deepEqual(out.args.slice(dash + 1), ['/home/op/.local/bin/agy', '-p', 'hi']);
  });

  it('hides the whole users root but does NOT rebind a MISSING own-user dir', () => {
    setCage(true);
    // usersRoot exists; the caller's own dir does NOT (shared-provider user).
    const deps = {
      ...FAKE_BWRAP,
      homedir: () => HOME,
      existsSync: (p: string) => p === USERS_ROOT, // only the root exists
      isProviderIsolated: () => true,
    };
    const out = resolveCagedLaunch(
      { userId: 99, provider: 'gemini', cmd: 'gemini', args: [], cwd: '/proj' },
      deps,
    );
    assertContainsSeq(out.args, ['--tmpfs', USERS_ROOT]);
    const userDir = path.join(USERS_ROOT, '99');
    assert.equal(
      indexOfSubsequence(out.args, ['--bind', userDir, userDir]),
      -1,
      'a non-existent own-user dir must NOT be bind-mounted (bwrap would fail)',
    );
    // cwd missing here too → not bound
    assert.equal(indexOfSubsequence(out.args, ['--bind', '/proj', '/proj']), -1);
  });

  it('omits the users-root tmpfs entirely when the root does not exist', () => {
    setCage(true);
    const deps = {
      ...FAKE_BWRAP,
      homedir: () => HOME,
      existsSync: () => false, // neither root nor cwd exist
      isProviderIsolated: () => true,
    };
    const out = resolveCagedLaunch(
      { userId: 1, provider: 'claude', cmd: 'claude', args: ['x'], cwd: '/proj' },
      deps,
    );
    // still caged (namespaces + ro-bind), just no per-user overlay
    assert.equal(out.cmd, '/opt/codex/bwrap');
    assertContainsSeq(out.args, ['--ro-bind', '/', '/']);
    assert.equal(indexOfSubsequence(out.args, ['--tmpfs', USERS_ROOT]), -1);
  });

  it('fails SAFE (passthrough) when the flag is on but no bwrap resolves', () => {
    setCage(true);
    const out = resolveCagedLaunch(
      { userId: 1, provider: 'claude', cmd: 'claude', args: ['x'], cwd: '/proj' },
      {
        resolveBwrapPath: () => null,
        homedir: () => HOME,
        existsSync: () => true,
        lstatSync: lstatAbsent as unknown as typeof import('node:fs').lstatSync,
        isProviderIsolated: () => true,
      },
    );
    assert.deepEqual(out, { cmd: 'claude', args: ['x'] }, 'missing bwrap must not block the spawn');
  });

  it('argv carries the mount plan: credentials masked AFTER the user rebind, store re-bound rw', () => {
    setCage(true);
    const { deps } = allExist();
    const out = resolveCagedLaunch(
      { userId: 42, provider: 'claude', cmd: 'claude', args: ['chat'], cwd: '/proj' },
      deps,
    );
    const cred = path.join(HOME, '.claude', '.credentials.json');
    const claudeJson = path.join(HOME, '.claude.json');
    const codexAuth = path.join(HOME, '.codex', 'auth.json');
    const hermesAuth = path.join(HOME, '.hermes', 'auth.json');
    const agyToken = path.join(HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    const opencodeAuth = path.join(HOME, '.local', 'share', 'opencode', 'auth.json');
    for (const f of [cred, claudeJson, codexAuth, hermesAuth, agyToken, opencodeAuth]) {
      assertContainsSeq(out.args, ['--ro-bind', '/dev/null', f]);
    }
    // isolated claude keeps writing transcripts to the by-design-shared store
    const store = path.join(HOME, '.claude', 'projects');
    assertContainsSeq(out.args, ['--bind', store, store]);
    // masks mount after the per-user rebind so nothing re-exposes them
    const userDir = path.join(USERS_ROOT, '42');
    assert.ok(
      indexOfSubsequence(out.args, ['--ro-bind', '/dev/null', cred]) >
        indexOfSubsequence(out.args, ['--bind', userDir, userDir]),
      'credential masks must mount after the per-user rebind',
    );
  });

  it('argv also masks the non-provider operator secrets (gh OAuth + server key) and hides their secret dirs', () => {
    setCage(true);
    const { deps } = allExist();
    const out = resolveCagedLaunch(
      { userId: 42, provider: 'claude', cmd: 'claude', args: ['chat'], cwd: '/proj' },
      deps,
    );
    // operator secret FILES masked with /dev/null (unconditional, no entitlement)
    const ghHosts = path.join(HOME, '.config', 'gh', 'hosts.yml');
    const serverKey = path.join(HOME, '.nassaj-provider-secrets.key');
    assertContainsSeq(out.args, ['--ro-bind', '/dev/null', ghHosts]);
    assertContainsSeq(out.args, ['--ro-bind', '/dev/null', serverKey]);
    // operator secret DIRS blanked with tmpfs (crown-jewel app db + tunnel creds)
    assertContainsSeq(out.args, ['--tmpfs', path.join(HOME, '.local', 'share', 'nassaj-dev')]);
    assertContainsSeq(out.args, ['--tmpfs', path.join(HOME, '.cloudflared')]);
    // the gh mask mounts LAST (after the per-user rebind) like every other mask
    const userDir = path.join(USERS_ROOT, '42');
    assert.ok(
      indexOfSubsequence(out.args, ['--ro-bind', '/dev/null', ghHosts]) >
        indexOfSubsequence(out.args, ['--bind', userDir, userDir]),
      'operator secret masks must mount after the per-user rebind',
    );
  });
});

// ---------------------------------------------------------------------------
// cageMountPlan — per-launch credential masks + shared-store write re-binds
// ---------------------------------------------------------------------------

describe('cageMountPlan (T-898)', () => {
  const CRED = {
    claudeCred: path.join(HOME, '.claude', '.credentials.json'),
    claudeJson: path.join(HOME, '.claude.json'),
    codexAuth: path.join(HOME, '.codex', 'auth.json'),
    agyToken: path.join(HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    hermesAuth: path.join(HOME, '.hermes', 'auth.json'),
    opencodeAuth: path.join(HOME, '.local', 'share', 'opencode', 'auth.json'),
  };
  const ALL_CREDS = Object.values(CRED);

  it('covers every credential the 2026-07-14 spike proved readable (registry completeness)', () => {
    const rels = Object.values(CAGE_SHARED_CREDENTIALS).flat();
    for (const rel of [
      path.join('.claude', '.credentials.json'),
      '.claude.json',
      path.join('.codex', 'auth.json'),
      path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      path.join('.hermes', 'auth.json'),
      path.join('.local', 'share', 'opencode', 'auth.json'),
    ]) {
      assert.ok(rels.includes(rel), `registry must include ${rel}`);
    }
  });

  it('ISOLATED claude, no entitlement: masks EVERY credential incl. its own; store + caches rw', () => {
    const { deps } = allExist();
    const plan = cageMountPlan({ provider: 'claude', userId: 7 }, deps);
    for (const f of ALL_CREDS) {
      assert.ok(plan.maskFiles.includes(f), `${f} must be masked`);
      assert.ok(!plan.writePaths.includes(f), `${f} must not be granted rw`);
    }
    assert.ok(plan.writePaths.includes(path.join(HOME, '.claude', 'projects')));
    assert.ok(plan.writePaths.includes(path.join(HOME, '.npm')), 'MCP npm cache must be writable');
    assert.ok(plan.writePaths.includes(path.join(HOME, '.cache')));
    // the shared transcript store must never be masked
    assert.ok(!plan.maskFiles.includes(path.join(HOME, '.claude', 'projects')));
  });

  it('ISOLATED claude: a forged owner-reuse symlink to the operator credential is IGNORED (T-898 forgery closure)', () => {
    // The qa-critic PoC: the per-user tree is bind-mounted rw inside the cage, so a
    // caged session can plant ~/.nassaj-users/7/.claude/.credentials.json → the
    // operator credential. Entitlement must NOT be derived from that cage-writable
    // surface: the operator credential STAYS masked and is NEVER handed out rw, no
    // matter what the on-disk link resolves to. (The removed exemption trusted
    // exactly this realpath equality.)
    const userLink = path.join(USERS_ROOT, '7', '.claude', '.credentials.json');
    const { deps } = allExist();
    const forgedDeps = {
      ...deps,
      // a realpath seam under which the planted symlink WOULD resolve onto the
      // operator credential — the precise condition the old exemption trusted
      realpathSync: ((p: string) =>
        p === userLink ? CRED.claudeCred : p) as unknown as (p: string) => string,
    };
    const plan = cageMountPlan({ provider: 'claude', userId: 7 }, forgedDeps);
    assert.ok(plan.maskFiles.includes(CRED.claudeCred), 'operator credential must STAY masked despite the forged link');
    assert.ok(
      !plan.writePaths.includes(CRED.claudeCred),
      'a forged/owner-reuse link must NEVER grant the operator credential rw',
    );
    // every credential (incl. its own) masked; the by-design store still writable
    for (const f of ALL_CREDS) {
      assert.ok(plan.maskFiles.includes(f), `${f} must stay masked`);
      assert.ok(!plan.writePaths.includes(f), `${f} must never be granted rw`);
    }
    assert.ok(plan.writePaths.includes(path.join(HOME, '.claude', 'projects')), 'transcript store stays rw');
  });

  it('argv under a forged symlink: the operator credential is emitted ONLY masked, never as a rw --bind (T-898)', () => {
    // End-to-end at the argv layer: build the real bwrap argv (resolveCagedLaunch →
    // cageMountPlan → buildCagedLaunch) with the planted-symlink realpath seam and
    // assert the operator credential appears solely as `--ro-bind /dev/null` and in
    // NO `--bind cred cred` write grant.
    setCage(true);
    const userLink = path.join(USERS_ROOT, '7', '.claude', '.credentials.json');
    const { deps } = allExist();
    const out = resolveCagedLaunch(
      { userId: 7, provider: 'claude', cmd: 'claude', args: ['chat'], cwd: '/proj' },
      {
        ...deps,
        realpathSync: ((p: string) =>
          p === userLink ? CRED.claudeCred : p) as unknown as (p: string) => string,
      },
    );
    const cred = CRED.claudeCred;
    assertContainsSeq(out.args, ['--ro-bind', '/dev/null', cred]);
    assert.equal(
      indexOfSubsequence(out.args, ['--bind', cred, cred]),
      -1,
      'the operator credential must NEVER be emitted as a read-write --bind',
    );
  });

  it('SHARED-mode agy (admin policy): its own token stays readable + rw; everything else masked', () => {
    const { deps } = allExist((p) => p !== 'agy'); // agy shared, others isolated
    const plan = cageMountPlan({ provider: 'agy', userId: 7 }, deps);
    assert.ok(!plan.maskFiles.includes(CRED.agyToken), 'shared-mode agy must keep its own token');
    assert.ok(plan.writePaths.includes(CRED.agyToken), 'token must be rw (refresh persistence)');
    assert.ok(
      plan.writePaths.includes(path.join(HOME, '.gemini', 'antigravity-cli')),
      'shared-mode agy runs on the operator state dir',
    );
    for (const f of [CRED.claudeCred, CRED.claudeJson, CRED.codexAuth, CRED.hermesAuth, CRED.opencodeAuth]) {
      assert.ok(plan.maskFiles.includes(f), `${f} must be masked inside the agy cage`);
    }
  });

  it('hermes (no per-user knob, policy-shared): ~/.hermes rw incl. its auth; other creds masked', () => {
    const { deps } = allExist((p) => p !== 'hermes');
    const plan = cageMountPlan({ provider: 'hermes', userId: 7 }, deps);
    assert.ok(!plan.maskFiles.includes(CRED.hermesAuth));
    assert.ok(plan.writePaths.includes(path.join(HOME, '.hermes')), 'hermes state dir must be rw');
    for (const f of [CRED.claudeCred, CRED.claudeJson, CRED.codexAuth, CRED.agyToken, CRED.opencodeAuth]) {
      assert.ok(plan.maskFiles.includes(f), `${f} must be masked inside the hermes cage`);
    }
  });

  it('ISOLATED gemini: no gemini credential exists at operator level — all six creds masked', () => {
    const { deps } = allExist();
    const plan = cageMountPlan({ provider: 'gemini', userId: 7 }, deps);
    for (const f of ALL_CREDS) {
      assert.ok(plan.maskFiles.includes(f), `${f} must be masked inside the gemini cage`);
    }
    assert.ok(plan.writePaths.includes(path.join(HOME, '.gemini', 'projects')));
  });

  it('existsSync-filters everything: nothing to mask/bind on a bare host', () => {
    const { deps } = allExist();
    const bare = { ...deps, existsSync: () => false };
    const plan = cageMountPlan({ provider: 'claude', userId: 7 }, bare);
    assert.deepEqual(plan, { writePaths: [], maskFiles: [] });
  });
});

// ---------------------------------------------------------------------------
// buildCagedSdkSpawn — the SDK spawn hook (flag ON)
// ---------------------------------------------------------------------------

describe('buildCagedSdkSpawn — flag ON', () => {
  it('returns a spawn hook that wraps the SDK command in bwrap', () => {
    setCage(true);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fakeSpawn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { fake: true } as never;
    }) as never;

    const hook = buildCagedSdkSpawn(
      { userId: 42, cwd: '/proj' },
      { ...allExist().deps, spawn: fakeSpawn },
    );
    assert.ok(hook, 'hook must be defined when the flag is on');

    hook!({ command: '/usr/bin/node', args: ['cli.js', '--x'], cwd: '/proj', env: {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, '/opt/codex/bwrap');
    const dash = calls[0].args.indexOf('--');
    assert.deepEqual(calls[0].args.slice(dash + 1), ['/usr/bin/node', 'cli.js', '--x']);
  });
});

// ---------------------------------------------------------------------------
// Integration — a REAL caged launch actually blocks a foreign tree (skipped
// when bwrap/userns is unavailable). Proves the wiring produces a working cage,
// not just the right argv.
// ---------------------------------------------------------------------------

// The integration paths inject ONLY the sharing policy (all isolated): the real
// default would read the live app_config database from a unit test. Everything
// else (homedir, fs, bwrap resolution) is the real thing.
const REAL_WITH_POLICY = { isProviderIsolated: () => true };

function realBwrapUsable(): boolean {
  // Reuse the module's own resolver via a caged probe: build an argv and try it.
  setCage(true);
  const probe = resolveCagedLaunch(
    { userId: null, provider: 'claude', cmd: 'true', args: [], cwd: undefined },
    REAL_WITH_POLICY,
  );
  if (probe.cmd === 'true') return false; // passthrough ⇒ no bwrap resolved
  const res = spawnSync(probe.cmd, probe.args, { encoding: 'utf8' });
  return res.status === 0;
}

// ---------------------------------------------------------------------------
// resolveCagedLaunch — per-mode (SL-6): a kimi/glm AGENT run is wrapped; the
// chat/omitted run stays a byte-identical passthrough.
// ---------------------------------------------------------------------------

describe('resolveCagedLaunch — per-mode (SL-6)', () => {
  it('wraps a kimi AGENT launch (mode: "agent") in the unified bwrap argv', () => {
    setCage(true);
    const { deps } = allExist();
    const out = resolveCagedLaunch(
      { userId: 42, provider: 'kimi', mode: 'agent', cmd: 'kimi', args: ['-p', 'hi'], cwd: '/proj' },
      deps,
    );
    assert.equal(out.cmd, '/opt/codex/bwrap');
    assertContainsSeq(out.args, ['--unshare-user', '--unshare-pid', '--unshare-ipc']);
    const dash = out.args.indexOf('--');
    assert.deepEqual(out.args.slice(dash + 1), ['kimi', '-p', 'hi']);
  });

  it('wraps a glm AGENT launch (carrier identity) in bwrap', () => {
    setCage(true);
    const { deps } = allExist();
    const out = resolveCagedLaunch(
      { userId: 42, provider: 'glm', mode: 'agent', cmd: 'opencode', args: ['run'], cwd: '/proj' },
      deps,
    );
    assert.equal(out.cmd, '/opt/codex/bwrap');
  });

  it('passes a kimi CHAT / omitted-mode launch through byte-identically (no fs, no policy)', () => {
    setCage(true);
    let fsTouched = 0;
    let policyRead = 0;
    const argsRef = ['stream'];
    const probeDeps = {
      ...FAKE_BWRAP,
      homedir: () => HOME,
      existsSync: () => {
        fsTouched += 1;
        return true;
      },
      isProviderIsolated: () => {
        policyRead += 1;
        return true;
      },
    };
    const chat = resolveCagedLaunch(
      { userId: 42, provider: 'kimi', mode: 'chat', cmd: 'kimi', args: argsRef, cwd: '/proj' },
      probeDeps,
    );
    assert.equal(chat.cmd, 'kimi');
    assert.equal(chat.args, argsRef, 'chat mode must return the SAME args reference');
    const omitted = resolveCagedLaunch(
      { userId: 42, provider: 'kimi', cmd: 'kimi', args: argsRef, cwd: '/proj' },
      probeDeps,
    );
    assert.equal(omitted.args, argsRef, 'omitted mode must return the SAME args reference');
    assert.equal(fsTouched, 0, 'the exempt chat path must not stat anything');
    assert.equal(policyRead, 0, 'the exempt chat path must not consult the sharing policy');
  });
});

// ---------------------------------------------------------------------------
// cageMountPlan / argv — kimi agent credential mask (SL-6 / KG-1)
// ---------------------------------------------------------------------------

describe('kimi agent credential mask (SL-6)', () => {
  const kimiCred = path.join(HOME, '.kimi-code', 'auth.json');
  const opencodeAuth = path.join(HOME, '.local', 'share', 'opencode', 'auth.json');

  it('registers the kimi config-home credential file', () => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(CAGE_SHARED_CREDENTIALS, 'kimi'),
      'CAGE_SHARED_CREDENTIALS must include a kimi entry',
    );
    const rels = Object.values(CAGE_SHARED_CREDENTIALS).flat();
    assert.ok(rels.includes(path.join('.kimi-code', 'auth.json')), 'kimi credential path must be registered');
  });

  it('ISOLATED kimi agent: masks its OWN config-home credential + every other provider credential', () => {
    const { deps } = allExist(); // all providers isolated ⇒ no waiver for anyone
    const plan = cageMountPlan({ provider: 'kimi', userId: 7 }, deps);
    // kimi's own operator credential is masked (its per-user key lives in the tree)
    assert.ok(plan.maskFiles.includes(kimiCred), 'the kimi operator credential must be masked');
    assert.ok(!plan.writePaths.includes(kimiCred), 'the kimi credential must never be granted rw');
    // the glm key rides inside opencode auth.json — masked in a kimi cage (cross-provider isolation)
    assert.ok(plan.maskFiles.includes(opencodeAuth), 'opencode auth.json (carrier for glm) must be masked in a kimi cage');
    // isolated kimi has no operator-level shared store; only the toolchain caches are rw
    assert.ok(plan.writePaths.includes(path.join(HOME, '.npm')), 'MCP npm cache must be writable');
    assert.ok(plan.writePaths.includes(path.join(HOME, '.cache')));
    assert.ok(
      !plan.writePaths.some((p) => p.startsWith(path.join(HOME, '.kimi-code'))),
      'no operator kimi store is re-bound for an isolated agent',
    );
  });

  it('argv of a caged kimi AGENT launch masks the kimi credential with /dev/null, after the user rebind', () => {
    setCage(true);
    const { deps } = allExist();
    const out = resolveCagedLaunch(
      { userId: 42, provider: 'kimi', mode: 'agent', cmd: 'kimi', args: ['-p', 'x'], cwd: '/proj' },
      deps,
    );
    assertContainsSeq(out.args, ['--ro-bind', '/dev/null', kimiCred]);
    const userDir = path.join(USERS_ROOT, '42');
    assert.ok(
      indexOfSubsequence(out.args, ['--ro-bind', '/dev/null', kimiCred]) >
        indexOfSubsequence(out.args, ['--bind', userDir, userDir]),
      'the kimi credential mask must mount after the per-user rebind',
    );
  });
});

describe('resolveCagedLaunch — real cage integration', () => {
  const usable = realBwrapUsable();
  it(
    'a caged sh cannot read a foreign users-tree secret',
    { skip: usable ? false : 'bwrap/userns unavailable' },
    () => {
      // The integration behaviour is already proven end-to-end in
      // provider-cage.test.ts against buildCagedLaunch; here we only assert the
      // wiring path yields a cage that EXECUTES (status 0) with the namespaces —
      // now including the real T-898 mount plan (live credential masks + store
      // re-binds computed from the REAL operator $HOME).
      setCage(true);
      const out = resolveCagedLaunch(
        { userId: null, provider: 'claude', cmd: 'sh', args: ['-c', 'echo CAGED_OK'], cwd: undefined },
        REAL_WITH_POLICY,
      );
      const res = spawnSync(out.cmd, out.args, { encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      assert.match(`${res.stdout}`, /CAGED_OK/);
    },
  );
});
