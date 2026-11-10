/**
 * antigravity-auth.isolation.test.ts — agy status is read from the tree the
 * CALLER runs on, not from whichever home the process happens to have.
 *
 * B-357. `AntigravityProviderAuth` resolved its brain/log/credential paths ONCE,
 * into instance fields, from `os.homedir()`. Every member therefore received the
 * OPERATOR's agy state — brain sessions, CLI logs, and the Google e-mail parsed
 * out of them.
 *
 * agy is always isolated (ADR-152 A1): a member's status is read from their own
 * tree (or a grantor's), never from the operator's.
 *
 * RUNNER: node:test via `npm run test:server`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { AntigravityProviderAuth } from '../antigravity-auth.provider.js';
import { userConfigDir } from '../../../../../services/isolation/provision-user-dirs.js';

const OPERATOR_EMAIL = 'operator@example.com';
const MEMBER_EMAIL = 'member@example.com';
const USER_ID = 424242;

/** Writes an agy brain session + a CLI log carrying `email` under `home`. */
function seedAgyState(home: string, email: string): void {
  const agyDir = path.join(home, '.gemini', 'antigravity-cli');
  mkdirSync(path.join(agyDir, 'brain', 'a-session-uuid'), { recursive: true });
  mkdirSync(path.join(agyDir, 'log'), { recursive: true });
  writeFileSync(
    path.join(agyDir, 'log', 'cli-2026-07-31.log'),
    `applyAuthResult: email=${email}, scope=openid\n`,
    'utf-8',
  );
}

describe('agy auth status — always read from the caller\'s own tree (B-357)', () => {
  let realHome: string;
  let fakeOperatorHome: string;

  before(() => {
    realHome = os.homedir();
    fakeOperatorHome = mkdtempSync(path.join(os.tmpdir(), 'agy-operator-'));
    seedAgyState(fakeOperatorHome, OPERATOR_EMAIL);
    // The agy BINARY is a host install, never per-user — without it getStatus
    // short-circuits on `installed: false` and every assertion below would pass
    // vacuously on a null e-mail.
    mkdirSync(path.join(fakeOperatorHome, '.local', 'bin'), { recursive: true });
    writeFileSync(path.join(fakeOperatorHome, '.local', 'bin', 'agy'), '#!/bin/sh\n', { encoding: 'utf-8', mode: 0o755 });
    // The provider reads the operator tree through os.homedir(); point it at a
    // scratch dir so the test never touches the real one.
    os.homedir = () => fakeOperatorHome;
  });

  after(() => {
    os.homedir = () => realHome;
  });

  it('isolated: a member never sees the operator identity', async () => {
    seedAgyState(userConfigDir(USER_ID), MEMBER_EMAIL);

    const status = await new AntigravityProviderAuth().getStatus(USER_ID);

    assert.equal(
      status.email,
      MEMBER_EMAIL,
      'isolated member must read their own tree, never the operator tree',
    );
    assert.notEqual(status.email, OPERATOR_EMAIL, 'operator identity leaked to a member');
  });

  it('isolated: a member with no agy state reads unauthenticated, not the operator session', async () => {

    const status = await new AntigravityProviderAuth().getStatus(999999);

    assert.equal(status.authenticated, false, 'a member with no brain dir must not inherit one');
    assert.equal(status.email, null, 'no state must mean no identity, not the operator identity');
  });

  it('a member with only operator agy state never reads the operator identity (no shared mode)', async () => {
    const status = await new AntigravityProviderAuth().getStatus(USER_ID + 1);

    assert.notEqual(status.email, OPERATOR_EMAIL, 'no sharing policy can hand a member the operator identity');
  });
});
