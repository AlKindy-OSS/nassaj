import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getTempRootVerdictCacheSize,
  getTempRoots,
  isForeignTempRootPath,
  resetTempRootGuardCache,
} from './temp-root-guard.js';

/** B-1620 unit tests: which cwds count as a temp root foreign to the database. */

const LIVE_DB = '/srv/b1620-live/.local/share/nassaj-dev/db.sqlite';
const FAKE_HOME = '/srv/b1620-home';
const ENV_KEYS = ['HOME', 'TMPDIR', 'NASSAJ_SCRATCHPAD_BASE'] as const;

/** Runs `body` with the given env (undefined = unset), restoring it and the guard cache after. */
function withEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, body: () => void): void {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (!(key in env)) continue;
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetTempRootGuardCache();
  try {
    body();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetTempRootGuardCache();
  }
}

const foreign = (candidate: string, db = LIVE_DB) => isForeignTempRootPath(candidate, db);

test('system temp roots are foreign to a database outside them', () => {
  withEnv({ HOME: FAKE_HOME, TMPDIR: '/var/tmp', NASSAJ_SCRATCHPAD_BASE: undefined }, () => {
    assert.equal(foreign('/tmp/x'), true);
    assert.equal(foreign('/var/tmp/x'), true);
    assert.equal(foreign('/dev/shm/x'), true);
    assert.equal(foreign('/var/tmp/shaqaiq-codex/deep/dir'), true);
  });
});

test('matching respects path-segment boundaries', () => {
  withEnv({ HOME: FAKE_HOME, TMPDIR: '/var/tmp', NASSAJ_SCRATCHPAD_BASE: undefined }, () => {
    assert.equal(foreign('/tmpwork/x'), false);
    assert.equal(foreign('/var/tmpfoo/x'), false);
    assert.equal(foreign('/srv/b1620-home/Project/app'), false);
  });
});

test('a custom os.tmpdir() is a temp root', () => {
  withEnv({ HOME: FAKE_HOME, TMPDIR: '/srv/b1620-custom-tmp', NASSAJ_SCRATCHPAD_BASE: undefined }, () => {
    assert.equal(os.tmpdir(), '/srv/b1620-custom-tmp');
    assert.equal(foreign('/srv/b1620-custom-tmp/run'), true);
    assert.equal(foreign('/srv/b1620-other/run'), false);
  });
});

test('TMPDIR=$HOME and TMPDIR=/ are ignored', () => {
  withEnv({ HOME: FAKE_HOME, TMPDIR: FAKE_HOME, NASSAJ_SCRATCHPAD_BASE: undefined }, () => {
    assert.equal(foreign(`${FAKE_HOME}/Project/app`), false);
    assert.ok(!getTempRoots().includes(FAKE_HOME));
  });
  withEnv({ HOME: FAKE_HOME, TMPDIR: '/', NASSAJ_SCRATCHPAD_BASE: undefined }, () => {
    assert.equal(foreign('/srv/anything'), false);
    assert.ok(!getTempRoots().includes('/'));
  });
  withEnv({ HOME: FAKE_HOME, TMPDIR: '/srv', NASSAJ_SCRATCHPAD_BASE: undefined }, () => {
    assert.equal(foreign('/srv/b1620-other/x'), false, 'a root containing a home is discarded');
  });
});

test('the scratchpad base, its parent and ~/.cache/tmp are temp roots', () => {
  withEnv({
    HOME: FAKE_HOME, TMPDIR: '/var/tmp', NASSAJ_SCRATCHPAD_BASE: '/srv/b1620-scratch/tmp/claude-1000',
  }, () => {
    assert.equal(foreign('/srv/b1620-scratch/tmp/claude-1000/sess/x'), true);
    assert.equal(foreign('/srv/b1620-scratch/tmp/other'), true);
    assert.equal(foreign(`${FAKE_HOME}/.cache/tmp/codex-run`), true);
    assert.equal(foreign(`${FAKE_HOME}/.cache/other`), false);
  });
  withEnv({ HOME: FAKE_HOME, TMPDIR: '/var/tmp', NASSAJ_SCRATCHPAD_BASE: `${FAKE_HOME}/claude-1000` }, () => {
    assert.equal(foreign(`${FAKE_HOME}/Project/app`), false, 'a scratch parent equal to HOME is discarded');
  });
});

test('member homes contribute their own ~/.cache/tmp', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'b1620-home-'));
  try {
    mkdirSync(path.join(home, '.nassaj-users', '3'), { recursive: true });
    withEnv({ HOME: home, NASSAJ_SCRATCHPAD_BASE: undefined }, () => {
      assert.equal(foreign(path.join(home, '.nassaj-users', '3', '.cache', 'tmp', 'x')), true);
      assert.equal(foreign(path.join(home, '.nassaj-users', '3', 'Project')), false);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a symlinked project that resolves into a temp root is rejected', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'b1620-link-home-'));
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'b1620-link-tmp-'));
  try {
    const real = path.join(tmp, 'real-project');
    mkdirSync(real);
    const link = path.join(home, 'project');
    symlinkSync(real, link);
    // HOME sits inside the outer temp dir, so that outer root is discarded and
    // only the realpath form (inside TMPDIR) can match.
    withEnv({ HOME: home, TMPDIR: tmp, NASSAJ_SCRATCHPAD_BASE: undefined }, () => {
      assert.equal(foreign(path.join(home, 'plain')), false);
      assert.equal(foreign(link), true);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a missing path is judged lexically and never throws', () => {
  withEnv({ HOME: FAKE_HOME, TMPDIR: '/var/tmp', NASSAJ_SCRATCHPAD_BASE: undefined }, () => {
    assert.doesNotThrow(() => foreign('/var/tmp/b1620-does-not-exist/x/y'));
    assert.equal(foreign('/var/tmp/b1620-does-not-exist/x/y'), true);
    assert.equal(foreign('/srv/b1620-does-not-exist'), false);
  });
});

test('a database inside the same temp root owns its paths (S2)', () => {
  withEnv({ HOME: FAKE_HOME, TMPDIR: '/var/tmp', NASSAJ_SCRATCHPAD_BASE: undefined }, () => {
    assert.equal(foreign('/var/tmp/a/x', '/var/tmp/b/auth.db'), false);
    assert.equal(foreign('/tmp/a/x', '/var/tmp/b/auth.db'), true, 'another temp root stays foreign');
  });
});

test('a database inside the same test run root owns its case paths', () => {
  const caseRoot = '/var/tmp/nassaj-server-tests-B1620x/case-1';
  withEnv({ HOME: `${caseRoot}/home`, TMPDIR: `${caseRoot}/tmp`, NASSAJ_SCRATCHPAD_BASE: undefined }, () => {
    assert.equal(foreign(`${caseRoot}/tmp/project`, `${caseRoot}/auth.db`), false);
    assert.equal(foreign(`${caseRoot}/tmp/project`, LIVE_DB), true);
  });
});

test('verdicts are memoised in a cache bounded at 512 entries', () => {
  withEnv({ HOME: FAKE_HOME, TMPDIR: '/var/tmp', NASSAJ_SCRATCHPAD_BASE: undefined }, () => {
    assert.equal(foreign('/var/tmp/memo'), true);
    assert.equal(foreign('/var/tmp/memo'), true);
    assert.equal(getTempRootVerdictCacheSize(), 1, 'a repeated path is served from the cache');
    let peak = 0;
    for (let i = 0; i < 1500; i += 1) {
      foreign(`/var/tmp/memo-${i}`);
      peak = Math.max(peak, getTempRootVerdictCacheSize());
    }
    assert.equal(peak, 512, 'the cache never exceeds its bound');
    assert.ok(getTempRootVerdictCacheSize() <= 512);
    assert.equal(foreign('/var/tmp/memo'), true, 'still correct after the bounded cache rolls over');
    resetTempRootGuardCache();
    assert.equal(getTempRootVerdictCacheSize(), 0);
  });
});

test('the scratchpad parent is a root only when named tmp or inside another root (M4)', () => {
  withEnv({ HOME: FAKE_HOME, TMPDIR: '/var/tmp', NASSAJ_SCRATCHPAD_BASE: '/srv/b1620-scratch/claude' }, () => {
    assert.equal(foreign('/srv/b1620-scratch/claude/sess'), true, 'the base itself is a root');
    assert.equal(foreign('/srv/b1620-scratch/real-project'), false, 'its parent is not');
    assert.ok(!getTempRoots().includes('/srv/b1620-scratch'));
  });
  withEnv({ HOME: FAKE_HOME, TMPDIR: '/var/tmp', NASSAJ_SCRATCHPAD_BASE: '/srv/claude' }, () => {
    assert.equal(foreign('/srv/real-project'), false, 'a base directly under /srv never makes /srv a root');
  });
  withEnv({ HOME: FAKE_HOME, TMPDIR: '/srv/b1620-tmpdir', NASSAJ_SCRATCHPAD_BASE: '/srv/b1620-tmpdir/run/claude' }, () => {
    assert.ok(getTempRoots().includes('/srv/b1620-tmpdir/run'), 'a parent inside another root is kept');
  });
  withEnv({ HOME: FAKE_HOME, TMPDIR: '/var/tmp', NASSAJ_SCRATCHPAD_BASE: '/srv/b1620-x/tmp/claude-1000' }, () => {
    assert.ok(getTempRoots().includes('/srv/b1620-x/tmp'), 'a parent named tmp is kept');
    assert.equal(foreign('/srv/b1620-x/other'), false);
  });
});
