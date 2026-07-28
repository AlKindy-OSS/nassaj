/**
 * opencode-baseurl-guard.test.js — GL-3 + GL-6(server-local), ADR-062.
 *
 * Pure filesystem/string unit test: no DB, no SDK, no spawn, no opencode binary.
 *
 * Proves:
 *  - `${VAR}` and `{env:VAR}` interpolations are EXPANDED against the env BEFORE the
 *    host is compared to the allowlist (the OCC-2 condition), including a template that
 *    expands to the vetted host (allowed) vs one that expands to a foreign host (refused).
 *  - a residual/unsupported interpolation (missing var, `{file:…}`) is refused (fail-closed).
 *  - a foreign / unparseable host is refused; the vetted carrier host is allowed.
 *  - config fail-closed posture: absent → no-op; symlink → refuse; invalid JSON → refuse.
 *  - the server-local guard refuses `serve` and any non-loopback `--hostname`/`--host`
 *    binding (space- and `=`-form), and passes loopback + the default (no hostname).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  ALLOWED_CARRIER_HOST,
  OPENCODE_BASEURL_NOT_ALLOWED,
  assertOpenCodeBaseUrlAllowed,
  assertOpenCodeCarrierServerLocal,
  collectOpenCodeBaseUrls,
  expandOpenCodeInterpolation,
  hostOf,
  isCarrierHostAllowed,
  isLoopbackHost,
  resolveOpenCodeConfigPath,
} from './opencode-baseurl-guard.js';

const CARRIER_URL = 'https://api.z.ai/api/anthropic';

/** Runs `fn`, returns the error it throws, or fails the test if it does not throw. */
function captureThrow(fn, context = '') {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail(`expected a throw${context ? ` (${context})` : ''}, but none was thrown`);
  return null;
}

async function withTempConfig(contents, run, { asSymlink = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-baseurl-guard-'));
  const configPath = path.join(dir, 'opencode.json');
  try {
    if (asSymlink) {
      const realTarget = path.join(dir, 'real-opencode.json');
      await writeFile(realTarget, contents, 'utf8');
      await symlink(realTarget, configPath);
    } else if (contents !== null) {
      await writeFile(configPath, contents, 'utf8');
    }
    await run(configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const glmConfig = (baseURL) => JSON.stringify({
  provider: { glm: { npm: '@ai-sdk/anthropic', options: { baseURL } } },
});

describe('GL-3 — allowlist constant + host parsing', () => {
  it('derives the single approved host from the vetted carrier constant', () => {
    assert.equal(ALLOWED_CARRIER_HOST, 'api.z.ai');
    assert.equal(hostOf(CARRIER_URL), 'api.z.ai');
    assert.equal(isCarrierHostAllowed('api.z.ai'), true);
  });

  it('rejects foreign / sibling / unparseable hosts (exact match, no widening)', () => {
    assert.equal(isCarrierHostAllowed('api.competitor.example'), false);
    assert.equal(isCarrierHostAllowed('z.ai'), false, 'no subdomain widening');
    assert.equal(isCarrierHostAllowed('evil-api.z.ai.attacker.com'), false);
    assert.equal(isCarrierHostAllowed(null), false);
    assert.equal(hostOf('not a url'), null);
  });
});

describe('GL-3 — ${VAR} / {env:…} expansion BEFORE the host check (OCC-2)', () => {
  it('expands ${VAR} and {env:VAR} to their env values', () => {
    const env = { GLM_HOST: 'https://api.z.ai/api/anthropic', PART: 'z.ai' };
    assert.deepEqual(expandOpenCodeInterpolation('${GLM_HOST}', env), {
      expanded: 'https://api.z.ai/api/anthropic',
      unresolved: false,
    });
    assert.deepEqual(expandOpenCodeInterpolation('{env:GLM_HOST}', env), {
      expanded: 'https://api.z.ai/api/anthropic',
      unresolved: false,
    });
    assert.equal(expandOpenCodeInterpolation('https://api.${PART}/api/anthropic', env).expanded,
      'https://api.z.ai/api/anthropic');
  });

  it('flags a residual/unsupported template as unresolved (missing var, {file:…})', () => {
    assert.equal(expandOpenCodeInterpolation('${MISSING}/x', {}).unresolved, true);
    assert.equal(expandOpenCodeInterpolation('{file:/etc/passwd}', {}).unresolved, true);
    assert.equal(expandOpenCodeInterpolation(42, {}).unresolved, true);
  });

  it('ALLOWS a config whose baseURL is `${VAR}` expanding to the vetted host', async () => {
    await withTempConfig(glmConfig('${GLM_BASE}'), (configPath) => {
      assert.doesNotThrow(() =>
        assertOpenCodeBaseUrlAllowed(configPath, { GLM_BASE: CARRIER_URL }));
    });
  });

  it('REFUSES a config whose `${VAR}` expands to a FOREIGN host', async () => {
    await withTempConfig(glmConfig('${GLM_BASE}'), (configPath) => {
      const err = captureThrow(() =>
        assertOpenCodeBaseUrlAllowed(configPath, { GLM_BASE: 'https://api.competitor.example/anthropic' }));
      assert.equal(err.code, OPENCODE_BASEURL_NOT_ALLOWED);
      assert.equal(err.reason, 'disallowed_host');
    });
  });

  it('REFUSES a config whose `{env:…}` var is unset (un-vettable → fail-closed)', async () => {
    await withTempConfig(glmConfig('{env:GLM_BASE}'), (configPath) => {
      const err = captureThrow(() => assertOpenCodeBaseUrlAllowed(configPath, {}));
      assert.equal(err.code, OPENCODE_BASEURL_NOT_ALLOWED);
    });
  });
});

describe('GL-3 — literal host allowlist over opencode.json', () => {
  it('ALLOWS the vetted literal carrier host', async () => {
    await withTempConfig(glmConfig(CARRIER_URL), (configPath) => {
      assert.doesNotThrow(() => assertOpenCodeBaseUrlAllowed(configPath, {}));
    });
  });

  it('REFUSES a literal foreign host', async () => {
    await withTempConfig(glmConfig('https://api.competitor.example/v1'), (configPath) => {
      const err = captureThrow(() => assertOpenCodeBaseUrlAllowed(configPath, {}));
      assert.equal(err.code, OPENCODE_BASEURL_NOT_ALLOWED);
    });
  });

  it('collects options.baseURL and the provider.<id>.baseURL shorthand', () => {
    const found = collectOpenCodeBaseUrls({
      provider: {
        glm: { options: { baseURL: CARRIER_URL } },
        other: { baseURL: 'https://x.example' },
        none: { npm: 'x' },
      },
    });
    assert.deepEqual(found.map((f) => f.label).sort(), [
      'provider.glm.options.baseURL',
      'provider.other.baseURL',
    ]);
  });
});

describe('GL-3 — config fail-closed posture', () => {
  it('NO-OP when opencode.json is absent (nothing routes)', async () => {
    await withTempConfig(null, (configPath) => {
      assert.doesNotThrow(() => assertOpenCodeBaseUrlAllowed(configPath, {}));
    });
  });

  it('REFUSES a symlinked opencode.json (write-through / un-attestable)', async () => {
    await withTempConfig(glmConfig(CARRIER_URL), (configPath) => {
      const err = captureThrow(() => assertOpenCodeBaseUrlAllowed(configPath, {}));
      assert.equal(err.reason, 'symlink');
    }, { asSymlink: true });
  });

  it('REFUSES invalid JSON (cannot prove absence of a bad override)', async () => {
    await withTempConfig('{ not json', (configPath) => {
      const err = captureThrow(() => assertOpenCodeBaseUrlAllowed(configPath, {}));
      assert.equal(err.reason, 'invalid_json');
    });
  });
});

describe('GL-3 — per-user config path resolution', () => {
  it('uses XDG_CONFIG_HOME/opencode/opencode.json when isolated', () => {
    const p = resolveOpenCodeConfigPath({ XDG_CONFIG_HOME: '/home/dev/.nassaj-users/9/.config' });
    assert.equal(p, '/home/dev/.nassaj-users/9/.config/opencode/opencode.json');
  });

  it('falls back to ~/.config/opencode in shared mode', () => {
    const p = resolveOpenCodeConfigPath({});
    assert.equal(p, path.join(os.homedir(), '.config', 'opencode', 'opencode.json'));
  });
});

describe('GL-6 — server confined to localhost', () => {
  it('passes the default one-shot run args (loopback by default)', () => {
    assert.doesNotThrow(() =>
      assertOpenCodeCarrierServerLocal(['run', '--format', 'json', 'do the thing']));
  });

  it('allows an explicit loopback bind (space- and =-form)', () => {
    assert.doesNotThrow(() => assertOpenCodeCarrierServerLocal(['run', '--hostname', '127.0.0.1']));
    assert.doesNotThrow(() => assertOpenCodeCarrierServerLocal(['run', '--host=::1']));
    assert.doesNotThrow(() => assertOpenCodeCarrierServerLocal(['run', '--hostname', 'localhost']));
  });

  it('REFUSES a `serve` subcommand', () => {
    const err = captureThrow(() => assertOpenCodeCarrierServerLocal(['serve']));
    assert.equal(err.code, OPENCODE_BASEURL_NOT_ALLOWED);
    assert.equal(err.reason, 'server_exposed');
  });

  it('REFUSES a non-loopback hostname bind (space- and =-form)', () => {
    for (const args of [
      ['run', '--hostname', '0.0.0.0'],
      ['run', '--host', '192.168.1.5'],
      ['run', '--hostname=0.0.0.0'],
      ['run', '-h', '0.0.0.0'],
    ]) {
      const err = captureThrow(() => assertOpenCodeCarrierServerLocal(args), JSON.stringify(args));
      assert.equal(err.reason, 'server_exposed');
    }
  });

  it('loopback predicate accepts 127.0.0.0/8, ::1, localhost and rejects public', () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('127.5.5.5'), true);
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('[::1]'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('0.0.0.0'), false);
    assert.equal(isLoopbackHost('10.0.0.1'), false);
    assert.equal(isLoopbackHost(''), false);
  });
});
