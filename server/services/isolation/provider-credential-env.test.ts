/**
 * provider-credential-env.test — B-1771 parity guard. Test tooling strips the
 * names in provider-credential-env.js; this proves that list covers every
 * credential variable and credential root the spawn seam (resolve-provider-env.js)
 * ever sets, so a new provider root cannot reach tests unisolated.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  INHERITED_CREDENTIAL_ENV,
  PROVIDER_STATE_ROOT_ENV,
  isProviderCredentialEnvName,
} from './provider-credential-env.js';
import { INHERITED_CREDENTIAL_ENV as RESOLVER_LIST } from './resolve-provider-env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const resolverSource = fs.readFileSync(path.join(here, 'resolve-provider-env.js'), 'utf8');
/** Env names the resolver sets that are switches, not credentials or roots. */
const NON_CREDENTIAL_SWITCHES = new Set(['DISABLE_AUTOUPDATER', 'OPENCODE_DISABLE_AUTOUPDATE']);

describe('provider-credential-env (B-1771)', () => {
  it('is the very list the resolver strips', () => {
    assert.equal(RESOLVER_LIST, INHERITED_CREDENTIAL_ENV);
  });

  it('covers every env name resolveProviderEnv assigns, except updater switches and HOME', () => {
    const assigned = new Set([...resolverSource.matchAll(/\benv\.([A-Z][A-Z0-9_]+)\s*=[^=]/gu)].map((m) => m[1]));
    assert.ok(assigned.has('CLAUDE_CONFIG_DIR') && assigned.has('CODEX_HOME'), 'scan found the roots');
    const uncovered = [...assigned].filter((name) => name !== 'HOME'
      && !NON_CREDENTIAL_SWITCHES.has(name) && !isProviderCredentialEnvName(name));
    assert.deepEqual(uncovered, []);
  });

  it('covers every vendor key the resolver injects', () => {
    const block = /const VENDOR_KEY_ENV = Object\.freeze\(\{([^}]*)\}/u.exec(resolverSource)?.[1] ?? '';
    const keys = [...block.matchAll(/'([A-Z_]+)'/gu)].map((m) => m[1]);
    assert.ok(keys.length >= 3, 'scan found the vendor keys');
    for (const key of keys) assert.ok(isProviderCredentialEnvName(key), key);
  });

  it('flags unlisted vendor secrets by suffix and keeps ordinary names', () => {
    for (const name of ['DASHSCOPE_API_KEY', 'NOUS_API_KEY', 'OLLAMA_API_KEY', 'X_REFRESH_TOKEN']) {
      assert.equal(isProviderCredentialEnvName(name), true, name);
    }
    for (const name of ['PATH', 'HOME', 'NODE_ENV', 'TMPDIR', 'GITHUB_ACTIONS']) {
      assert.equal(isProviderCredentialEnvName(name), false, name);
    }
    assert.ok(PROVIDER_STATE_ROOT_ENV.includes('CODEX_HOME'));
  });
});
