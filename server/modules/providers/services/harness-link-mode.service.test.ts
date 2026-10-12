/**
 * harness-link-mode.service.test.ts — ADR-200 S4.
 *
 * The link-mode rules, against the REAL credential inventory reader (real
 * settings.json / .credentials.json / auth.json files in a sandbox) and fake
 * store, writers and grants:
 *   - the H1 upgrade matrix (none / oauth / key / both) × (Claude, Codex);
 *   - the per-(user, harness) lock serialises a mode switch against a save;
 *   - a fresh OAuth login with a key present gives the mismatch status;
 *   - a foreign key in subscription mode gives the «billing is key» status;
 *   - switch semantics: own projection removed, foreign kept unless confirmed,
 *     the subscription never touched unless asked (C2); D6 after a delete;
 *   - flag off: pass-through, and nothing persisted.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { readHarnessCredentialInventory, type LinkHarness } from './harness-credential-inventory.js';
import type { LinkModeRecord } from './harness-link-mode.policy.js';
import {
  createHarnessLinkModeService,
  createKeyedLock,
  type LinkModeDeps,
  type LinkModeWriter,
  type ProjectionLedgerPort,
} from './harness-link-mode.service.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'link-mode-'));
const claudeDir = path.join(sandbox, 'claude');
const codexDir = path.join(sandbox, 'codex');
const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };

const KEY = 'sk' + '-ant-api03-OWN-DO-NOT-LEAK';
const FOREIGN = 'sk' + '-ant-api03-FOREIGN-DO-NOT-LEAK';
const SETUP = 'sk' + '-ant-oat01-SETUP-DO-NOT-LEAK';
const OPENAI = 'sk' + '-proj-OPENAI-DO-NOT-LEAK';
const fp = (value: string, version = 1) => `fp${version}:${value.length}:${value.slice(-6)}`;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
const settingsFile = () => path.join(claudeDir, 'settings.json');
const readSettingsEnv = () => (JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).env ?? {}) as Record<string, string>;
function claudeOauth(refreshToken = 'rt-1'): void {
  writeJson(path.join(claudeDir, '.credentials.json'), { claudeAiOauth: { accessToken: 'at', refreshToken } });
}
const claudeKey = (key = KEY, extra: Record<string, string> = {}) => writeJson(settingsFile(), { env: { ANTHROPIC_API_KEY: key, ...extra } });
const codexAuth = (auth: Record<string, unknown>) => writeJson(path.join(codexDir, 'auth.json'), auth);
const CODEX_TOKENS = { id_token: 'id', access_token: 'at', refresh_token: 'rt', account_id: 'acc' };

/** A writer over the real sandbox files, logging each call. */
function fileWriter(harness: LinkHarness, log: string[]): LinkModeWriter {
  return {
    async setApiKey(_userId, key) {
      log.push(`${harness}:set`);
      if (harness === 'claude') {
        const env = fs.existsSync(settingsFile()) ? readSettingsEnv() : {};
        writeJson(settingsFile(), { env: { ...env, ANTHROPIC_API_KEY: key } });
      } else {
        const file = path.join(codexDir, 'auth.json');
        const auth = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
        codexAuth({ ...auth, auth_mode: 'apikey', OPENAI_API_KEY: key });
      }
      return { provider: harness, configured: true };
    },
    async deleteApiKey() {
      log.push(`${harness}:delete`);
      if (harness === 'claude') {
        const env = readSettingsEnv();
        delete env.ANTHROPIC_API_KEY;
        writeJson(settingsFile(), { env });
      } else {
        const auth = JSON.parse(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8'));
        codexAuth({ ...auth, auth_mode: 'chatgpt', OPENAI_API_KEY: null });
      }
      return { provider: harness, configured: false };
    },
    async deleteSubscriptionToken() {
      log.push(`${harness}:delete-setup`);
      const env = readSettingsEnv();
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      writeJson(settingsFile(), { env });
      return { provider: harness, configured: true };
    },
  };
}

/** Operator-scope records are keyed by harness alone, member ones by `owner:harness`. */
const recordKey = (owner: string | number | null | undefined, harness: string) =>
  (owner === null || owner === undefined ? harness : `${owner}:${harness}`);

type Harness = {
  service: ReturnType<typeof createHarnessLinkModeService>;
  records: Map<string, LinkModeRecord>;
  /** B-1547: record keys whose stored record is present but unreadable. */
  unreadable: Set<string>;
  log: string[];
  audits: Array<Record<string, unknown>>;
  state: {
    enabled: boolean; shared: boolean; canonical: Record<string, string | null>; grantees: number; storeCorrupt: boolean;
    /** The store refuses the record write only (the read still sees the bad entry). */
    writeRefused: boolean;
  };
};

function build(extra: Partial<LinkModeDeps> = {}): Harness {
  const records = new Map<string, LinkModeRecord>();
  const unreadable = new Set<string>();
  const log: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const state = { enabled: true, shared: false, canonical: { claude: KEY, codex: OPENAI } as Record<string, string | null>, grantees: 2, storeCorrupt: false, writeRefused: false };
  const deps: LinkModeDeps = {
    isEnabled: () => state.enabled,
    readInventory: readHarnessCredentialInventory,
    readRecordState: (owner, h) => {
      if (state.storeCorrupt) return { state: 'unreadable', store: true };
      if (unreadable.has(recordKey(owner, h))) return { state: 'unreadable' };
      const record = records.get(recordKey(owner, h));
      return record ? { state: 'ok', record } : { state: 'absent' };
    },
    writeRecord: (owner, h, r) => {
      if (state.storeCorrupt || state.writeRefused) throw Object.assign(new Error('corrupt'), { code: 'PROVIDER_SECRETS_STORE_UNREADABLE' });
      unreadable.delete(recordKey(owner, h));
      records.set(recordKey(owner, h), r);
    },
    treeOwner: (u) => (state.shared || u === null || u === undefined ? null : u),
    fingerprint: fp,
    keyVersion: 1,
    readCanonicalKey: (_u, h) => state.canonical[h] ?? null,
    resolveWriter: (h) => fileWriter(h, log),
    countGrantees: () => state.grantees,
    audit: (_u, metadata) => { audits.push(metadata); },
    now: () => new Date('2026-10-04T00:00:00Z'),
    ...extra,
  };
  return { service: createHarnessLinkModeService(deps), records, unreadable, log, audits, state };
}

beforeEach(() => {
  fs.rmSync(claudeDir, { recursive: true, force: true });
  fs.rmSync(codexDir, { recursive: true, force: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = codexDir;
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete process.env[name];
});

afterEach(() => {
  if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.claude;
  if (saved.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved.codex;
});

process.on('exit', () => fs.rmSync(sandbox, { recursive: true, force: true }));

async function enabledStatus(h: Harness, harness: LinkHarness) {
  const status = await h.service.getStatus(null, harness);
  assert.equal(status.enabled, true);
  return status as Exclude<typeof status, { enabled: false }>;
}

// ---------------------------------------------------------------- H1 matrix
const MATRIX: Array<{ name: string; harness: LinkHarness; setup: () => void; mode: string | null; warning?: string }> = [
  { name: 'claude none', harness: 'claude', setup: () => {}, mode: null, warning: 'mode_unset' },
  { name: 'claude oauth only', harness: 'claude', setup: () => claudeOauth(), mode: 'subscription' },
  { name: 'claude key only', harness: 'claude', setup: () => claudeKey(), mode: 'api_key' },
  {
    name: 'claude both', harness: 'claude', setup: () => { claudeKey(); claudeOauth(); },
    mode: 'api_key', warning: 'subscription_also_present',
  },
  { name: 'codex none', harness: 'codex', setup: () => {}, mode: null, warning: 'mode_unset' },
  { name: 'codex oauth only', harness: 'codex', setup: () => codexAuth({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: CODEX_TOKENS }), mode: 'subscription' },
  { name: 'codex key only', harness: 'codex', setup: () => codexAuth({ auth_mode: 'apikey', OPENAI_API_KEY: OPENAI }), mode: 'api_key' },
  {
    name: 'codex both, chatgpt effective', harness: 'codex',
    setup: () => codexAuth({ auth_mode: 'chatgpt', OPENAI_API_KEY: OPENAI, tokens: CODEX_TOKENS }), mode: 'subscription',
  },
  {
    name: 'codex both, apikey effective', harness: 'codex',
    setup: () => codexAuth({ auth_mode: 'apikey', OPENAI_API_KEY: OPENAI, tokens: CODEX_TOKENS }),
    mode: 'api_key', warning: 'subscription_also_present',
  },
];

for (const row of MATRIX) {
  test(`H1 upgrade default: ${row.name} → ${row.mode ?? 'unset'}, and no file changes`, async () => {
    row.setup();
    const before = snapshot();
    const h = build();
    const status = await enabledStatus(h, row.harness);
    assert.equal(status.chosenMode, row.mode);
    assert.equal(status.effectiveMode === 'none' ? null : status.effectiveMode, row.mode, 'default = effective mode');
    if (row.mode) assert.equal(h.records.get(row.harness)?.source, 'derived', 'default persisted as derived');
    else assert.equal(h.records.size, 0, 'nothing persisted when there is nothing to derive');
    if (row.warning) assert.ok(status.warnings.includes(row.warning as never), `${row.warning} expected`);
    assert.deepEqual(snapshot(), before, 'no billing change on upgrade: harness files untouched');
  });
}

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of [claudeDir, codexDir]) {
    for (const name of fs.readdirSync(dir)) out[path.join(dir, name)] = fs.readFileSync(path.join(dir, name), 'utf8');
  }
  return out;
}

// ---------------------------------------------------------------- choke point
test('guardKeyWrite refuses a key in subscription mode with 409 LINK_MODE_SUBSCRIPTION', async () => {
  claudeOauth();
  const h = build();
  let wrote = false;
  await assert.rejects(
    h.service.guardKeyWrite(null, 'claude', KEY, { origin: 'fanout' }, async () => { wrote = true; }),
    (err: { code?: string; statusCode?: number }) => err.code === 'LINK_MODE_SUBSCRIPTION' && err.statusCode === 409,
  );
  assert.equal(wrote, false);
});

test('guardKeyWrite: unset → LINK_MODE_UNSET; legacy route in api_key mode → read-only', async () => {
  const h = build();
  await assert.rejects(h.service.guardKeyWrite(null, 'codex', OPENAI, { origin: 'company_route' }, async () => 1), { code: 'LINK_MODE_UNSET' });
  claudeKey();
  await assert.rejects(h.service.guardKeyWrite(null, 'claude', KEY, { origin: 'legacy_route' }, async () => 1), { code: 'LEGACY_KEY_ROUTE_READ_ONLY' });
  await assert.rejects(
    h.service.guardKeyWrite(null, 'claude', KEY, { origin: 'company_route' }, async () => 'ok'),
    { code: 'FOREIGN_CREDENTIAL_PRESENT' },
    'G1 M-5: a key nassaj did not write is not replaced silently',
  );
  const confirmed = { origin: 'company_route' as const, replaceForeignKey: true };
  assert.equal(await h.service.guardKeyWrite(null, 'claude', KEY, confirmed, async () => 'ok'), 'ok');
  assert.equal(h.records.get('claude')?.projection?.fp, fp(KEY), 'projection fingerprint recorded');
});

test('a setup token saves in subscription mode and is refused in api_key mode', async () => {
  claudeOauth();
  const h = build();
  assert.equal(await h.service.guardKeyWrite(null, 'claude', SETUP, { origin: 'legacy_route' }, async () => 'saved'), 'saved');
  assert.equal(h.records.get('claude')?.mode, 'subscription');
  h.records.set('claude', { ...h.records.get('claude')!, mode: 'api_key' });
  await assert.rejects(h.service.guardKeyWrite(null, 'claude', SETUP, { origin: 'legacy_route' }, async () => 1), { code: 'LINK_MODE_API_KEY' });
});

test('a setup token never silently drops a foreign key', async () => {
  claudeKey(FOREIGN);
  claudeOauth();
  const h = build();
  h.records.set('claude', { v: 1, mode: 'subscription', source: 'user', updatedAt: '', projection: null, subscriptionFp: null });
  await assert.rejects(h.service.guardKeyWrite(null, 'claude', SETUP, { origin: 'legacy_route' }, async () => 1), { code: 'FOREIGN_CREDENTIAL_PRESENT' });
});

// ---------------------------------------------------------------- lock
test('the (user, harness) lock serialises a mode switch against a save', async () => {
  claudeKey();
  const h = build();
  const events: string[] = [];
  let releaseSave!: () => void;
  const save = h.service.guardKeyWrite(null, 'claude', KEY, { origin: 'company_route', replaceForeignKey: true }, async () => {
    events.push('save:start');
    await new Promise<void>((resolve) => { releaseSave = resolve; });
    events.push('save:end');
  });
  await new Promise((resolve) => setImmediate(resolve));
  const switching = h.service.switchMode(null, 'claude', { mode: 'subscription', confirm: true }).then((r) => {
    events.push('switch:done');
    return r;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['save:start'], 'the switch waits for the save');
  releaseSave();
  const result = await switching;
  await save;
  assert.deepEqual(events, ['save:start', 'save:end', 'switch:done']);
  assert.equal(result.outcome, 'key_removed', 'the switch saw the save’s projection and removed it');
  assert.equal(readSettingsEnv().ANTHROPIC_API_KEY, undefined);
});

test('createKeyedLock releases after a failure and keeps keys independent', async () => {
  const lock = createKeyedLock();
  await assert.rejects(lock('a', async () => { throw new Error('boom'); }));
  assert.equal(await lock('a', async () => 'next'), 'next');
  const order: string[] = [];
  let release!: () => void;
  const held = lock('a', () => new Promise<void>((resolve) => { release = resolve; }));
  await lock('b', async () => { order.push('b'); });
  order.push('after-b');
  release();
  await held;
  assert.deepEqual(order, ['b', 'after-b'], 'another key is not blocked');
});

// ---------------------------------------------------------------- drift (M4, M-3)
test('a fresh OAuth login with a key present gives the mismatch status', async () => {
  claudeKey();
  const h = build();
  await h.service.guardKeyWrite(null, 'claude', KEY, { origin: 'company_route', replaceForeignKey: true }, async () => undefined);
  let status = await enabledStatus(h, 'claude');
  assert.equal(status.warnings.includes('fresh_subscription_login'), false);
  claudeOauth('rt-new-login');
  status = await enabledStatus(h, 'claude');
  assert.equal(status.chosenMode, 'api_key');
  assert.equal(status.effectiveMode, 'api_key');
  assert.ok(status.warnings.includes('fresh_subscription_login'));
  assert.equal(status.credentials.key, 'managed');
});

test('codex: a fresh ChatGPT login that takes over gives fresh-login and effective mismatch', async () => {
  codexAuth({ auth_mode: 'apikey', OPENAI_API_KEY: OPENAI });
  const h = build();
  await h.service.guardKeyWrite(null, 'codex', OPENAI, { origin: 'company_route', replaceForeignKey: true }, async () => undefined);
  codexAuth({ auth_mode: 'chatgpt', OPENAI_API_KEY: OPENAI, tokens: CODEX_TOKENS });
  const status = await enabledStatus(h, 'codex');
  assert.ok(status.warnings.includes('fresh_subscription_login'));
  assert.ok(status.warnings.includes('effective_mode_mismatch'));
});

test('a foreign key in subscription mode gives the «billing is key» status', async () => {
  claudeOauth();
  const h = build();
  await enabledStatus(h, 'claude');
  claudeKey(FOREIGN);
  const status = await enabledStatus(h, 'claude');
  assert.equal(status.chosenMode, 'subscription');
  assert.equal(status.effectiveMode, 'api_key');
  assert.equal(status.credentials.key, 'foreign');
  assert.ok(status.warnings.includes('foreign_key_billing'));
  assert.ok(status.warnings.includes('effective_mode_mismatch'));
});

test('a settings ANTHROPIC_AUTH_TOKEN is foreign and is never removed', async () => {
  claudeOauth();
  writeJson(settingsFile(), { env: { ANTHROPIC_AUTH_TOKEN: FOREIGN } });
  const h = build();
  const status = await enabledStatus(h, 'claude');
  assert.equal(status.credentials.key, 'foreign');
  assert.equal(status.chosenMode, 'api_key', 'H1: the token is what runs today');
  await h.service.switchMode(null, 'claude', { mode: 'subscription', confirm: true, removeForeignKey: true });
  assert.equal(readSettingsEnv().ANTHROPIC_AUTH_TOKEN, FOREIGN, 'the writer manages ANTHROPIC_API_KEY only');
});

// ---------------------------------------------------------------- switching
test('switch needs confirm, and the refusal carries the grantee count (H6)', async () => {
  claudeOauth();
  const h = build();
  await assert.rejects(
    h.service.switchMode(null, 'claude', { mode: 'api_key' }),
    (err: { code?: string; details?: Record<string, unknown> }) => err.code === 'LINK_MODE_CONFIRM_REQUIRED'
      && err.details?.granteeCount === 2 && err.details?.to === 'api_key' && err.details?.from === 'subscription',
  );
  assert.deepEqual(h.log, []);
});

test('switch to api_key projects the canonical key and keeps the setup token (C2)', async () => {
  claudeOauth();
  writeJson(settingsFile(), { env: { CLAUDE_CODE_OAUTH_TOKEN: SETUP } });
  const h = build();
  const result = await h.service.switchMode(null, 'claude', { mode: 'api_key', confirm: true });
  assert.equal(result.outcome, 'linked');
  assert.equal(result.granteeCount, 2);
  assert.equal(readSettingsEnv().ANTHROPIC_API_KEY, KEY);
  assert.equal(readSettingsEnv().CLAUDE_CODE_OAUTH_TOKEN, SETUP, 'subscription token untouched');
  assert.ok(fs.existsSync(path.join(claudeDir, '.credentials.json')));
  assert.equal(result.status.linkState, 'linked');
  assert.deepEqual(h.audits[0], {
    provider: 'claude', from: 'subscription', to: 'api_key', outcome: 'linked', granteeCount: 2, setupTokenRemoved: false,
  });
});

test('removeSetupToken removes only the settings setup token, on request', async () => {
  writeJson(settingsFile(), { env: { CLAUDE_CODE_OAUTH_TOKEN: SETUP } });
  claudeOauth();
  const h = build();
  const result = await h.service.switchMode(null, 'claude', { mode: 'api_key', confirm: true, removeSetupToken: true });
  assert.equal(result.setupTokenRemoved, true);
  assert.equal(readSettingsEnv().CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.ok(fs.existsSync(path.join(claudeDir, '.credentials.json')), '.credentials.json is never touched');
  await assert.rejects(
    h.service.switchMode(null, 'codex', { mode: 'api_key', confirm: true, removeSetupToken: true }),
    { code: 'INVALID_LINK_MODE_OPTION' },
  );
});

test('switch to api_key with no canonical key leaves the harness awaiting a key', async () => {
  codexAuth({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: CODEX_TOKENS });
  const h = build();
  h.state.canonical.codex = null;
  const result = await h.service.switchMode(null, 'codex', { mode: 'api_key', confirm: true });
  assert.equal(result.outcome, 'awaiting_key');
  assert.equal(result.status.linkState, 'unlinked');
  assert.deepEqual(h.log, [], 'nothing written');
});

test('switch to subscription removes nassaj’s projection but keeps tokens', async () => {
  codexAuth({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: CODEX_TOKENS });
  const h = build();
  await h.service.switchMode(null, 'codex', { mode: 'api_key', confirm: true });
  const result = await h.service.switchMode(null, 'codex', { mode: 'subscription', confirm: true });
  assert.equal(result.outcome, 'key_removed');
  const auth = JSON.parse(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8'));
  assert.deepEqual(auth.tokens, CODEX_TOKENS);
  assert.equal(result.status.effectiveMode, 'subscription');
  assert.deepEqual(result.status.warnings, []);
});

test('switch to subscription keeps a foreign key unless removeForeignKey is confirmed', async () => {
  claudeKey(FOREIGN);
  claudeOauth();
  const h = build();
  const kept = await h.service.switchMode(null, 'claude', { mode: 'subscription', confirm: true });
  assert.equal(kept.outcome, 'foreign_credential');
  assert.equal(readSettingsEnv().ANTHROPIC_API_KEY, FOREIGN);
  assert.ok(kept.status.warnings.includes('foreign_key_billing'));
  const removed = await h.service.switchMode(null, 'claude', { mode: 'subscription', confirm: true, removeForeignKey: true });
  assert.equal(removed.outcome, 'foreign_key_removed');
  assert.equal(readSettingsEnv().ANTHROPIC_API_KEY, undefined);
  assert.equal(removed.status.effectiveMode, 'subscription');
});

test('a repeated switch to the same user-chosen mode is a no-op', async () => {
  claudeOauth();
  const h = build();
  await h.service.switchMode(null, 'claude', { mode: 'subscription', confirm: true });
  const again = await h.service.switchMode(null, 'claude', { mode: 'subscription' });
  assert.equal(again.outcome, 'unchanged');
  assert.equal(h.audits.length, 1);
});

test('D6: deleting the key keeps api_key mode and the harness becomes unlinked', async () => {
  claudeOauth();
  const h = build();
  await h.service.switchMode(null, 'claude', { mode: 'api_key', confirm: true });
  await h.service.guardKeyDelete(null, 'claude', async () => fileWriter('claude', h.log).deleteApiKey(null));
  const status = await enabledStatus(h, 'claude');
  assert.equal(status.chosenMode, 'api_key');
  assert.equal(status.linkState, 'unlinked');
  assert.equal(h.records.get('claude')?.projection, null);
  assert.ok(status.warnings.includes('effective_mode_mismatch'));
});

test('invalid mode is a 400', async () => {
  const h = build();
  await assert.rejects(h.service.switchMode(null, 'claude', { mode: 'both', confirm: true }), { code: 'INVALID_LINK_MODE' });
});

// ---------------------------------------------------------------- flag off
test('flag off: writes pass through, nothing persisted, switch refused, status disabled', async () => {
  claudeOauth();
  const h = build();
  h.state.enabled = false;
  assert.equal(await h.service.guardKeyWrite(null, 'claude', KEY, { origin: 'legacy_route' }, async () => 'written'), 'written');
  assert.equal(await h.service.guardKeyDelete(null, 'claude', async () => 'deleted'), 'deleted');
  assert.equal(h.records.size, 0);
  await assert.rejects(h.service.switchMode(null, 'claude', { mode: 'api_key', confirm: true }), { code: 'LINK_MODE_DISABLED' });
  assert.deepEqual(await h.service.getStatus(null, 'claude'), { provider: 'claude', enabled: false });
  assert.equal(h.service.peekMode(null, 'claude'), null);
});

// ---------------------------------------------------------------- G1 fixes
test('G1 H-1: on a shared tree two members share one record and one lock', async () => {
  claudeOauth();
  const h = build();
  h.state.shared = true;
  await h.service.switchMode('7', 'claude', { mode: 'subscription', confirm: true });
  assert.equal(h.records.get('claude')?.mode, 'subscription', 'stored in operator scope');
  assert.equal(h.records.has('7:claude'), false);
  await assert.rejects(
    h.service.guardKeyWrite('8', 'claude', KEY, { origin: 'company_route' }, async () => 'written'),
    { code: 'LINK_MODE_SUBSCRIPTION' },
  );
});

test('G1 M-5: a foreign key in api_key mode is not replaced by a save without confirmation', async () => {
  codexAuth({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk' + '-proj-FOREIGN' });
  const h = build();
  let wrote = false;
  await assert.rejects(
    h.service.guardKeyWrite(null, 'codex', OPENAI, { origin: 'fanout' }, async () => { wrote = true; }),
    { code: 'FOREIGN_CREDENTIAL_PRESENT' },
  );
  assert.equal(wrote, false);
});

test('G1: foreign_key_billing only when the key actually runs', async () => {
  codexAuth({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk' + '-proj-FOREIGN', tokens: CODEX_TOKENS });
  const h = build();
  const status = await enabledStatus(h, 'codex');
  assert.equal(status.chosenMode, 'subscription');
  assert.equal(status.credentials.key, 'foreign');
  assert.equal(status.warnings.includes('foreign_key_billing'), false, 'ChatGPT is what runs');
});


// ---------------------------------------------------------------- B-1547
test('B-1547: an unreadable record refuses key and setup-token saves, never overwriting it', async () => {
  claudeOauth();
  const h = build();
  h.unreadable.add('claude');
  let wrote = false;
  for (const value of [KEY, SETUP]) {
    await assert.rejects(
      h.service.guardKeyWrite(null, 'claude', value, { origin: 'company_route' }, async () => { wrote = true; }),
      (error: { code?: string; details?: unknown; message?: string }) => {
        assert.equal(error.code, 'LINK_MODE_RECORD_UNREADABLE');
        assert.deepEqual(error.details, { provider: 'claude' });
        assert.equal(String(error.message).includes(value), false);
        return true;
      },
    );
  }
  assert.equal(wrote, false);
  assert.equal(h.records.size, 0, 'no derived record written over it');
  assert.equal(h.unreadable.has('claude'), true);
});

test('B-1547: status reports an unreadable record and does not persist a derived one', async () => {
  claudeOauth();
  const h = build();
  h.unreadable.add('claude');
  const status = await enabledStatus(h, 'claude');
  assert.equal(status.chosenMode, null);
  assert.equal(status.linkState, 'unlinked');
  assert.equal(status.warnings.includes('record_unreadable'), true);
  assert.equal(h.records.size, 0);
});

test('ADR-200 S9: peekMode reads the record, derives only when absent, and is null when unreadable', () => {
  claudeOauth();
  const h = build();
  assert.equal(h.service.peekMode(null, 'claude'), 'subscription', 'absent record → H1 derivation');
  h.unreadable.add('claude');
  assert.equal(h.service.peekMode(null, 'claude'), null, 'never derived over an unreadable record');
  assert.equal(h.records.size, 0, 'a peek never writes');
});

test('B-1547: a switch replaces an unreadable record only on confirm, and audits it', async () => {
  claudeOauth();
  const h = build();
  h.unreadable.add('claude');
  await assert.rejects(h.service.switchMode(null, 'claude', { mode: 'subscription' }), (error: { code?: string; details?: Record<string, unknown> }) => {
    assert.equal(error.code, 'LINK_MODE_CONFIRM_REQUIRED');
    assert.equal(error.details?.recordUnreadable, true);
    return true;
  });
  assert.equal(h.unreadable.has('claude'), true);
  const result = await h.service.switchMode(null, 'claude', { mode: 'subscription', confirm: true });
  assert.equal(result.mode, 'subscription');
  assert.equal(h.records.get('claude')?.mode, 'subscription');
  assert.equal(h.unreadable.has('claude'), false);
  assert.equal(h.audits.at(-1)?.replacedUnreadableRecord, true);
});

test('B-1547: a corrupt keys file refuses switch and key save up front, asking for operator repair', async () => {
  claudeOauth();
  const h = build();
  h.state.storeCorrupt = true;
  const isRepair = (error: { code?: string; details?: unknown; message?: string }) => {
    assert.equal(error.code, 'LINK_MODE_RECORD_UNREADABLE');
    assert.deepEqual(error.details, { provider: 'claude', operatorRepair: true });
    assert.equal(error.message, 'The credential store needs operator repair.');
    return true;
  };
  await assert.rejects(h.service.switchMode(null, 'claude', { mode: 'api_key', confirm: true }), isRepair);
  assert.deepEqual(h.log, [], 'no projection side effect before the refusal');
  let wrote = false;
  await assert.rejects(
    h.service.guardKeyWrite(null, 'claude', KEY, { origin: 'company_route' }, async () => { wrote = true; }), isRepair);
  assert.equal(wrote, false);
  assert.equal(h.audits.length, 0);
});

test('B-1547: a store refusal at record-write time still maps to the repair 409', async () => {
  claudeOauth();
  const h = build();
  h.unreadable.add('claude');
  h.state.writeRefused = true;
  await assert.rejects(
    h.service.switchMode(null, 'claude', { mode: 'subscription', confirm: true }),
    (error: { code?: string; details?: unknown }) => {
      assert.equal(error.code, 'LINK_MODE_RECORD_UNREADABLE');
      assert.deepEqual(error.details, { provider: 'claude', operatorRepair: true });
      return true;
    },
  );
});

// ---------------------------------------------------------------- B-1574 ledger
// The operator tree (null) keeps the sandbox files readable; the port gets the tree owner as is.
/** A ledger fake over the call log; `unreadable` refuses like the store's typed 409. */
type LedgerFlags = { unreadable: boolean; removeFails: boolean; writeFailures?: number; failedFails?: boolean };

function fakeLedger(log: string[], flags: LedgerFlags = { unreadable: false, removeFails: false }): ProjectionLedgerPort {
  return {
    assertWritable: (owner, harness) => {
      log.push(`ledger:check:${owner}:${harness}`);
      if (flags.unreadable) throw Object.assign(new Error('unreadable'), { code: 'PROVIDER_SECRETS_STORE_UNREADABLE' });
    },
    recordWritten: (owner, harness, projection) => {
      log.push(`ledger:written:${owner}:${harness}:${projection.fp}:${projection.keyVersion}`);
      if ((flags.writeFailures ?? 0) > 0) {
        flags.writeFailures = (flags.writeFailures ?? 0) - 1;
        throw new Error('ledger write failed');
      }
    },
    recordFailed: (owner, harness, projection) => {
      log.push(`ledger:failed:${owner}:${harness}:${projection.fp}:${projection.keyVersion}`);
      if (flags.failedFails) throw new Error('ledger mark failed');
    },
    recordRemoved: (owner, harness) => {
      log.push(`ledger:removed:${owner}:${harness}`);
      if (flags.removeFails) throw new Error('unreadable');
    },
  };
}

test('B-1574: a switch ledgers the key it writes and drops the entry when it removes it', async () => {
  codexAuth({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: CODEX_TOKENS });
  const log: string[] = [];
  const h = build({ projectionLedger: fakeLedger(log), resolveWriter: (harness) => fileWriter(harness, log) });
  await h.service.switchMode(null, 'codex', { mode: 'api_key', confirm: true });
  await h.service.switchMode(null, 'codex', { mode: 'subscription', confirm: true });
  assert.deepEqual(log, [
    'ledger:check:null:codex', 'codex:set', `ledger:written:null:codex:${fp(OPENAI, 1)}:1`,
    'codex:delete', 'ledger:removed:null:codex',
  ], 'checked before the write, recorded after it, dropped with the key');
});

test('B-1574: an unreadable ledger refuses the api_key switch before any file write', async () => {
  codexAuth({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: CODEX_TOKENS });
  const log: string[] = [];
  const h = build({ projectionLedger: fakeLedger(log, { unreadable: true, removeFails: false }), resolveWriter: (harness) => fileWriter(harness, log) });
  await assert.rejects(h.service.switchMode(null, 'codex', { mode: 'api_key', confirm: true }), { code: 'PROVIDER_SECRETS_STORE_UNREADABLE' });
  assert.deepEqual(log, ['ledger:check:null:codex'], 'no projection left unledgered');
  assert.equal(JSON.parse(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8')).OPENAI_API_KEY, null);
});

test('B-1574: a failed ledger drop does not undo a completed switch to subscription', async () => {
  codexAuth({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: CODEX_TOKENS });
  const log: string[] = [];
  const flags = { unreadable: false, removeFails: false };
  const h = build({ projectionLedger: fakeLedger(log, flags), resolveWriter: (harness) => fileWriter(harness, log) });
  await h.service.switchMode(null, 'codex', { mode: 'api_key', confirm: true });
  flags.removeFails = true;
  const result = await h.service.switchMode(null, 'codex', { mode: 'subscription', confirm: true });
  assert.equal(result.outcome, 'key_removed');
  assert.equal(h.records.get('codex')?.mode, 'subscription');
});

test('B-1575: a ledger write that fails once is retried and the switch completes', async () => {
  codexAuth({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: CODEX_TOKENS });
  const log: string[] = [];
  const flags: LedgerFlags = { unreadable: false, removeFails: false, writeFailures: 1 };
  const h = build({ projectionLedger: fakeLedger(log, flags), resolveWriter: (harness) => fileWriter(harness, log) });
  const result = await h.service.switchMode(null, 'codex', { mode: 'api_key', confirm: true });
  assert.equal(result.outcome, 'linked');
  const written = `ledger:written:null:codex:${fp(OPENAI, 1)}:1`;
  assert.deepEqual(log, ['ledger:check:null:codex', 'codex:set', written, written]);
  assert.deepEqual(h.records.get('codex')?.projection, { fp: fp(OPENAI, 1), keyVersion: 1 });
});

test('B-1575: a ledger write that fails twice leaves a failed entry for the sweep', async () => {
  codexAuth({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: CODEX_TOKENS });
  const log: string[] = [];
  const flags: LedgerFlags = { unreadable: false, removeFails: false, writeFailures: 2 };
  const h = build({ projectionLedger: fakeLedger(log, flags), resolveWriter: (harness) => fileWriter(harness, log) });
  const result = await h.service.switchMode(null, 'codex', { mode: 'api_key', confirm: true });
  assert.equal(result.outcome, 'linked');
  assert.equal(log.at(-1), `ledger:failed:null:codex:${fp(OPENAI, 1)}:1`);
});

test('B-1575: when even the failed mark cannot be written the switch reports the ledger error', async () => {
  codexAuth({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: CODEX_TOKENS });
  const log: string[] = [];
  const flags: LedgerFlags = { unreadable: false, removeFails: false, writeFailures: 2, failedFails: true };
  const h = build({ projectionLedger: fakeLedger(log, flags), resolveWriter: (harness) => fileWriter(harness, log) });
  await assert.rejects(h.service.switchMode(null, 'codex', { mode: 'api_key', confirm: true }), /ledger write failed/);
});
