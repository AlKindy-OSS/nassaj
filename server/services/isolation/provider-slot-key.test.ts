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
import { SYSTEM_ACTOR } from '@/services/isolation/credential-actor.js';
import { resolveSlotKey } from '@/services/isolation/provider-slot-key.js';

/**
 * ADR-152 A1 §3.8 (D1): the install-wide vendor slot is INERT. A member gets
 * their own key or nothing; a missing or system actor gets nothing; a stored
 * install-wide key is never handed out, whoever asks.
 *
 * The matrix is (member key present?) × (install-wide key present?) ×
 * (member id vs no identity) = 8 cells, each asserting the key AND its scope.
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
  identified: boolean;
  expect: { key: string; scope: 'user' } | null;
};

const MATRIX: Cell[] = [];
for (const member of [false, true]) {
  for (const shared of [false, true]) {
    for (const identified of [false, true]) {
      // Only the member's own key ever resolves (D1): no identity, no key.
      const expect: Cell['expect'] = identified && member ? { key: 'sk-member', scope: 'user' } : null;
      MATRIX.push({ member, shared, identified, expect });
    }
  }
}

for (const cell of MATRIX) {
  const label =
    `member=${cell.member} install-wide=${cell.shared} identified=${cell.identified}`;

  test(`resolveSlotKey matrix — ${label}`, () => {
    const sandbox = withSandbox();
    try {
      if (cell.member) setProviderKey(MEMBER, 'glm', 'sk-member');
      if (cell.shared) setSharedVendorKey('glm', 'sk-shared');

      const actual = resolveSlotKey(cell.identified ? MEMBER : null, 'glm');

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
    assert.equal(resolveSlotKey('8', 'glm'), null);
  } finally {
    sandbox.restore();
  }
});

test('resolveSlotKey: an unknown slot id resolves to null, it does not throw', () => {
  const sandbox = withSandbox();
  try {
    setProviderKey(MEMBER, 'glm', 'sk-member');
    assert.equal(
      resolveSlotKey(MEMBER, 'opencode' as 'glm'),
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
    assert.throws(() => resolveSlotKey('', 'glm'), TypeError);
  } finally {
    sandbox.restore();
  }
});

test('resolveSlotKey: the system actor and undefined get null, even with an install-wide key (D1)', () => {
  const sandbox = withSandbox();
  try {
    for (const slot of ['kimi', 'deepseek', 'glm', 'qwen'] as const) {
      if (slot !== 'qwen') setSharedVendorKey(slot, `sk-install-wide-${slot}`);
      assert.equal(resolveSlotKey(SYSTEM_ACTOR as never, slot), null, slot);
      assert.equal(resolveSlotKey(undefined, slot), null, slot);
      assert.equal(resolveSlotKey(null, slot), null, slot);
    }
  } finally {
    sandbox.restore();
  }
});
