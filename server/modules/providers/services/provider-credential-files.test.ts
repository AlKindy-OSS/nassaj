/**
 * provider-credential-files.test — B-1771 parity guard: every row of the
 * credential-file table must sit exactly where resolveProviderEnv points that
 * provider for a member's own tree, so the watcher observes the files the CLIs
 * really write.
 */
import '@/shared/__tests__/sandbox-home.js';

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cred-files-db-')), 'db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const { initializeDatabase, closeConnection, userDb } = await import('@/modules/database/index.js');
const { resolveProviderEnv } = await import('@/services/isolation/resolve-provider-env.js');
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
const { PROVIDER_CREDENTIAL_FILES, watchedProviders } = await import('./provider-credential-files.js');
const { KNOWN_PROVIDERS } = await import('@/services/isolation/known-providers.js');
const { setNamespacedSecret } = await import('@/services/isolation/provider-secrets-store.js');

await initializeDatabase();
after(() => closeConnection());

/** Directory each provider's credential file lives in, per the spawn seam. */
const SEAM_DIR: Record<string, (env: NodeJS.ProcessEnv) => string> = {
  claude: (env) => env.CLAUDE_CONFIG_DIR!,
  codex: (env) => env.CODEX_HOME!,
  opencode: (env) => path.join(env.XDG_DATA_HOME!, 'opencode'),
  kimi: (env) => path.join(env.KIMI_CODE_HOME!, 'credentials'),
  agy: (env) => path.join(env.HOME!, '.gemini', 'antigravity-cli'),
  cursor: (env) => path.join(env.HOME!, '.config', 'cursor'),
};

describe('provider credential files table (B-1771)', () => {
  it('matches resolveProviderEnv for every row', () => {
    const userId = userDb.createUser('cred-files', 'hash', 'user').id;
    for (const row of PROVIDER_CREDENTIAL_FILES.filter((spec) => !spec.legacy && spec.provider !== 'provider-secrets')) {
      const seam = SEAM_DIR[row.provider];
      assert.ok(seam, `no seam mapping for ${row.provider}`);
      const env = resolveProviderEnv(userId, row.provider, process.env, 'agent', { honorGrants: false });
      assert.equal(path.join(userConfigDir(userId), row.dir), seam(env), row.provider);
    }
  });

  it('watches a credential file for every provider the isolation seam knows', () => {
    const watched = watchedProviders();
    assert.deepEqual(KNOWN_PROVIDERS.filter((provider) => !watched.has(provider)), []);
  });

  it('marks only providers without an isolation body as legacy', () => {
    for (const row of PROVIDER_CREDENTIAL_FILES.filter((spec) => spec.legacy)) {
      assert.ok(!(KNOWN_PROVIDERS as readonly string[]).includes(row.provider), row.provider);
    }
  });

  it('points the provider-secrets row at the file the store writes', () => {
    const userId = userDb.createUser('cred-files-secrets', 'hash', 'user').id;
    setNamespacedSecret(userId, 'local-model', 'probe', 'value');
    const row = PROVIDER_CREDENTIAL_FILES.find((spec) => spec.provider === 'provider-secrets')!;
    assert.ok(fs.existsSync(path.join(userConfigDir(userId), row.dir, row.file)));
  });
});
