/**
 * credential-file-watcher.service.test — B-1771 acceptance. On 2026-11-09 a
 * member's Claude `.credentials.json` was rewritten without a refresh token and
 * nothing recorded when or how. The watcher logs one value-free line per change
 * of any provider credential file and WARNs when a link degrades.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  PROVIDER_CREDENTIAL_FILES,
  isCredentialDegrade,
  lostFields,
  readCredentialFileSnapshot,
} from '@/modules/providers/services/provider-credential-files.js';

import { createCredentialFileWatcher } from './credential-file-watcher.service.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-watch-test-'));
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

// Built at runtime so the source carries no token-shaped literal for the export leak scan.
const SECRET = ['sk', 'ant', 'oat01', 'SUPERSECRETVALUE'].join('-');
const REFRESH = ['sk', 'ant', 'ort01', 'REFRESHSECRET'].join('-');
const FULL = { claudeAiOauth: { accessToken: SECRET, refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000, scopes: ['user:inference', 'profile'] } };
const BROKEN = { claudeAiOauth: { accessToken: SECRET } };
const spec = (provider: string) => PROVIDER_CREDENTIAL_FILES.find((row) => row.provider === provider)!;

type Line = { level: 'info' | 'warn'; record: Record<string, unknown>; raw: string };

function harness(usersRoot: string, extra: Partial<Parameters<typeof createCredentialFileWatcher>[0]> = {}) {
  const lines: Line[] = [];
  const logger = {
    info: (raw: string) => lines.push({ level: 'info', raw, record: JSON.parse(raw.slice(raw.indexOf('{'))) }),
    warn: (raw: string) => lines.push({ level: 'warn', raw, record: JSON.parse(raw.slice(raw.indexOf('{'))) }),
  };
  const watcher = createCredentialFileWatcher({ usersRoot, logger, debounceMs: 20, rescanMs: 0, ...extra });
  return { watcher, lines };
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await settle(25);
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** Atomic replace as the CLI does it: temp file + rename (a new inode). */
function replaceJson(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

describe('provider credential snapshot (pure)', () => {
  const file = path.join(sandbox, 'pure', '.credentials.json');

  it('reports presence booleans and reuses the Claude classifier', () => {
    writeJson(file, FULL);
    const snap = readCredentialFileSnapshot(spec('claude'), file);
    assert.equal(snap.state, 'linked');
    assert.deepEqual(snap.fields, { accessToken: true, refreshToken: true, profileScope: true, expiresAt: true });
    writeJson(file, BROKEN);
    assert.equal(readCredentialFileSnapshot(spec('claude'), file).state, 'incomplete');
  });

  it('marks missing and malformed files without throwing', () => {
    assert.equal(readCredentialFileSnapshot(spec('claude'), path.join(sandbox, 'nope.json')).state, 'missing');
    fs.writeFileSync(file, '{not json');
    assert.equal(readCredentialFileSnapshot(spec('claude'), file).state, 'malformed');
    fs.writeFileSync(file, '[1,2]');
    assert.equal(readCredentialFileSnapshot(spec('claude'), file).state, 'malformed');
  });

  it('classifies codex with its own precedence and others by shape', () => {
    const codex = path.join(sandbox, 'pure', 'auth.json');
    writeJson(codex, { tokens: { access_token: 'a', refresh_token: 'r', id_token: 'i' } });
    assert.equal(readCredentialFileSnapshot(spec('codex'), codex).state, 'subscription');
    writeJson(codex, { auth_mode: 'apikey', OPENAI_API_KEY: null });
    assert.equal(readCredentialFileSnapshot(spec('codex'), codex).state, 'none');
    const oc = path.join(sandbox, 'pure', 'oc.json');
    writeJson(oc, { zai: { type: 'api', key: 'k' } });
    assert.equal(readCredentialFileSnapshot(spec('opencode'), oc).state, 'complete');
    writeJson(oc, { anthropic: { type: 'oauth', access: 'a' } });
    assert.equal(readCredentialFileSnapshot(spec('opencode'), oc).state, 'incomplete');
    writeJson(oc, {});
    assert.equal(readCredentialFileSnapshot(spec('opencode'), oc).state, 'empty');
    const kimi = path.join(sandbox, 'pure', 'kimi.json');
    writeJson(kimi, { access_token: 'a', expires_at: 1 });
    assert.equal(readCredentialFileSnapshot(spec('kimi'), kimi).state, 'complete');
  });

  it('reads agy, cursor, hermes and the provider-secrets store by shape', () => {
    const agy = path.join(sandbox, 'pure', 'agy-token');
    writeJson(agy, { token: { access_token: 'a', refresh_token: 'r', expiry: 'x' }, auth_method: 'oauth' });
    assert.equal(readCredentialFileSnapshot(spec('agy'), agy).state, 'complete');
    const cursor = path.join(sandbox, 'pure', 'cursor.json');
    writeJson(cursor, { accessToken: 'a' });
    assert.equal(readCredentialFileSnapshot(spec('cursor'), cursor).state, 'incomplete');
    const hermes = path.join(sandbox, 'pure', 'hermes.json');
    writeJson(hermes, { providers: { nous: { access_token: 'a', refresh_token: 'r' } } });
    assert.equal(readCredentialFileSnapshot(spec('hermes'), hermes).state, 'complete');
    const secrets = path.join(sandbox, 'pure', 'keys.json');
    writeJson(secrets, { glm: 'v1:cipher', 'backup:claude': 'v1:cipher' });
    const snap = readCredentialFileSnapshot(spec('provider-secrets'), secrets);
    assert.equal(snap.state, 'complete');
    assert.deepEqual(snap.fields, { glm: true, kimi: false, deepseek: false, qwen: false });
  });

  it('names the fields a change lost', () => {
    const was = { exists: true, mtimeMs: 1, size: 1, state: 'complete', fields: { glm: true, kimi: true } };
    const now = { exists: true, mtimeMs: 2, size: 1, state: 'complete', fields: { glm: false, kimi: true } };
    assert.deepEqual(lostFields(was, now), ['glm']);
    assert.deepEqual(lostFields(now, was), []);
  });

  it('degrade means leaving a healthy state', () => {
    assert.equal(isCredentialDegrade(spec('claude'), 'linked', 'incomplete'), true);
    assert.equal(isCredentialDegrade(spec('claude'), 'linked', 'missing'), true);
    assert.equal(isCredentialDegrade(spec('claude'), 'incomplete', 'linked'), false);
    assert.equal(isCredentialDegrade(spec('claude'), null, 'none'), false);
    assert.equal(isCredentialDegrade(spec('codex'), 'subscription', 'none'), true);
    assert.equal(isCredentialDegrade(spec('opencode'), 'complete', 'incomplete'), true);
  });
});

describe('credential file watcher', () => {
  it('logs one WARN line, without any secret, when a linked Claude file is replaced incomplete', async () => {
    const root = path.join(sandbox, 'users-degrade');
    const file = path.join(root, '1', '.claude', '.credentials.json');
    writeJson(file, FULL);
    const before = fs.readFileSync(file, 'utf8');
    const { watcher, lines } = harness(root);
    await watcher.start();
    assert.equal(lines.length, 0, 'the baseline is silent');
    replaceJson(file, BROKEN);
    await until(() => lines.length > 0);
    await settle();
    await watcher.stop();
    assert.equal(lines.length, 1, JSON.stringify(lines));
    const [line] = lines;
    assert.equal(line.level, 'warn');
    assert.equal(line.record.provider, 'claude');
    assert.equal(line.record.userId, '1');
    assert.equal(line.record.path, file);
    assert.equal(line.record.state, 'incomplete');
    assert.equal(line.record.previousState, 'linked');
    assert.equal(line.record.degraded, true);
    assert.deepEqual(line.record.fields, { accessToken: true, refreshToken: false, profileScope: false, expiresAt: false });
    assert.equal(typeof line.record.size, 'number');
    assert.match(String(line.record.mtime), /^\d{4}-\d{2}-\d{2}T/);
    for (const fragment of [SECRET, REFRESH, 'sk-ant', 'SUPERSECRET', SECRET.slice(-8)]) {
      assert.ok(!line.raw.includes(fragment), `log line leaked ${fragment}`);
    }
    assert.notEqual(fs.readFileSync(file, 'utf8'), before, 'test wrote the change');
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(BROKEN), 'watcher never writes');
  });

  it('keeps watching after successive renames and debounces a burst into one line', async () => {
    const root = path.join(sandbox, 'users-rename');
    const file = path.join(root, '7', '.claude', '.credentials.json');
    writeJson(file, BROKEN);
    const { watcher, lines } = harness(root, { debounceMs: 120 });
    await watcher.start();
    for (let i = 0; i < 5; i += 1) replaceJson(file, { claudeAiOauth: { ...FULL.claudeAiOauth, expiresAt: Date.now() + 1000 + i } });
    await until(() => lines.length > 0);
    await settle(300);
    assert.equal(lines.length, 1, 'a burst is one line');
    assert.equal(lines[0].level, 'info');
    assert.equal(lines[0].record.state, 'linked');
    replaceJson(file, BROKEN);
    await until(() => lines.length > 1);
    await watcher.stop();
    assert.equal(lines.length, 2, 'the watch survived the rename');
    assert.equal(lines[1].level, 'warn');
  });

  it('logs a deleted file as missing and tolerates users without provider dirs', async () => {
    const root = path.join(sandbox, 'users-missing');
    const file = path.join(root, '3', '.codex', 'auth.json');
    writeJson(file, { OPENAI_API_KEY: 'sk-proj-xyz' });
    fs.mkdirSync(path.join(root, '4'), { recursive: true });
    fs.mkdirSync(path.join(root, '.system'), { recursive: true });
    const { watcher, lines } = harness(root);
    await watcher.start();
    fs.rmSync(file);
    await until(() => lines.length > 0);
    await watcher.stop();
    assert.equal(lines[0].record.provider, 'codex');
    assert.equal(lines[0].record.state, 'missing');
    assert.equal(lines[0].record.previousState, 'api_key');
    assert.equal(lines[0].level, 'warn');
    assert.ok(!lines[0].raw.includes('sk-proj'));
  });

  it('logs malformed JSON once and recovers', async () => {
    const root = path.join(sandbox, 'users-malformed');
    const file = path.join(root, '5', '.claude', '.credentials.json');
    writeJson(file, FULL);
    const { watcher, lines } = harness(root);
    await watcher.start();
    replaceJson(file, 'x');
    fs.writeFileSync(file, '{"claudeAiOauth": {');
    await until(() => lines.length > 0);
    await settle();
    await watcher.stop();
    assert.equal(lines.at(-1)!.record.state, 'malformed');
    assert.equal(lines.at(-1)!.level, 'warn');
  });

  it('picks up a provider dir created later on rescan and caps watchers', async () => {
    const root = path.join(sandbox, 'users-rescan');
    fs.mkdirSync(path.join(root, '1'), { recursive: true });
    fs.mkdirSync(path.join(root, '2', '.claude'), { recursive: true });
    fs.mkdirSync(path.join(root, '2', '.codex'), { recursive: true });
    const { watcher, lines } = harness(root, { maxWatchers: 1 });
    await watcher.start();
    assert.equal(watcher.watcherCount(), 1, 'cap holds');
    await watcher.stop();
    assert.equal(watcher.watcherCount(), 0, 'stop closes every watcher');
    assert.equal(lines.filter((l) => l.record.event === 'credential_watch_capped').length, 1);

    const second = harness(root);
    await second.watcher.start();
    const before = second.watcher.watcherCount();
    writeJson(path.join(root, '1', '.claude', '.credentials.json'), FULL);
    await second.watcher.rescan();
    assert.equal(second.watcher.watcherCount(), before + 1);
    assert.equal(second.lines.at(-1)?.record.state, 'linked', 'a new file found on rescan is logged');
    await second.watcher.stop();
  });

  it('WARNs when one vendor key leaves the provider-secrets store while others stay', async () => {
    const root = path.join(sandbox, 'users-secrets');
    const file = path.join(root, '9', '.provider-secrets', 'keys.json');
    writeJson(file, { glm: 'v1:SECRETCIPHER', kimi: 'v1:SECRETCIPHER' });
    const { watcher, lines } = harness(root);
    await watcher.start();
    replaceJson(file, { kimi: 'v1:SECRETCIPHER' });
    await until(() => lines.length > 0);
    await watcher.stop();
    assert.equal(lines[0].record.provider, 'provider-secrets');
    assert.equal(lines[0].level, 'warn');
    assert.deepEqual(lines[0].record.lostFields, ['glm']);
    assert.ok(!lines[0].raw.includes('SECRETCIPHER'));
  });

  it('a failure inside a debounced evaluation is logged, never thrown into the timer', async () => {
    // qa B-1771 r1: an exception in the setTimeout callback would crash the server.
    const root = path.join(sandbox, 'users-throw');
    const file = path.join(root, '1', '.claude', '.credentials.json');
    writeJson(file, FULL);
    const warnings: string[] = [];
    let thrown = 0;
    const logger = {
      info: () => undefined,
      warn: (raw: string) => {
        if (thrown === 0) { thrown += 1; throw new Error(`boom ${SECRET}`); }
        warnings.push(raw);
      },
    };
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    process.on('uncaughtException', onUncaught);
    const watcher = createCredentialFileWatcher({ usersRoot: root, logger, debounceMs: 20, rescanMs: 0 });
    try {
      await watcher.start();
      replaceJson(file, BROKEN);
      await until(() => warnings.length > 0);
      await settle();
    } finally {
      await watcher.stop();
      process.off('uncaughtException', onUncaught);
    }
    assert.equal(thrown, 1, 'the degrade line hit the failing logger');
    assert.deepEqual(uncaught, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /credential_watch_error/u);
    assert.ok(!warnings[0].includes(SECRET) && !warnings[0].includes('boom'), 'no error text or value is logged');
  });

  it('a missing users root is not an error', async () => {
    const { watcher, lines } = harness(path.join(sandbox, 'does-not-exist'));
    await watcher.start();
    await watcher.stop();
    assert.equal(lines.length, 0);
  });
});
