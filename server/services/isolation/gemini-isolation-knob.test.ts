/**
 * B-548 — the gemini isolation knob must be one the CLI ACTUALLY READS.
 *
 * The defect this file guards is not "wrong value in an env var". It is an env
 * var that reached the spawn and was ignored: `GEMINI_CLI_HOME`. Nothing failed,
 * nothing logged, and every member's gemini turn quietly ran on the OPERATOR's
 * ~/.gemini OAuth token for as long as the provider existed. A test that merely
 * re-asserted the resolver's own output would have passed throughout — it is the
 * shape of test that let the bug live.
 *
 * So the load-bearing assertion here is GROUNDED IN THE INSTALLED BINARY, not in
 * a restatement of the source: every key the resolver adds for `gemini` must
 * either be a POSIX variable every process honors (HOME) or appear literally
 * inside the executable that `gemini` resolves to. `GEMINI_CLI_HOME` satisfies
 * neither — it occurs ZERO times in the 199 MB binary — so the pre-fix resolver
 * fails this test, which is the whole point.
 *
 * Measured on 2026-08-07 against the binary this provider launches:
 *   1. `strings` over the executable: ZERO occurrences of GEMINI_CLI_HOME.
 *   2. `env -i HOME=A GEMINI_CLI_HOME=B <cli> -p …` wrote its ENTIRE tree under
 *      A/.gemini (config/, antigravity-cli/ + OAuth token, brain, conversations,
 *      logs) and created nothing at all under B.
 *   3. Authenticated canary: the turn obeyed A/.gemini/GEMINI.md while atime
 *      proved B/.gemini/GEMINI.md, B/GEMINI.md and $CWD/GEMINI.md unopened.
 *
 * The binary-grounded case SKIPS (never fails) when the CLI is not installed, so
 * this suite stays green on a machine without it — but it cannot be made green
 * by re-introducing a name the tool ignores on a machine that HAS it.
 *
 * Bootstrap mirrors resolve-provider-env.test.ts: sandboxed $HOME + throwaway DB
 * opened before importing any project module. Runner: node:test + node:assert.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import fs from 'fs';
import os from 'os';
import path from 'path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-gemini-knob-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;

const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
const { KNOWN_PROVIDERS, setProviderSharingConfig, _resetProviderSharingCache } =
  await import('../provider-sharing.js');
const { resolveProviderEnv } = await import('./resolve-provider-env.js');
const { userConfigDir } = await import('./provision-user-dirs.js');

await initializeDatabase();

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** A base env small enough that "what did the resolver change?" is unambiguous. */
const BASE: NodeJS.ProcessEnv = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/operator/home',
  LANG: 'C.UTF-8',
});

function setPolicy(mode: 'shared' | 'isolated'): void {
  _resetProviderSharingCache();
  setProviderSharingConfig({ gemini: mode });
}

/** Keys the resolver ADDED or CHANGED relative to `base` — its actual footprint. */
function changedKeys(base: NodeJS.ProcessEnv, resolved: NodeJS.ProcessEnv): string[] {
  return Object.keys(resolved)
    .filter(k => resolved[k] !== base[k])
    .sort();
}

/**
 * Env names every POSIX process honors regardless of vendor, so they need no
 * evidence from the binary. Deliberately tiny: anything else must prove itself.
 */
const UNIVERSALLY_HONORED = new Set(['HOME']);

/** Resolves `gemini` (or $GEMINI_PATH) through PATH, exactly as the spawn does. */
function resolveGeminiBinary(): string | null {
  const configured = process.env.GEMINI_PATH || 'gemini';
  if (configured.includes(path.sep)) {
    return fs.existsSync(configured) ? fs.realpathSync(configured) : null;
  }
  // PATH is untouched by the sandbox (only HOME/DATABASE_PATH were rewritten).
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, configured);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // keep scanning
    }
  }
  return null;
}

/**
 * Streams `file` looking for the ASCII `needle`. Chunked with an overlap so a
 * match straddling a chunk boundary is still found; never loads the whole
 * executable (it is ~199 MB) into memory.
 */
function binaryContainsAscii(file: string, needle: string): boolean {
  const CHUNK = 8 * 1024 * 1024;
  const overlap = Buffer.byteLength(needle) - 1;
  const pattern = Buffer.from(needle, 'ascii');
  const buf = Buffer.allocUnsafe(CHUNK + overlap);
  const fd = fs.openSync(file, 'r');
  try {
    let carried = 0;
    for (;;) {
      const read = fs.readSync(fd, buf, carried, CHUNK, null);
      if (read <= 0) return false;
      const filled = buf.subarray(0, carried + read);
      if (filled.includes(pattern)) return true;
      if (overlap > 0) {
        filled.subarray(filled.length - overlap).copy(buf, 0);
        carried = overlap;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

describe('B-548 — gemini isolates through a knob the CLI actually reads', () => {
  it('the policy gate KNOWS the key "gemini" (a mismatched key = no isolation at all)', () => {
    // The agy precedent: the governance layer keys that provider as 'agy', never
    // 'antigravity'. A provider absent from KNOWN_PROVIDERS does not fall back to
    // "shared" quietly any more (ADR-105 throws), but a key that never matches is
    // still the cheapest way to lose isolation, so pin the spelling.
    assert.ok(
      KNOWN_PROVIDERS.includes('gemini'),
      'gemini must be a key the sharing policy recognizes, or the resolver refuses it',
    );
  });

  it('isolated: HOME — and ONLY HOME — is redirected to the user tree', () => {
    setPolicy('isolated');
    const env = resolveProviderEnv(4801, 'gemini', { ...BASE });

    assert.equal(env.HOME, userConfigDir(4801, ''), 'gemini must isolate through HOME');
    assert.notEqual(env.HOME, BASE.HOME, 'the operator HOME must not survive an isolated spawn');
    assert.deepEqual(
      changedKeys(BASE, env),
      ['HOME'],
      'HOME is the only knob this CLI reads; any additional key is unproven',
    );
  });

  it('the retired GEMINI_CLI_HOME is not reintroduced', () => {
    setPolicy('isolated');
    const env = resolveProviderEnv(4802, 'gemini', { ...BASE });
    assert.equal(
      env.GEMINI_CLI_HOME,
      undefined,
      'GEMINI_CLI_HOME is read by nothing — setting it is isolation theatre (B-548)',
    );
  });

  it('two members never share a resolved home', () => {
    setPolicy('isolated');
    const a = resolveProviderEnv(4803, 'gemini', { ...BASE });
    const b = resolveProviderEnv(4804, 'gemini', { ...BASE });
    assert.notEqual(a.HOME, b.HOME);
  });

  it('shared policy leaves HOME on the operator (admin choice is honored)', () => {
    setPolicy('shared');
    const env = resolveProviderEnv(4805, 'gemini', { ...BASE });
    assert.deepEqual(env, { ...BASE }, 'shared gemini must not rewrite anything');
  });

  it('anonymous spawns are never rewritten', () => {
    setPolicy('isolated');
    assert.deepEqual(resolveProviderEnv(null, 'gemini', { ...BASE }), { ...BASE });
  });
});

describe('B-548 — binary-grounded: every knob set for gemini exists in the executable', () => {
  let binary: string | null = null;

  before(() => {
    binary = resolveGeminiBinary();
  });

  it('no env key is set that the installed CLI contains no reference to', (t) => {
    if (!binary) {
      t.skip('gemini CLI not installed on this host — nothing to ground the assertion in');
      return;
    }

    setPolicy('isolated');
    const env = resolveProviderEnv(4806, 'gemini', { ...BASE });
    const unproven = changedKeys(BASE, env)
      .filter(k => !UNIVERSALLY_HONORED.has(k))
      .filter(k => !binaryContainsAscii(binary as string, k));

    assert.deepEqual(
      unproven,
      [],
      `resolveProviderEnv sets ${JSON.stringify(unproven)} for gemini, but ${binary} contains no `
        + 'reference to those names. An env var the tool does not read isolates NOTHING: the spawn '
        + 'silently falls back to the operator\'s credentials. Measure the real knob (probe with '
        + '`env -i HOME=A <var>=B <cli>` and see which tree it writes) before adding one here.',
    );
  });

  it('GEMINI_CLI_HOME is absent from the binary — the measurement this fix rests on', (t) => {
    if (!binary) {
      t.skip('gemini CLI not installed on this host');
      return;
    }
    assert.equal(
      binaryContainsAscii(binary, 'GEMINI_CLI_HOME'),
      false,
      `${binary} unexpectedly references GEMINI_CLI_HOME. The premise of B-548 was that it does `
        + 'not. If a different CLI is now installed under this name, RE-MEASURE the knob before '
        + 'changing resolveProviderEnv — do not assume either way.',
    );
  });

  it('HOME is referenced by the binary too (the knob is not merely assumed)', (t) => {
    if (!binary) {
      t.skip('gemini CLI not installed on this host');
      return;
    }
    // Weak on its own (HOME is a common substring), which is why the live probes
    // in this file's header — not this assertion — are the real evidence. It is
    // here so a binary that references NOTHING we set trips at least one case.
    assert.ok(binaryContainsAscii(binary, '.gemini'), 'the CLI must key its tree off a .gemini dir');
  });
});
