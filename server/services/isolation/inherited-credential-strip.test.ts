/**
 * inherited-credential-strip.test — ADR-152 amendment 1 §3.5 (T-2083, BE-7).
 *
 * A credential variable the SERVER process inherited (an operator's
 * ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY, …) must reach no
 * provider child, for any actor. The resolver strips the sixteen names before
 * the per-provider case and then injects only the credential owner's own key;
 * the final host-secret strip covers the six names the resolver never injects.
 * Status checks no longer count an inherited env token as "linked".
 *
 * Runner: node:test. Sandboxed $HOME + throwaway DB opened before any import.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-inherited-strip-test-'));
const ORIGINAL = { HOME: process.env.HOME, DATABASE_PATH: process.env.DATABASE_PATH, KEY: process.env.NASSAJ_PROVIDER_SECRETS_KEY };
const operatorHome = path.join(sandbox, 'home');
fs.mkdirSync(operatorHome, { recursive: true });
process.env.HOME = operatorHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const { initializeDatabase, closeConnection, userDb, credentialGrantsDb } = await import('@/modules/database/index.js');
const { resolveProviderEnv, INHERITED_CREDENTIAL_ENV } = await import('./resolve-provider-env.js');
const { NASSAJ_HOST_SECRET_EXACT_DENY } = await import('./sanitize-vendor-agent-env.js');
const { KNOWN_PROVIDERS } = await import('./known-providers.js');
const { SYSTEM_ACTOR } = await import('./credential-actor.js');
const { setProviderKey, _resetProviderSecretsServerKeyCache } = await import('./provider-secrets-store.js');

await initializeDatabase();

after(() => {
  closeConnection();
  for (const [key, value] of Object.entries({ HOME: ORIGINAL.HOME, DATABASE_PATH: ORIGINAL.DATABASE_PATH, NASSAJ_PROVIDER_SECRETS_KEY: ORIGINAL.KEY })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  _resetProviderSecretsServerKeyCache();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** qa M5: cloud-routing switches and AWS/GCP credentials Claude Code reads. */
const CLOUD = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_VERTEX_PROJECT_ID',
];
/** The sixteen inherited credential names of ADR-152 A1 §3.5. */
const SIXTEEN = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  'CURSOR_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'GLM_API_KEY', 'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
];
/** Never injected by the resolver, so the final host-secret strip covers them too. */
const SIX = ['CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'CURSOR_API_KEY'];

const inherited = (name: string) => `inherited-operator-${name}`;
const operatorEnv = (): NodeJS.ProcessEnv => ({
  PATH: '/usr/bin', HOME: operatorHome,
  ...Object.fromEntries([...SIXTEEN, ...CLOUD].map((name) => [name, inherited(name)])),
});
const VENDOR_KEY_ENV: Record<string, string> = { kimi: 'KIMI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', glm: 'GLM_API_KEY' };

/** Asserts no inherited value survives anywhere in `env`. */
function assertNoInherited(env: NodeJS.ProcessEnv, label: string): void {
  for (const [name, value] of Object.entries(env)) {
    assert.ok(!String(value).startsWith('inherited-operator-'), `${label}: ${name} carries an inherited credential`);
  }
}

describe('§3.5 the strip lists', () => {
  it('the resolver pre-strips exactly the sixteen credential names plus the cloud-routing set (qa M5)', () => {
    assert.deepEqual([...INHERITED_CREDENTIAL_ENV].sort(), [...SIXTEEN, ...CLOUD].sort());
  });

  it('the final host-secret strip also covers the six names the resolver never injects', () => {
    for (const name of SIX) assert.ok(NASSAJ_HOST_SECRET_EXACT_DENY.includes(name), name);
  });
});

describe('§3.5 per provider × {member, grantee, SYSTEM_ACTOR}: only the owner\'s own key survives', () => {
  const member = userDb.createUser('strip-member', 'hash', 'user');
  const owner = userDb.createUser('strip-owner', 'hash', 'user');
  const grantee = userDb.createUser('strip-grantee', 'hash', 'user');
  for (const provider of ['kimi', 'deepseek', 'glm']) {
    setProviderKey(member.id, provider, `own-${provider}-${member.id}`);
    setProviderKey(owner.id, provider, `own-${provider}-${owner.id}`);
  }
  for (const provider of KNOWN_PROVIDERS as string[]) {
    if (provider !== 'qwen') credentialGrantsDb.grant(owner.id, grantee.id, provider);
  }

  for (const provider of KNOWN_PROVIDERS as string[]) {
    for (const mode of ['chat', 'agent'] as const) {
      it(`${provider}/${mode}`, () => {
        const asMember = resolveProviderEnv(member.id, provider, operatorEnv(), mode);
        const asGrantee = resolveProviderEnv(grantee.id, provider, operatorEnv(), mode);
        const asSystem = resolveProviderEnv(SYSTEM_ACTOR as never, provider, operatorEnv(), mode);
        assertNoInherited(asMember, `${provider}/${mode}/member`);
        assertNoInherited(asGrantee, `${provider}/${mode}/grantee`);
        assertNoInherited(asSystem, `${provider}/${mode}/system`);
        const keyEnv = VENDOR_KEY_ENV[provider];
        if (keyEnv) {
          assert.equal(asMember[keyEnv], `own-${provider}-${member.id}`, 'the member\'s own key');
          assert.equal(asGrantee[keyEnv], `own-${provider}-${owner.id}`, 'the grantor\'s key, by grant');
          assert.equal(asSystem[keyEnv], undefined, 'the system actor has no key');
        }
      });
    }
  }
});

describe('§3.5 status checks stop treating an inherited env token as linked', () => {
  it('claude: an inherited CLAUDE_CODE_OAUTH_TOKEN does not make a member linked', async () => {
    const { ClaudeProviderAuth } = await import('@/modules/providers/list/claude/claude-auth.provider.js');
    const member = userDb.createUser('strip-claude-status', 'hash', 'user');
    const saved = { ...process.env };
    // Built at runtime so the source carries no token-shaped literal for the export leak scan.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = ['sk', 'ant', 'oat01', 'inherited', 'operator'].join('-');
    process.env.ANTHROPIC_AUTH_TOKEN = 'inherited-operator-token';
    process.env.CLAUDE_CLI_PATH = process.execPath;
    try {
      const status = await new ClaudeProviderAuth().getStatus(member.id);
      assert.equal(status.authenticated, false, 'an inherited server token is not this member\'s link');
    } finally {
      for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CLI_PATH']) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      }
    }
  });

  it('opencode: an inherited OPENAI_API_KEY in the server env does not make a member linked', async () => {
    const { OpenCodeProviderAuth } = await import('@/modules/providers/list/opencode/opencode-auth.provider.js');
    const member = userDb.createUser('strip-opencode-status', 'hash', 'user');
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'inherited-operator-openai';
    try {
      const status = await new OpenCodeProviderAuth().getStatus(member.id);
      assert.equal(status.authenticated, false);
      assert.notEqual(status.method, 'environment');
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe('B-1745: HOME-steered providers never inherit an operator XDG base dir', () => {
  const XDG = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
  const member = userDb.createUser('strip-xdg-member', 'hash', 'user');
  const withXdg = (): NodeJS.ProcessEnv => ({
    PATH: '/usr/bin', HOME: operatorHome,
    ...Object.fromEntries(XDG.map((name) => [name, path.join(operatorHome, `.${name.toLowerCase()}`)])),
  });
  for (const provider of ['agy', 'cursor', 'qwen']) {
    it(`${provider}: member and system actor envs carry no inherited XDG_*`, () => {
      for (const actor of [member.id, SYSTEM_ACTOR as never]) {
        const env = resolveProviderEnv(actor, provider, withXdg());
        for (const name of XDG) assert.equal(env[name], undefined, `${provider}: ${name}`);
      }
    });
  }
  it('opencode keeps the XDG dirs the resolver sets per member (not the inherited ones)', () => {
    const env = resolveProviderEnv(member.id, 'opencode', withXdg());
    for (const name of XDG) {
      assert.ok(String(env[name]).includes(path.join('.nassaj-users', String(member.id))), `${name}=${env[name]}`);
    }
  });
});
