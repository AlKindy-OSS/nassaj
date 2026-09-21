import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('low-level shared vendor primitives structurally reject Qwen without touching HOME', async (t) => {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-qwen-shared-guard-'));
  process.env.HOME = home;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const {
    getSharedVendorKey,
    setSharedVendorKey,
    deleteSharedVendorKey,
    setProviderKey,
  } = await import('@/services/isolation/provider-secrets-store.js');
  const { resolveSlotKey } = await import('@/services/isolation/provider-slot-key.js');

  assert.throws(() => setSharedVendorKey('qwen', 'sk-sp-never-written'), /no shared credential slot/);
  assert.throws(() => getSharedVendorKey('qwen'), /no shared credential slot/);
  assert.throws(() => deleteSharedVendorKey('qwen'), /no shared credential slot/);
  setProviderKey(7, 'qwen', 'sk-sp-personal-key');
  assert.deepEqual(resolveSlotKey(7, 'qwen', { sharedFallback: true }), {
    key: 'sk-sp-personal-key',
    scope: 'user',
  });
  assert.equal(resolveSlotKey(null, 'qwen', { sharedFallback: true }), null);
  assert.equal(
    fs.existsSync(path.join(home, '.nassaj-provider-secrets')),
    false,
    'rejected Qwen shared operations must not create the shared store',
  );
});
