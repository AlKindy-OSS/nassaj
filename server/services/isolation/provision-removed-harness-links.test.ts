/**
 * provision-removed-harness-links.test.ts — the security repair that outlives the
 * Kimi CLI and Qwen Code bodies (ADR-229, B-486, ADR-105).
 *
 * The bodies are gone, but a member tree provisioned before ADR-105 may still hold
 * a SYMLINK to the operator's credential: `.kimi/auth.json` (an OAuth credential) or
 * `.qwen/settings.json` (whose `env` block carries the operator's subscription key).
 * Either link would put one person's subscription in every member's hands, so every
 * provisioning pass reaps it. Proves:
 *  - the legacy link ENTRY is removed;
 *  - unlink never follows it: the operator's file behind it stays byte-identical
 *    (content and mode);
 *  - a REAL credential file in the member's own tree is theirs and is left alone.
 *
 * Recovered from the deleted provision-qwen-home.test.ts and provision-kimi-home.test.ts
 * (6f4d3a808^). HOME + DATABASE_PATH are sandboxed before importing any project module
 * so the DB singleton and userConfigDir never touch real state. Runner: node:test/tsx.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-removed-harness-links-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });

process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// The operator's leftover credentials: the files a legacy member link points at.
const OPERATOR_QWEN_SETTINGS = path.join(sandboxHome, '.qwen', 'settings.json');
const QWEN_SETTINGS_BYTES = JSON.stringify({
  $version: 4,
  env: { BAILIAN_TOKEN_PLAN_API_KEY: 'sk-sp-operator-subscription-key' },
});
const OPERATOR_KIMI_AUTH = path.join(sandboxHome, '.kimi', 'auth.json');
const KIMI_AUTH_BYTES = JSON.stringify({ access_token: 'synthetic-kimi-tok' });
const OPERATOR_FILE_MODE = 0o640;

for (const [file, bytes] of [
  [OPERATOR_QWEN_SETTINGS, QWEN_SETTINGS_BYTES],
  [OPERATOR_KIMI_AUTH, KIMI_AUTH_BYTES],
] as const) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.chmodSync(file, OPERATOR_FILE_MODE);
}

const { initializeDatabase, closeConnection, getConnection } = await import(
  '@/modules/database/index.js'
);
const { provisionUserDirs, userConfigDir, invalidateProvisioned } = await import(
  './provision-user-dirs.js'
);

await initializeDatabase();

const LINKED_ID = 8301;
const OWN_FILE_ID = 8302;
{
  const insert = getConnection().prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')",
  );
  insert.run(LINKED_ID, 'legacy-linked-member');
  insert.run(OWN_FILE_ID, 'own-file-member');
}

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const LEGACY_LINKS = [
  {
    name: 'Qwen settings.json',
    rel: path.join('.qwen', 'settings.json'),
    target: OPERATOR_QWEN_SETTINGS,
    bytes: QWEN_SETTINGS_BYTES,
  },
  {
    name: 'Kimi auth.json',
    rel: path.join('.kimi', 'auth.json'),
    target: OPERATOR_KIMI_AUTH,
    bytes: KIMI_AUTH_BYTES,
  },
];

/** Plants a pre-ADR-105 link: <member>/<rel> -> the operator's credential file. */
function plantLegacyLink(userId: number, rel: string, target: string): string {
  const link = userConfigDir(userId, rel);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.rmSync(link, { force: true });
  fs.symlinkSync(target, link);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'precondition: legacy link planted');
  return link;
}

describe('provisionUserDirs — legacy credential links of removed harnesses (ADR-229)', () => {
  // Provision once first so the user root exists, then plant the links as an older
  // pass would have left them, and force a fresh pass.
  provisionUserDirs(LINKED_ID);
  const links = LEGACY_LINKS.map((l) => ({ ...l, link: plantLegacyLink(LINKED_ID, l.rel, l.target) }));
  invalidateProvisioned(LINKED_ID);
  provisionUserDirs(LINKED_ID);

  for (const { name, link, target, bytes } of links) {
    it(`reaps a legacy ${name} link from a member home`, () => {
      assert.equal(
        fs.lstatSync(link, { throwIfNoEntry: false }),
        undefined,
        'the link entry pointing at the operator credential is gone',
      );
    });

    it(`leaves the operator ${name} behind the reaped link byte-identical`, () => {
      assert.equal(fs.lstatSync(target).isSymbolicLink(), false, 'operator file is still a real file');
      assert.equal(fs.readFileSync(target, 'utf8'), bytes, 'unlink never followed: same bytes');
      assert.equal(fs.statSync(target).mode & 0o777, OPERATOR_FILE_MODE, 'operator mode untouched');
    });
  }

  it("never removes a member's own REAL credential file at the same path", () => {
    provisionUserDirs(OWN_FILE_ID);
    const own = LEGACY_LINKS.map(({ rel }) => {
      const file = userConfigDir(OWN_FILE_ID, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `member-own:${rel}`);
      return { file, rel };
    });
    invalidateProvisioned(OWN_FILE_ID);
    provisionUserDirs(OWN_FILE_ID);

    for (const { file, rel } of own) {
      assert.equal(fs.lstatSync(file).isFile(), true, `${rel} is still the member's real file`);
      assert.equal(fs.readFileSync(file, 'utf8'), `member-own:${rel}`, `${rel} content untouched`);
    }
  });
});
