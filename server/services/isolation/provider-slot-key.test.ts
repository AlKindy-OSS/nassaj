import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  _resetProviderSecretsServerKeyCache,
  setProviderKey,
  setSharedVendorKey,
} from '@/services/isolation/provider-secrets-store.js';
import { resolveSlotKey } from '@/services/isolation/provider-slot-key.js';

/**
 * T-1260 acceptance: ZERO behavioural change, proven on the WHOLE matrix rather
 * than on the two paths the first draft assumed were the only ones.
 *
 * The matrix is (member key present?) × (shared key present?) × (sharedFallback?)
 * × (member id vs no identity) = 24 cells, and each cell asserts BOTH the key
 * handed out and the scope it came from — because wave C's disclosure contract
 * reads `scope` from this same call, and a right key with a wrong provenance is
 * the bug that shipped as B-362.
 *
 * The expectations below are the pre-refactor semantics written out longhand:
 *   sharedFallback:false ≡ getProviderKey(userId ?? SYSTEM_SCOPE, slot)
 *   sharedFallback:true  ≡ that, then getProviderKey(SYSTEM_SCOPE, slot)
 */

function withSandbox(): { homeDir: string; restore: () => void } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-slot-'));
  const originalHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => homeDir;

  const originalKey = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  _resetProviderSecretsServerKeyCache();

  return {
    homeDir,
    restore: () => {
      (os as unknown as { homedir: () => string }).homedir = originalHomedir;
      if (originalKey === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
      else process.env.NASSAJ_PROVIDER_SECRETS_KEY = originalKey;
      _resetProviderSecretsServerKeyCache();
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

const MEMBER = '7';

type Cell = {
  member: boolean;
  shared: boolean;
  sharedFallback: boolean;
  identified: boolean;
  expect: { key: string; scope: 'user' | 'shared' } | null;
};

const MATRIX: Cell[] = [];
for (const member of [false, true]) {
  for (const shared of [false, true]) {
    for (const sharedFallback of [false, true]) {
      for (const identified of [false, true]) {
        // Pre-refactor truth table, derived from the two idioms, not from the
        // implementation under test.
        let expect: Cell['expect'] = null;
        if (!identified) {
          // `userId ?? SYSTEM_SCOPE` collapsed to the shared store for BOTH
          // idioms when there was no identity — fallback never entered into it.
          expect = shared ? { key: 'sk-shared', scope: 'shared' } : null;
        } else if (member) {
          expect = { key: 'sk-member', scope: 'user' };
        } else if (sharedFallback && shared) {
          expect = { key: 'sk-shared', scope: 'shared' };
        }
        MATRIX.push({ member, shared, sharedFallback, identified, expect });
      }
    }
  }
}

for (const cell of MATRIX) {
  const label =
    `member=${cell.member} shared=${cell.shared} `
    + `fallback=${cell.sharedFallback} identified=${cell.identified}`;

  test(`resolveSlotKey matrix — ${label}`, () => {
    const sandbox = withSandbox();
    try {
      if (cell.member) setProviderKey(MEMBER, 'glm', 'sk-member');
      if (cell.shared) setSharedVendorKey('glm', 'sk-shared');

      const actual = resolveSlotKey(cell.identified ? MEMBER : null, 'glm', {
        sharedFallback: cell.sharedFallback,
      });

      assert.deepEqual(actual, cell.expect);
    } finally {
      sandbox.restore();
    }
  });
}

test('resolveSlotKey: a member key never leaks to a different member', () => {
  const sandbox = withSandbox();
  try {
    setProviderKey('7', 'glm', 'sk-member-7');
    assert.equal(resolveSlotKey('8', 'glm', { sharedFallback: false }), null);
    assert.equal(resolveSlotKey('8', 'glm', { sharedFallback: true }), null);
  } finally {
    sandbox.restore();
  }
});

test('resolveSlotKey: an unknown slot id resolves to null, it does not throw', () => {
  const sandbox = withSandbox();
  try {
    setProviderKey(MEMBER, 'glm', 'sk-member');
    assert.equal(
      resolveSlotKey(MEMBER, 'opencode' as 'glm', { sharedFallback: true }),
      null,
    );
  } finally {
    sandbox.restore();
  }
});

test("resolveSlotKey: '' is a call-site bug and still throws, as the store always did", () => {
  const sandbox = withSandbox();
  try {
    // Not folded into "no identity": B-342 was a hardcoded empty scope reading a
    // directory that did not exist and reporting "no key" forever. Absorbing ''
    // here would restore exactly that silence.
    assert.throws(() => resolveSlotKey('', 'glm', { sharedFallback: true }), TypeError);
  } finally {
    sandbox.restore();
  }
});
