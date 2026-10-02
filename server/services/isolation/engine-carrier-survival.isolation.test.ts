/**
 * engine-carrier-survival.isolation.test.ts — tripwire: what must keep working
 * when the kimi / glm / deepseek / qwen / hermes / cursor agent BODIES are deleted.
 *
 * Several of those ids carry live meanings that are not a body:
 *   - kimi / glm / deepseek are ENGINES of the Claude body (endpoint + key);
 *   - kimi / deepseek / glm / qwen are key slots, and the first three are grantable;
 *   - the cage masks, the env sanitizer and the tree hardening still protect
 *     operator credentials that stay on disk after the bodies are gone.
 *
 * A failure here means a deletion step broke something live. Every case pins an
 * EFFECT (what a spawn would receive, what ends up on disk), and the file imports
 * nothing that is scheduled for deletion.
 *
 * Bootstrap mirrors credential-grants.test.ts: sandboxed $HOME + throwaway DB
 * opened before any project module is imported. Runner: node:test
 * (`npm run test:server -- <this file>`).
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-engine-carrier-survival-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const ORIGINAL_SECRETS_KEY = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
// An operator-level vendor key in the ambient env would mask a missing injection.
for (const name of ['KIMI_API_KEY', 'DEEPSEEK_API_KEY', 'GLM_API_KEY']) delete process.env[name];
assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

const { initializeDatabase, closeConnection, userDb, credentialGrantsDb } = await import('@/modules/database/index.js');
const shared = await import('../../../shared/engineProviders.js');
const endpoints = await import('./provider-anthropic-endpoints.js');
const { applyClaudeEngineProviderEnv } = await import('./apply-claude-engine-provider-env.js');
const { resolveSpawnEngine, OFFICIAL_ENGINE } = await import('./engine-pin.js');
const { resolveProviderEnv } = await import('./resolve-provider-env.js');
const {
  credentialPrincipalId,
  resolveCredentialPrincipal,
  GRANTABLE_PROVIDERS,
} = await import('./credential-principal.js');
const {
  KNOWN_PROVIDERS,
  isProviderIsolated,
  setProviderSharingConfig,
  _resetProviderSharingCache,
} = await import('../provider-sharing.js');
const {
  VENDOR_SECRET_PROVIDERS,
  setProviderKey,
  _resetProviderSecretsServerKeyCache,
} = await import('./provider-secrets-store.js');
const { cageMountPlan } = await import('./provider-cage-wiring.js');
const { provisionUserDirs, userConfigDir } = await import('./provision-user-dirs.js');
const { sanitizeVendorAgentEnv, sanitizeHostSecretEnv } = await import('./sanitize-vendor-agent-env.js');
const { VENDOR_RUNTIME } = await import('@/modules/providers/index.js');

await initializeDatabase();
_resetProviderSharingCache();

const owner = userDb.createUser('survival-owner', 'hash', 'user');
const grantee = userDb.createUser('survival-grantee', 'hash', 'user');
const loner = userDb.createUser('survival-loner', 'hash', 'user');
const hardened = userDb.createUser('survival-hardened', 'hash', 'user');

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = ORIGINAL_DB;
  if (ORIGINAL_SECRETS_KEY === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  else process.env.NASSAJ_PROVIDER_SECRETS_KEY = ORIGINAL_SECRETS_KEY;
  _resetProviderSecretsServerKeyCache();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const ENGINES = ['kimi', 'glm', 'deepseek'] as const;
type Engine = (typeof ENGINES)[number];

/** The endpoint each engine is called on; a change here moves user payloads to another host. */
const EXPECTED_ENDPOINT: Record<Engine, string> = {
  kimi: 'https://api.moonshot.ai/anthropic',
  deepseek: 'https://api.deepseek.com/anthropic',
  glm: 'https://api.z.ai/api/anthropic',
};

/** The one variable the hosted-vendor key is injected under. */
const EXPECTED_KEY_ENV: Record<Engine, string> = {
  kimi: 'KIMI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  glm: 'GLM_API_KEY',
};

const FORBIDDEN_NAMESPACE = /^(ANTHROPIC_|CLAUDE_)|_BASE_URL$/;

describe('engine axis: the three engines stay eligible and keep their endpoints', () => {
  it('declares exactly kimi, glm and deepseek as eligible engines', () => {
    assert.deepEqual([...shared.ELIGIBLE_ENGINE_PROVIDERS].sort(), [...ENGINES].sort());
    assert.deepEqual([...endpoints.ELIGIBLE_ENGINE_PROVIDERS].sort(), [...ENGINES].sort());
    for (const engine of ENGINES) {
      assert.equal(shared.isEngineProvider(engine), true, `${engine} must stay a known engine`);
      assert.equal(shared.isEngineProviderEligible(engine), true, `${engine} must stay eligible`);
      assert.equal(endpoints.ENGINE_PROVIDERS.has(engine), true);
    }
  });

  it('keeps each engine on its Anthropic-compatible endpoint', () => {
    for (const engine of ENGINES) {
      assert.equal(shared.ENGINE_ANTHROPIC_ENDPOINT[engine], EXPECTED_ENDPOINT[engine]);
      assert.equal(endpoints.PROVIDER_ANTHROPIC_ENDPOINT[engine], EXPECTED_ENDPOINT[engine]);
      assert.equal(shared.engineProviderHost(engine), new URL(EXPECTED_ENDPOINT[engine]).hostname);
    }
  });

  it('points a Claude spawn at the engine endpoint with the member key', () => {
    for (const engine of ENGINES) {
      setProviderKey(String(owner.id), engine, `sk-owner-${engine}`);
      const env: NodeJS.ProcessEnv = {};
      const verdict = applyClaudeEngineProviderEnv(env, String(owner.id), engine);

      assert.equal(verdict.status, 'applied', `${engine} must be honoured, not downgraded`);
      assert.equal(env.ANTHROPIC_BASE_URL, EXPECTED_ENDPOINT[engine]);
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, `sk-owner-${engine}`);
      assert.deepEqual(
        verdict.status === 'applied' ? [...verdict.hosts] : [],
        [new URL(EXPECTED_ENDPOINT[engine]).hostname],
      );
    }
  });

  it('refuses a keyless engine instead of falling back to official Anthropic', () => {
    for (const engine of ENGINES) {
      const env: NodeJS.ProcessEnv = {};
      const verdict = applyClaudeEngineProviderEnv(env, String(loner.id), engine);
      assert.deepEqual(verdict, { status: 'unavailable', provider: engine, reason: 'missing_key' });
      assert.deepEqual(env, {}, 'nothing may be half-injected');
    }
  });

  it('honours a stored engine pin for a historical session', () => {
    for (const engine of ENGINES) {
      assert.deepEqual(
        resolveSpawnEngine({ storedEngine: engine, clientEngine: null, enforce: true }),
        { engine, decision: 'server-wins', mismatch: true },
        `a session pinned to ${engine} must not run on ${OFFICIAL_ENGINE}`,
      );
    }
  });
});

describe('hosted key injection: only the key variable reaches the child', () => {
  it('injects the member key under the vendor variable and nothing else', () => {
    for (const engine of ENGINES) {
      assert.equal(VENDOR_RUNTIME[engine].keyEnv, EXPECTED_KEY_ENV[engine]);

      const base = { PATH: '/usr/bin', LANG: 'C.UTF-8' };
      const env = resolveProviderEnv(String(owner.id), engine, base);
      assert.equal(env[EXPECTED_KEY_ENV[engine]], `sk-owner-${engine}`);

      const added = Object.keys(env).filter((name) => !(name in base));
      assert.deepEqual(
        added.filter((name) => FORBIDDEN_NAMESPACE.test(name)),
        [],
        `${engine}: no ANTHROPIC_*/CLAUDE_*/*_BASE_URL variable may be set`,
      );
      // The kimi self-update kill switch belongs to the native CLI, not to the key.
      assert.deepEqual(
        added.filter((name) => name !== 'KIMI_CODE_NO_AUTO_UPDATE'),
        [EXPECTED_KEY_ENV[engine]],
        `${engine}: the key variable is the only injection`,
      );
    }
  });

  it('gives a member with no key no key (no operator fallback on this path)', () => {
    for (const engine of ENGINES) {
      const env = resolveProviderEnv(String(loner.id), engine, { PATH: '/usr/bin' });
      assert.equal(env[EXPECTED_KEY_ENV[engine]], undefined);
    }
  });
});

describe('credential policy: key slots and grants', () => {
  it('keeps the four vendor ids governable and their slots writable', () => {
    for (const id of ['kimi', 'deepseek', 'glm', 'qwen']) {
      assert.ok(KNOWN_PROVIDERS.includes(id), `${id} must stay in KNOWN_PROVIDERS`);
      assert.ok(VENDOR_SECRET_PROVIDERS.includes(id), `${id} must stay a secret slot`);
      assert.equal(isProviderIsolated(id), true, `${id} must default to per-user isolation`);
    }
    for (const id of ENGINES) {
      assert.ok(GRANTABLE_PROVIDERS.includes(id), `${id} must stay grantable`);
    }
    assert.equal(GRANTABLE_PROVIDERS.includes('qwen'), false, 'the personal Qwen key is never grantable');
  });

  it('never lets the personal Qwen slot become an operator-wide account', () => {
    setProviderSharingConfig({ qwen: 'shared' });
    assert.equal(isProviderIsolated('qwen'), true);
  });

  it('resolves a grantee to the owner for a granted engine, and spends the owner key', () => {
    for (const engine of ENGINES) {
      assert.equal(credentialPrincipalId(grantee.id, engine), grantee.id, 'base state: own credential');

      credentialGrantsDb.grant(owner.id, grantee.id, engine);
      assert.equal(credentialPrincipalId(grantee.id, engine), owner.id);
      assert.equal(resolveCredentialPrincipal(grantee.id, engine).grantedBy, owner.id);
      assert.equal(
        resolveProviderEnv(grantee.id, engine, {})[EXPECTED_KEY_ENV[engine]],
        `sk-owner-${engine}`,
        `${engine}: the grant decides whose key is spent`,
      );

      credentialGrantsDb.revoke(owner.id, grantee.id, engine);
      assert.equal(credentialPrincipalId(grantee.id, engine), grantee.id, 'revoking ends it');
      assert.equal(resolveProviderEnv(grantee.id, engine, {})[EXPECTED_KEY_ENV[engine]], undefined);
    }
  });
});

describe('cage: operator credentials of retired bodies stay masked', () => {
  const home = '/fake/operator-home';
  const hermesCredential = path.join(home, '.hermes', 'auth.json');
  const kimiCredential = path.join(home, '.kimi-code', 'auth.json');
  const present = new Set([
    hermesCredential,
    kimiCredential,
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.local', 'share', 'opencode', 'auth.json'),
  ]);
  const fakeFs = {
    homedir: () => home,
    existsSync: (candidate: string) => present.has(candidate),
    realpathSync: (candidate: string) => candidate,
  };

  for (const launching of ['claude', 'opencode', 'codex', 'agy']) {
    for (const isolated of [true, false]) {
      it(`masks the hermes and kimi credentials for a ${isolated ? 'isolated' : 'shared'} ${launching} launch`, () => {
        const plan = cageMountPlan(
          { provider: launching, userId: 7 },
          { ...fakeFs, isProviderIsolated: () => isolated },
        );
        assert.ok(plan.maskFiles.includes(hermesCredential), 'the hermes credential must be masked');
        assert.ok(plan.maskFiles.includes(kimiCredential), 'the kimi credential must be masked');
        assert.equal(plan.writePaths.includes(hermesCredential), false);
        assert.equal(plan.writePaths.includes(kimiCredential), false);
      });
    }
  }
});

describe('tree hardening: existing .kimi and .qwen dirs are tightened', () => {
  it('chmods pre-existing loose dirs to 0700 on a provisioning pass', () => {
    const root = userConfigDir(hardened.id, '');
    const kimiDir = path.join(root, '.kimi');
    const qwenDir = path.join(root, '.qwen');
    for (const dir of [root, kimiDir, qwenDir]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(dir, 0o755);
    }

    provisionUserDirs(hardened.id);

    const mode = (target: string) => fs.statSync(target).mode & 0o777;
    assert.equal(mode(kimiDir), 0o700, 'an existing .kimi dir must not stay group/world readable');
    assert.equal(mode(qwenDir), 0o700, 'an existing .qwen dir must not stay group/world readable');
    assert.equal(mode(root), 0o700);
  });
});

describe('env sanitizer: vendor and harness namespaces are still stripped', () => {
  const hostile = {
    PATH: '/usr/bin',
    CURSOR_API_KEY: 'x',
    CURSOR_CONFIG_DIR: 'x',
    ANTHROPIC_BASE_URL: 'x',
    CLAUDE_CODE_OAUTH_TOKEN: 'x',
    CLAUDE_CONFIG_DIR: 'x',
    OPENAI_API_KEY: 'x',
    GEMINI_API_KEY: 'x',
    GH_TOKEN: 'x',
    GITHUB_TOKEN: 'x',
    NASSAJ_QWEN_PLAN_API_KEY: 'x',
    DASHSCOPE_API_KEY: 'x',
    BAILIAN_API_KEY: 'x',
    SOME_BASE_URL: 'x',
    JWT_SECRET: 'x',
    KIMI_API_KEY: 'keep',
    DEEPSEEK_API_KEY: 'keep',
    GLM_API_KEY: 'keep',
    ZAI_API_KEY: 'keep',
  };

  it('keeps only the target vendor keys for a vendor agent child', () => {
    assert.deepEqual(
      Object.keys(sanitizeVendorAgentEnv(hostile)).sort(),
      ['DEEPSEEK_API_KEY', 'GLM_API_KEY', 'KIMI_API_KEY', 'PATH', 'ZAI_API_KEY'],
    );
  });

  it('strips the Qwen plan key and the Alibaba namespaces from every provider child', () => {
    const clean = sanitizeHostSecretEnv(hostile);
    for (const name of ['NASSAJ_QWEN_PLAN_API_KEY', 'DASHSCOPE_API_KEY', 'BAILIAN_API_KEY', 'JWT_SECRET']) {
      assert.equal(name in clean, false, `${name} must not reach a provider child`);
    }

    const resolved = resolveProviderEnv(null, 'claude', hostile);
    for (const name of ['NASSAJ_QWEN_PLAN_API_KEY', 'DASHSCOPE_API_KEY', 'BAILIAN_API_KEY']) {
      assert.equal(name in resolved, false, `${name} must not reach a Claude spawn`);
    }
  });
});

describe('static boundaries', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

  /** Strips // line comments and block comments so matches reflect real code. */
  const stripComments = (source: string) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const ENGINE_AXIS_MODULES = [
    'shared/engineProviders.ts',
    'shared/bodyEngineMatrix.ts',
    'server/services/isolation/engine-pin.js',
    'server/services/isolation/apply-claude-engine-provider-env.js',
    'server/services/isolation/provider-anthropic-endpoints.js',
    'server/services/isolation/provider-slot-key.js',
    'server/services/isolation/resolve-claude-run-profile.js',
    'server/services/isolation/credential-principal.js',
    'server/services/isolation/anthropic-base-url-guard.js',
    'src/components/chat/hooks/engineProviderSession.ts',
    'src/components/chat/view/subcomponents/engineGuard.ts',
  ];

  it('engine-axis modules never consult the body-axis lists', () => {
    for (const file of ENGINE_AXIS_MODULES) {
      const code = stripComments(read(file));
      assert.equal(
        /(?:from|import)\s*\(?\s*['"][^'"]*(?:retiredProviders|disabledProviders)[^'"]*['"]/.test(code),
        false,
        `${file} must not import retiredProviders or disabledProviders: retiring a body may never revoke an engine`,
      );
    }
  });

  it('the hosted reviewer adapter obeys the iron rule', () => {
    const code = stripComments(read('server/modules/turn-supervisor/adapters/hosted-vendor-adapter.ts'));
    assert.equal(/@anthropic-ai\//.test(code), false, 'must not import any @anthropic-ai package');
    assert.equal(/claude-sdk/.test(code), false, 'must not route through claude-sdk');
    assert.deepEqual(code.match(/ANTHROPIC_[A-Z_]+/g) ?? [], []);
    assert.deepEqual(code.match(/CLAUDE_[A-Z_]+/g) ?? [], []);
  });
});
