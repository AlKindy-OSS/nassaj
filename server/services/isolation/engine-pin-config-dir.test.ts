/**
 * ADR-200 S2 (C1, D7, M-6) — the derived credential-free CLAUDE_CONFIG_DIR an
 * engine-pinned spawn runs on. Fixtures mirror the real file shapes the CLI
 * reads; every credential is a dummy. Runner: node:test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import {
  DERIVED_FORBIDDEN_FILES,
  ENGINE_PIN_CONFIG_DIR_CODE,
  ENGINE_PIN_RESUME_CONTINUITY_CODE,
  LINKED_ENTRIES,
  derivedConfigDirFor,
  prepareEnginePinConfigDir,
  verifyDerivedConfigDir,
  withDerivedDirLock,
} from './engine-pin-config-dir.js';

const DUMMY_KEY = 'sk' + '-ant-api03-DUMMY-NOT-A-REAL-KEY';
const DUMMY_OAUTH = 'sk' + '-ant-oat01-DUMMY-NOT-A-REAL-TOKEN';

type Fixture = { root: string; userRoot: string; source: string; operatorHome: string };
let fx: Fixture;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** A user tree with a credential in every user-scope channel. */
function seedCredentialedSource(source: string): void {
  writeJson(path.join(source, 'settings.json'), {
    theme: 'dark',
    apiKeyHelper: `echo ${DUMMY_KEY}`,
    env: {
      ANTHROPIC_API_KEY: DUMMY_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: DUMMY_OAUTH,
      ANTHROPIC_AUTH_TOKEN: DUMMY_KEY,
      ANTHROPIC_CUSTOM_HEADERS: `x-leak: ${DUMMY_KEY}`,
      DISABLE_TELEMETRY: '1',
    },
  });
  writeJson(path.join(source, '.claude.json'), {
    primaryApiKey: DUMMY_KEY,
    hasCompletedOnboarding: true,
    projects: { '/work/p': { hasTrustDialogAccepted: true } },
  });
  writeJson(path.join(source, '.credentials.json'), { claudeAiOauth: { accessToken: DUMMY_OAUTH } });
  fs.mkdirSync(path.join(source, 'projects', '-work-p'), { recursive: true });
  fs.writeFileSync(path.join(source, 'CLAUDE.md'), '# shared\n');
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-pin-dir-'));
  const userRoot = path.join(root, 'users', '7');
  const source = path.join(userRoot, '.claude');
  const operatorHome = path.join(root, 'operator');
  writeJson(path.join(operatorHome, '.claude', 'settings.json'), {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.js' }] }] },
    cleanupPeriodDays: 99,
    theme: 'operator-personal',
  });
  seedCredentialedSource(source);
  fx = { root, userRoot, source, operatorHome };
});

afterEach(() => {
  fs.rmSync(fx.root, { recursive: true, force: true });
});

const prepare = (env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: fx.source }) =>
  prepareEnginePinConfigDir(env, { operatorHome: fx.operatorHome });

test('derived dir is a sibling of the source config dir', async () => {
  const derived = await prepare();
  assert.equal(derived, path.join(fx.userRoot, '.claude-engine-pin'));
  assert.equal(derived, derivedConfigDirFor(fx.source));
  assert.equal(fs.statSync(derived).mode & 0o777, 0o700);
});

test('settings.json is a stripped copy with operator policy applied', async () => {
  const derived = await prepare();
  const settings = readJson(path.join(derived, 'settings.json'));
  assert.equal(fs.lstatSync(path.join(derived, 'settings.json')).isSymbolicLink(), false);
  assert.equal('apiKeyHelper' in settings, false);
  assert.deepEqual(settings.env, { DISABLE_TELEMETRY: '1' });
  assert.equal(settings.theme, 'dark', 'personal prefs survive');
  assert.equal(settings.cleanupPeriodDays, 99, 'operator policy applied');
  assert.ok(settings.hooks, 'operator hooks applied');
  const source = readJson(path.join(fx.source, 'settings.json'));
  assert.equal((source.env as Record<string, string>).ANTHROPIC_API_KEY, DUMMY_KEY, 'source untouched');
});

test('.claude.json is a copy without primaryApiKey, and no .credentials.json exists', async () => {
  const derived = await prepare();
  const configPath = path.join(derived, '.claude.json');
  assert.equal(fs.lstatSync(configPath).isSymbolicLink(), false, 'a copy, never a link');
  const config = readJson(configPath);
  assert.equal('primaryApiKey' in config, false);
  assert.equal(config.hasCompletedOnboarding, true);
  assert.deepEqual(config.projects, { '/work/p': { hasTrustDialogAccepted: true } });
  for (const name of DERIVED_FORBIDDEN_FILES) {
    assert.equal(fs.existsSync(path.join(derived, name)), false, `${name} absent`);
  }
  const all = fs.readdirSync(derived).filter((name) => {
    const stat = fs.lstatSync(path.join(derived, name));
    return stat.isFile() && fs.readFileSync(path.join(derived, name), 'utf8').includes(DUMMY_KEY);
  });
  assert.deepEqual(all, [], 'no real file in the derived dir carries the key');
});

test('a credential file the CLI wrote into the derived dir is removed on the next build', async () => {
  const derived = await prepare();
  writeJson(path.join(derived, '.credentials.json'), { claudeAiOauth: { accessToken: DUMMY_OAUTH } });
  writeJson(path.join(derived, '.claude.json'), { primaryApiKey: DUMMY_KEY });
  await prepare();
  assert.equal(fs.existsSync(path.join(derived, '.credentials.json')), false);
  assert.equal('primaryApiKey' in readJson(path.join(derived, '.claude.json')), false);
});

test('shared entries are linked, credential files never are', async () => {
  const derived = await prepare();
  assert.equal(fs.readlinkSync(path.join(derived, 'projects')), path.join(fx.source, 'projects'));
  assert.equal(fs.readlinkSync(path.join(derived, 'CLAUDE.md')), path.join(fx.source, 'CLAUDE.md'));
  for (const name of DERIVED_FORBIDDEN_FILES) assert.equal(LINKED_ENTRIES.includes(name), false);
  for (const name of ['settings.json', '.claude.json']) assert.equal(LINKED_ENTRIES.includes(name), false);
});

test('resume continuity: pinned -> unpinned -> pinned share one transcript', async () => {
  const transcript = (dir: string) => path.join(dir, 'projects', '-work-p', 'session-1.jsonl');
  let derived = await prepare();
  fs.appendFileSync(transcript(derived), '{"turn":"pinned-1"}\n');
  fs.appendFileSync(transcript(fx.source), '{"turn":"unpinned"}\n');
  derived = await prepare();
  fs.appendFileSync(transcript(derived), '{"turn":"pinned-2"}\n');
  const lines = fs.readFileSync(transcript(fx.source), 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((line) => JSON.parse(line).turn), ['pinned-1', 'unpinned', 'pinned-2']);
  assert.equal(fs.realpathSync(transcript(derived)), fs.realpathSync(transcript(fx.source)));
});

test('a source without projects/ gets one, so continuity is never skipped', async () => {
  fs.rmSync(path.join(fx.source, 'projects'), { recursive: true });
  const derived = await prepare();
  assert.equal(fs.realpathSync(path.join(derived, 'projects')), fs.realpathSync(path.join(fx.source, 'projects')));
});

test('refuses when derived projects/ is a real dir (continuity cannot be proven)', async () => {
  const derived = derivedConfigDirFor(fx.source);
  fs.mkdirSync(path.join(derived, 'projects'), { recursive: true });
  await assert.rejects(prepare(), { code: ENGINE_PIN_RESUME_CONTINUITY_CODE });
});

test('refuses when the derived path is a symlink', async () => {
  const elsewhere = path.join(fx.root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, derivedConfigDirFor(fx.source));
  await assert.rejects(prepare(), { code: ENGINE_PIN_CONFIG_DIR_CODE });
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing written through the link');
});

test('a malformed source settings.json refuses (fail-closed)', async () => {
  fs.writeFileSync(path.join(fx.source, 'settings.json'), '{not json');
  await assert.rejects(prepare(), (error: Error & { code?: string }) => Boolean(error.code));
});

test('verifyDerivedConfigDir refuses a surviving credential', async () => {
  const derived = await prepare();
  writeJson(path.join(derived, 'settings.json'), { env: { ANTHROPIC_API_KEY: DUMMY_KEY } });
  assert.throws(() => verifyDerivedConfigDir(derived), { code: ENGINE_PIN_CONFIG_DIR_CODE });
});

test('without CLAUDE_CONFIG_DIR the global config comes from $HOME/.claude.json', async () => {
  const home = path.join(fx.root, 'shared-home');
  writeJson(path.join(home, '.claude', 'settings.json'), { env: { ANTHROPIC_API_KEY: DUMMY_KEY } });
  writeJson(path.join(home, '.claude.json'), { primaryApiKey: DUMMY_KEY, numStartups: 3 });
  const derived = await prepare({ HOME: home });
  assert.equal(derived, path.join(home, '.claude-engine-pin'));
  assert.deepEqual(readJson(path.join(derived, '.claude.json')), { numStartups: 3 });
});

test('concurrent pinned spawns: builds never overlap and every result is verified', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => {
    writeJson(path.join(fx.source, 'settings.json'), { env: { ANTHROPIC_API_KEY: DUMMY_KEY, N: String(i) } });
    return prepare();
  }));
  assert.equal(new Set(results).size, 1);
  verifyDerivedConfigDir(results[0]);
  assert.equal(fs.existsSync(`${results[0]}.lock`), false, 'lock released');
});

test('withDerivedDirLock serialises holders of the same dir', async () => {
  const dir = path.join(fx.root, 'lock-target');
  let inside = 0;
  let maxInside = 0;
  await Promise.all(Array.from({ length: 6 }, () => withDerivedDirLock(dir, async () => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inside -= 1;
  })));
  assert.equal(maxInside, 1);
});

test('a stale cross-process lock (dead owner) is taken over', async () => {
  const derived = derivedConfigDirFor(fx.source);
  fs.mkdirSync(`${derived}.lock`, { recursive: true });
  fs.writeFileSync(path.join(`${derived}.lock`, 'owner'), '2147483646');
  await prepare();
  assert.equal(fs.existsSync(`${derived}.lock`), false);
});
