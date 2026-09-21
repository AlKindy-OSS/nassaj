import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadProviderSecretsKeyFile,
  resetProviderSecretsKeyCacheForTests,
} from './provider-secrets-key-manager.js';

async function fixture(run: (directory: string) => void | Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'provider-key-manager-'));
  try {
    await run(directory);
  } finally {
    resetProviderSecretsKeyCacheForTests();
    await rm(directory, { recursive: true, force: true });
  }
}

test('creates an exact 0600 key once and reads the same FD-validated bytes', async () => {
  await fixture((directory) => {
    const filePath = path.join(directory, 'key');
    const first = loadProviderSecretsKeyFile({ filePath });
    const second = loadProviderSecretsKeyFile({ filePath });
    assert.equal(first.length, 32);
    assert.deepEqual(second, first);
    assert.equal(fs.lstatSync(filePath).mode & 0o777, 0o600);
  });
});

test('existing short, permissive, symlink, hardlink and wrong-owner identities fail closed', async () => {
  await fixture((directory) => {
    const cases: Array<() => void> = [];
    const short = path.join(directory, 'short');
    fs.writeFileSync(short, 'short', { mode: 0o600 });
    cases.push(() => loadProviderSecretsKeyFile({ filePath: short }));

    const permissive = path.join(directory, 'permissive');
    fs.writeFileSync(permissive, Buffer.alloc(32), { mode: 0o644 });
    cases.push(() => loadProviderSecretsKeyFile({ filePath: permissive }));

    const target = path.join(directory, 'target');
    fs.writeFileSync(target, Buffer.alloc(32), { mode: 0o600 });
    const symlink = path.join(directory, 'symlink');
    fs.symlinkSync(target, symlink);
    cases.push(() => loadProviderSecretsKeyFile({ filePath: symlink }));

    const hardlink = path.join(directory, 'hardlink');
    fs.linkSync(target, hardlink);
    cases.push(() => loadProviderSecretsKeyFile({ filePath: target }));

    const wrongOwner = path.join(directory, 'wrong-owner');
    fs.writeFileSync(wrongOwner, Buffer.alloc(32), { mode: 0o600 });
    cases.push(() => loadProviderSecretsKeyFile({
      filePath: wrongOwner,
      expectedUid: (process.geteuid?.() ?? process.getuid?.() ?? 0) + 1,
    }));

    for (const attempt of cases) assert.throws(attempt, /provider_secrets_key_file_insecure/);
    assert.equal(fs.readFileSync(short, 'utf8'), 'short', 'corrupt key is never regenerated');
  });
});
