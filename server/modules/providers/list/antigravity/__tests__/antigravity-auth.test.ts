import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AntigravityProviderAuth } from '@/modules/providers/list/antigravity/antigravity-auth.provider.js';

/**
 * AntigravityProviderAuth captures `os.homedir()` in its constructor, so each
 * test must patch the homedir before constructing the auth instance and restore
 * the original implementation in a `finally` block to keep `node:test` runs
 * order-independent.
 */
const patchHomeDir = (nextHomeDir: string): (() => void) => {
  const original = os.homedir;
  (os as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as { homedir: () => string }).homedir = original;
  };
};

async function withFakeHome(
  setup: (homeDir: string) => Promise<void> | void,
  runTest: (auth: AntigravityProviderAuth) => Promise<void>,
): Promise<void> {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'agy-auth-'));
  const restoreHomeDir = patchHomeDir(tempHome);
  try {
    await setup(tempHome);
    const auth = new AntigravityProviderAuth();
    await runTest(auth);
  } finally {
    restoreHomeDir();
    await rm(tempHome, { recursive: true, force: true });
  }
}

test('getStatus reports installed=false when the agy binary is missing', async () => {
  await withFakeHome(
    () => {
      /* no agy binary, no brain dir */
    },
    async (auth) => {
      const status = await auth.getStatus();
      assert.equal(status.provider, 'antigravity');
      assert.equal(status.installed, false);
      assert.equal(status.authenticated, false);
      assert.equal(status.email, null);
      assert.equal(status.method, null);
      assert.match(status.error ?? '', /agy CLI not found/);
    },
  );
});

test('getStatus reports authenticated=false when agy exists but the brain directory is empty', async () => {
  await withFakeHome(
    async (homeDir) => {
      const binDir = path.join(homeDir, '.local', 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(path.join(binDir, 'agy'), '#!/usr/bin/env node\n', 'utf8');
      // brain directory does not exist yet — readdir will throw and hasBrainSession returns false
    },
    async (auth) => {
      const status = await auth.getStatus();
      assert.equal(status.installed, true);
      assert.equal(status.authenticated, false);
      assert.match(status.error ?? '', /No sessions found/);
    },
  );
});

test('getStatus reports authenticated=true when at least one brain UUID folder exists', async () => {
  await withFakeHome(
    async (homeDir) => {
      const binDir = path.join(homeDir, '.local', 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(path.join(binDir, 'agy'), '#!/usr/bin/env node\n', 'utf8');

      const brainDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain');
      await mkdir(path.join(brainDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), {
        recursive: true,
      });
    },
    async (auth) => {
      const status = await auth.getStatus();
      assert.equal(status.installed, true);
      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'google-oauth');
      assert.equal(status.error, undefined);
    },
  );
});

test('getStatus surfaces the Google client_email when ADC credentials are present', async () => {
  await withFakeHome(
    async (homeDir) => {
      const binDir = path.join(homeDir, '.local', 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(path.join(binDir, 'agy'), '#!/usr/bin/env node\n', 'utf8');

      const brainDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain');
      await mkdir(path.join(brainDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), {
        recursive: true,
      });

      const adcDir = path.join(homeDir, '.config', 'gcloud');
      await mkdir(adcDir, { recursive: true });
      await writeFile(
        path.join(adcDir, 'application_default_credentials.json'),
        JSON.stringify({ client_email: 'user@example.com', other: 'noise' }),
        'utf8',
      );
    },
    async (auth) => {
      const status = await auth.getStatus();
      assert.equal(status.email, 'user@example.com');
      assert.equal(status.authenticated, true);
    },
  );
});

test('getStatus falls back to .gemini/oauth_creds.json when ADC is missing', async () => {
  await withFakeHome(
    async (homeDir) => {
      const binDir = path.join(homeDir, '.local', 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(path.join(binDir, 'agy'), '#!/usr/bin/env node\n', 'utf8');

      const brainDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain');
      await mkdir(path.join(brainDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), {
        recursive: true,
      });

      const geminiDir = path.join(homeDir, '.gemini');
      await mkdir(geminiDir, { recursive: true });
      await writeFile(
        path.join(geminiDir, 'oauth_creds.json'),
        JSON.stringify({ email: 'gemini-user@example.com' }),
        'utf8',
      );
    },
    async (auth) => {
      const status = await auth.getStatus();
      assert.equal(status.email, 'gemini-user@example.com');
    },
  );
});

test('getStatus falls back to the agy CLI log when no credential files exist', async () => {
  await withFakeHome(
    async (homeDir) => {
      const binDir = path.join(homeDir, '.local', 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(path.join(binDir, 'agy'), '#!/usr/bin/env node\n', 'utf8');

      const brainDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain');
      await mkdir(path.join(brainDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), {
        recursive: true,
      });

      const logDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'log');
      await mkdir(logDir, { recursive: true });
      // Older log has a stale identity; the newest file must win.
      await writeFile(
        path.join(logDir, 'cli-20260101_000000.log'),
        'I0101 server_oauth.go:212] applyAuthResult: email=old@example.com, authMethod=consumer, quotaProject=\n',
        'utf8',
      );
      await writeFile(
        path.join(logDir, 'cli-20260609_213435.log'),
        'I0609 server_oauth.go:212] applyAuthResult: email=agy-user@example.com, authMethod=consumer, quotaProject=\n',
        'utf8',
      );
    },
    async (auth) => {
      const status = await auth.getStatus();
      assert.equal(status.email, 'agy-user@example.com');
      assert.equal(status.authenticated, true);
    },
  );
});

test('getStatus returns null email when credential files contain unparseable JSON', async () => {
  await withFakeHome(
    async (homeDir) => {
      const binDir = path.join(homeDir, '.local', 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(path.join(binDir, 'agy'), '#!/usr/bin/env node\n', 'utf8');

      const brainDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain');
      await mkdir(path.join(brainDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), {
        recursive: true,
      });

      const adcDir = path.join(homeDir, '.config', 'gcloud');
      await mkdir(adcDir, { recursive: true });
      await writeFile(path.join(adcDir, 'application_default_credentials.json'), 'not json', 'utf8');
    },
    async (auth) => {
      const status = await auth.getStatus();
      assert.equal(status.email, null);
      assert.equal(status.authenticated, true);
    },
  );
});

test('getStatus always returns the documented ProviderAuthStatus shape', async () => {
  await withFakeHome(
    () => undefined,
    async (auth) => {
      const status = await auth.getStatus();
      assert.equal(status.provider, 'antigravity');
      assert.equal(typeof status.installed, 'boolean');
      assert.equal(typeof status.authenticated, 'boolean');
      assert.ok(status.email === null || typeof status.email === 'string');
      assert.ok(status.method === null || typeof status.method === 'string');
    },
  );
});
