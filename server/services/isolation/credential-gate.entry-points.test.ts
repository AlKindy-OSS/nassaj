/**
 * credential-gate.entry-points.test — ADR-152 amendment 1 §3.5 (T-2083, BE-12).
 *
 * The credential gate runs once per turn admission at every entry point except
 * PTY terminals. Each entry point has its own case here (or names the file that
 * holds it), with a member who has no credential and no grant (AT1): the turn is
 * refused with CREDENTIAL_NOT_LINKED and nothing is spawned.
 *
 *   chat WebSocket ............ chat-websocket.btw-visibility.test.ts (frame) + wiring below
 *   /btw ...................... chat-websocket.btw-visibility.test.ts + run-profile below
 *   session fork .............. chat-websocket.btw-visibility.test.ts
 *   REST /api/agent ........... below
 *   turn supervisor ........... below (Claude adapter; codex/extended/hosted wiring)
 *   workflow supervisor ....... below (resolveModelRunEnv wiring + behaviour)
 *   background tasks .......... workflow-supervisor/__tests__/launch-route.test.ts + run-profile below
 *   delegate_to_vendor ........ vendor-delegate-mcp.test.ts
 *   Codex App Server .......... below (/compact, slash-command RPCs, Codex /btw)
 *   git commit message ........ below (REST /api/git/generate-commit-message)
 *
 * Runner: node:test. Sandboxed $HOME + throwaway DB opened before any import.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-gate-entry-test-'));
const ORIGINAL = {
  HOME: process.env.HOME,
  DATABASE_PATH: process.env.DATABASE_PATH,
  NASSAJ_PROVIDER_SECRETS_KEY: process.env.NASSAJ_PROVIDER_SECRETS_KEY,
};
const operatorHome = path.join(sandbox, 'home');
fs.mkdirSync(operatorHome, { recursive: true });
process.env.HOME = operatorHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const { initializeDatabase, closeConnection, userDb } = await import('@/modules/database/index.js');
const { admitCredentialTurn, resolveModelRunEnv } = await import('./credential-gate.js');
const { userConfigDir } = await import('./provision-user-dirs.js');
const { _resetProviderSecretsServerKeyCache } = await import('./provider-secrets-store.js');
const { refuseUnlinkedAgentRun } = await import('@/routes/agent.js');
const { createClaudeSdkTurnAdapter } = await import('@/modules/turn-supervisor/adapters/claude-sdk-adapter.js');
const { startCodexCompaction, callCodexAppServer, spawnCodexSideQuery } = await import('@/services/codex-app-server.js');

await initializeDatabase();

after(() => {
  closeConnection();
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  _resetProviderSecretsServerKeyCache();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let seq = 0;
const ebtehal = () => userDb.createUser(`ebtehal-entry-${(seq += 1)}`, 'hash', 'user');

function linkClaude(userId: number): void {
  const dir = userConfigDir(userId, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x' } }));
}

describe('REST /api/agent', () => {
  it('a member with nothing linked gets the 409 body on every agent provider; a linked one passes', () => {
    const user = ebtehal();
    for (const [provider, uiProvider] of [['claude', 'claude'], ['codex', 'codex'], ['opencode', 'opencode'], ['glm', 'opencode']]) {
      const body = refuseUnlinkedAgentRun(user.id, provider, provider === 'glm' ? 'glm-4.6' : undefined, undefined);
      assert.ok(body, `${provider} was admitted`);
      assert.equal(body.code, 'CREDENTIAL_NOT_LINKED');
      assert.equal(body.credential.provider, uiProvider);
      assert.equal(body.credential.reason, 'not_linked');
      assert.deepEqual(body.credential.actions, ['link_own', 'request_share']);
    }
    linkClaude(user.id);
    assert.equal(refuseUnlinkedAgentRun(user.id, 'claude', undefined, undefined), null);
  });

  it('the refusal runs before clone, registration or writer (handler order)', () => {
    const source = read('server/routes/agent.js');
    const handler = source.slice(source.indexOf("router.post('/', agentLimiter"));
    const gate = handler.indexOf('refuseUnlinkedAgentRun(');
    assert.ok(gate > 0, 'the handler calls the gate');
    for (const later of ['validateWorkspacePath(', 'createProjectPath(', 'new SSEStreamWriter', 'queryClaudeSDK(']) {
      const at = handler.indexOf(later);
      if (at >= 0) assert.ok(gate < at, `the gate runs before ${later}`);
    }
  });
});

describe('turn supervisor', () => {
  it('Claude adapter: an unlinked member is refused and the SDK query is never constructed', async () => {
    const user = ebtehal();
    let queried = 0;
    const adapter = createClaudeSdkTurnAdapter({
      enabled: () => true,
      assertRunAllowed: () => undefined,
      queryFactory: (() => { queried += 1; return (async function* empty() {})(); }) as never,
    });
    await assert.rejects(
      adapter.invoke({ provider: 'claude', userId: user.id, persist: false, prompt: 'hi', model: 'sonnet' } as never),
      // The adapter wraps every failure; the gate's refusal is its cause.
      (error: { cause?: { code?: string } }) => error.cause?.code === 'CREDENTIAL_NOT_LINKED',
    );
    assert.equal(queried, 0);
  });

  it('codex, extended (qwen/opencode) and hosted (kimi/deepseek/glm) adapters build their env through the gate', () => {
    assert.match(read('server/modules/turn-supervisor/adapters/codex-cli-adapter.ts'), /resolveModelRunEnv\(userId, 'codex'/);
    assert.match(read('server/modules/turn-supervisor/adapters/extended-cli-adapter.ts'), /resolveModelRunEnv\(userId, provider/);
    const hosted = read('server/modules/turn-supervisor/hosted-turn-supervisor.service.ts');
    assert.match(hosted, /resolveModelRunEnv\(userId, provider/);
    assert.doesNotMatch(hosted, /resolveProviderEnv\(/);
  });
});

describe('workflow supervisor and background tasks', () => {
  it('the supervisor env resolver is the gated seam; an unlinked member is refused before any env', () => {
    assert.match(read('server/modules/workflow-supervisor/supervisor.ts'), /return resolveModelRunEnv\(userId, provider, baseEnv, 'agent'\)/);
    const user = ebtehal();
    assert.throws(() => resolveModelRunEnv(user.id, 'claude', { PATH: '/usr/bin' }, 'agent'), { code: 'CREDENTIAL_NOT_LINKED' });
    assert.equal(fs.existsSync(userConfigDir(user.id, '.claude')), false, 'nothing provisioned');
  });

  it('the background-task launch route and the handoff resume gate before writing or spawning', () => {
    const route = read('server/modules/workflow-supervisor/launch.route.ts');
    assert.ok(route.indexOf('admitCredentialTurn(') < route.indexOf('writeDurableTask({'), 'gate before the intent write');
    // The handoff resume (and /btw, chat, managed launches) go through the run
    // profile, which gates every non-PTY Claude run (resolve-claude-run-profile.test.ts).
    assert.match(read('server/services/isolation/resolve-claude-run-profile.js'), /assertCredentialLinked\(\{ actor, provider: 'claude'/);
  });
});

describe('chat WebSocket composition', () => {
  it('the composition root wires the real gate into the chat dependencies', () => {
    const index = read('server/index.js');
    assert.match(index, /import \{ admitCredentialTurn \} from '\.\/services\/isolation\/credential-gate\.js';/);
    assert.match(index, /\n\s+admitCredentialTurn,\n/);
  });

  it('the real admission refuses a Claude turn on an engine the member holds no key for', () => {
    const user = ebtehal();
    linkClaude(user.id);
    assert.equal(admitCredentialTurn({ actor: user.id, provider: 'claude' }).principalId, user.id);
    assert.throws(() => admitCredentialTurn({ actor: user.id, provider: 'claude', clientEngine: 'kimi' }),
      { code: 'CREDENTIAL_NOT_LINKED' });
  });
});

describe('PTY terminals are not gated (linking happens there)', () => {
  it('shell and standalone terminals still build the caller\'s own env without the gate', () => {
    for (const file of ['server/modules/websocket/services/shell-websocket.service.ts',
      'server/services/standalone-terminals/standalone-terminal-registry.ts']) {
      const source = read(file);
      assert.doesNotMatch(source, /credential-gate/, file);
      assert.match(source, /honorGrants: false/, file);
    }
  });
});

describe('Codex App Server (qa H2: /compact, slash-command RPCs, Codex /btw)', () => {
  const session = () => ({ provider: 'codex', project_id: 1, project_path: '/var/tmp' });

  it('/compact: an unlinked member is refused with CREDENTIAL_NOT_LINKED and the app server never spawns', async () => {
    const user = ebtehal();
    let spawned = 0;
    await assert.rejects(startCodexCompaction('gate-compact', user.id, {
      authorizeImpl: session, permissionExecution: null,
      spawnImpl: () => { spawned += 1; throw new Error('spawn reached'); },
    }), { code: 'CREDENTIAL_NOT_LINKED' });
    assert.equal(spawned, 0);
  });

  it('slash-command RPCs (/usage, /mcp, …): refused before the app server spawns', async () => {
    const user = ebtehal();
    let spawned = 0;
    await assert.rejects(callCodexAppServer('gate-rpc', user.id, 'account/rateLimits/read', {}, {
      authorizeImpl: session, permissionExecution: null,
      spawnImpl: () => { spawned += 1; throw new Error('spawn reached'); },
    }), { code: 'CREDENTIAL_NOT_LINKED' });
    assert.equal(spawned, 0);
  });

  it('every app-server spawn resolves its env through the gate by default', () => {
    const source = read('server/services/codex-app-server.js');
    assert.doesNotMatch(source, /options\.envResolver \|\| resolveProviderEnv/);
    assert.equal(source.match(/options\.envResolver \|\| codexModelRunEnv/g)?.length, 3);
    assert.equal(typeof spawnCodexSideQuery, 'function');
  });
});

describe('REST /api/git/generate-commit-message (qa H2 sweep)', () => {
  it('admits the Claude turn through the gate before any diff read or spawn', () => {
    const source = read('server/routes/git.js');
    const handler = source.slice(source.indexOf("router.post('/generate-commit-message'"));
    const gate = handler.indexOf('admitCredentialTurn(');
    assert.ok(gate > 0, 'the handler calls the gate');
    assert.ok(gate < handler.indexOf('getActualProjectPath('), 'before the project is resolved');
    assert.ok(gate < handler.indexOf('generateCommitMessageWithAI('), 'before the model run');
  });
});
