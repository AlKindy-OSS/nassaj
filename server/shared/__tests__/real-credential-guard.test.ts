/**
 * real-credential-guard.test — B-1771: a test helper that writes or removes a
 * credential file must refuse any target inside the REAL account's credential
 * trees (taken from the passwd entry, not $HOME), so an ad-hoc run with the
 * operator's HOME fails fast instead of overwriting a live login.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { SANDBOX_HOME } from './sandbox-home.js';
import { assertOutsideRealCredentials, realCredentialRoots } from './real-credential-guard.js';
import { PROVIDER_CREDENTIAL_FILES } from '@/modules/providers/services/provider-credential-files.js';

const realHome = os.userInfo().homedir;

describe('real-credential-guard (B-1771)', () => {
  it('refuses every member credential file of every provider under the real home', () => {
    for (const row of PROVIDER_CREDENTIAL_FILES) {
      const target = path.join(realHome, '.nassaj-users', '1', row.dir, row.file);
      assert.throws(() => assertOutsideRealCredentials(target), /real account/u, row.provider);
    }
  });

  it('refuses operator dotfile credential roots and the users root itself', () => {
    for (const rel of ['.nassaj-users', '.claude/.credentials.json', '.codex/auth.json', '.gemini/oauth_creds.json',
      '.hermes/auth.json', '.cursor', '.qwen/oauth_creds.json', '.kimi-code/credentials/kimi-code.json',
      '.local/share/opencode/auth.json', '.config/gcloud', '.nassaj-provider-secrets.key']) {
      assert.throws(() => assertOutsideRealCredentials(path.join(realHome, rel)), /real account/u, rel);
    }
    assert.ok(realCredentialRoots().length >= 10);
  });

  it('allows the sandbox home and ordinary paths', () => {
    assertOutsideRealCredentials(path.join(SANDBOX_HOME, '.nassaj-users', '1', '.claude', '.credentials.json'));
    assertOutsideRealCredentials(path.join(realHome, 'Project', 'x', '.claude', 'settings.json'));
  });

  it('sandbox-home points HOME and CLAUDE_CONFIG_DIR away from the real account and strips credentials', () => {
    assert.equal(os.homedir(), SANDBOX_HOME);
    assert.equal(process.env.CLAUDE_CONFIG_DIR, path.join(SANDBOX_HOME, '.claude'));
    for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_HOME']) {
      assert.equal(process.env[name], undefined, name);
    }
  });
});
