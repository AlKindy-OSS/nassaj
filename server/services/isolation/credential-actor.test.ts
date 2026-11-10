/**
 * credential-actor.test — ADR-152 amendment 1 §3.4 (T-2083, BE-8).
 *
 * Every credential resolution names WHO it runs for: a real member (a positive
 * integer id) or the explicit SYSTEM_ACTOR, which has no credential at all. A
 * missing or malformed actor is refused with CREDENTIAL_ACTOR_REQUIRED and no
 * environment is built — never the operator's environment.
 *
 * Runner: node:test. Sandboxed $HOME + throwaway DB opened before any import.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-credential-actor-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const operatorHome = path.join(sandbox, 'home');
fs.mkdirSync(operatorHome, { recursive: true });
process.env.HOME = operatorHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
assert.equal(os.homedir(), operatorHome);

const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
const {
  SYSTEM_ACTOR, normalizeCredentialActor, isSystemActor, assertModelRunActor, systemActorHome,
} = await import('./credential-actor.js');
const { resolveProviderEnv, resolveCatalogEnv } = await import('./resolve-provider-env.js');
const { KNOWN_PROVIDERS } = await import('./known-providers.js');

await initializeDatabase();

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const isActorRequired = (error: unknown): boolean => {
  const e = error as { code?: string; statusCode?: number };
  assert.equal(e.code, 'CREDENTIAL_ACTOR_REQUIRED');
  assert.equal(e.statusCode, 500);
  return true;
};

const BAD_ACTORS: unknown[] = [null, undefined, '', 0, -3, 1.5, NaN, '0', '007', ' 7', '7a', 'anonymous', {}, [], true,
  Object.freeze({ kind: 'system' })];

describe('normalizeCredentialActor', () => {
  it('accepts a positive integer, or its canonical decimal string, as a number', () => {
    assert.equal(normalizeCredentialActor(7), 7);
    assert.equal(normalizeCredentialActor('42'), 42);
  });

  it('passes SYSTEM_ACTOR through unchanged (identity, not shape)', () => {
    assert.equal(normalizeCredentialActor(SYSTEM_ACTOR), SYSTEM_ACTOR);
    assert.equal(isSystemActor(SYSTEM_ACTOR), true);
    assert.equal(Object.isFrozen(SYSTEM_ACTOR), true);
  });

  it('refuses everything else with CREDENTIAL_ACTOR_REQUIRED (500)', () => {
    for (const actor of BAD_ACTORS) {
      assert.throws(() => normalizeCredentialActor(actor), isActorRequired, String(actor));
      assert.equal(isSystemActor(actor), false, `a look-alike is not the system actor: ${String(actor)}`);
    }
  });

  it('SYSTEM_ACTOR is refused for a model run; a member is not', () => {
    assert.throws(() => assertModelRunActor(SYSTEM_ACTOR), isActorRequired);
    assert.throws(() => assertModelRunActor(null), isActorRequired);
    assert.equal(assertModelRunActor('5'), 5);
  });
});

describe('resolveProviderEnv — the actor contract', () => {
  it('AT4: a resolver called with null (or any bad actor) throws and builds no environment', () => {
    for (const provider of KNOWN_PROVIDERS as string[]) {
      for (const actor of BAD_ACTORS) {
        assert.throws(() => resolveProviderEnv(actor as never, provider, { HOME: operatorHome }), isActorRequired);
      }
    }
  });

  it('the catalog resolver answers null (degraded, spawn nothing) for a missing actor', () => {
    assert.equal(resolveCatalogEnv(null as never, 'agy', { HOME: operatorHome }), null);
  });

  it('SYSTEM_ACTOR gets a credential-less tree under ~/.nassaj-users/.system for every provider knob', () => {
    const root = systemActorHome();
    assert.equal(root, path.join(operatorHome, '.nassaj-users', '.system'));
    const base = {
      PATH: '/usr/bin', HOME: operatorHome, CLAUDE_CONFIG_DIR: path.join(operatorHome, '.claude'),
      CODEX_HOME: path.join(operatorHome, '.codex'), XDG_DATA_HOME: path.join(operatorHome, '.local', 'share'),
    };
    const knobs: Record<string, string[]> = {
      claude: ['CLAUDE_CONFIG_DIR'], codex: ['CODEX_HOME'], agy: ['HOME'], cursor: ['HOME'], qwen: ['HOME'],
      opencode: ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'], kimi: ['KIMI_CODE_HOME'],
      deepseek: [], glm: [], dsh: ['HOME'],
    };
    for (const provider of KNOWN_PROVIDERS as string[]) {
      const env = resolveProviderEnv(SYSTEM_ACTOR as never, provider, { ...base }, 'agent');
      for (const knob of knobs[provider]) {
        assert.ok(String(env[knob]).startsWith(root), `${provider}: ${knob}=${env[knob]} must be the system tree`);
      }
      for (const name of ['KIMI_API_KEY', 'DEEPSEEK_API_KEY', 'GLM_API_KEY']) {
        assert.equal(env[name], undefined, `${provider}: the system actor carries no vendor key`);
      }
    }
    assert.equal(fs.statSync(root).mode & 0o777, 0o700, 'the system tree is private');
  });
});

describe('SYSTEM_ACTOR is never derived from request data — import pin', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  /**
   * The ONLY production modules allowed to name SYSTEM_ACTOR: each uses it for
   * non-inference work (version, install, update, empty-catalog probes) with no
   * request in scope. Adding a module here is a reviewed decision.
   */
  const ALLOWED = new Set([
    'server/services/isolation/credential-actor.js',
    'server/services/isolation/resolve-provider-env.js',
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'dist-server'].includes(entry.name)) walk(rel, out);
      } else if (/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) && !/\.test\.|[/\\](?:tests|__tests__)[/\\]/.test(rel)) {
        out.push(rel);
      }
    }
    return out;
  }

  it('only the pinned modules name SYSTEM_ACTOR', () => {
    const offenders = [...walk('server'), ...walk('shared'), ...walk('src')]
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => /\bSYSTEM_ACTOR\b/.test(fs.readFileSync(path.join(repoRoot, file), 'utf8')));
    assert.deepEqual(offenders, []);
  });
});
