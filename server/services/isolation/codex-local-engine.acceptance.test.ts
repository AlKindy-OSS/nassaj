/**
 * ADR-227 "Codex and DSH bodies" / T-2107 — acceptance in the owner's terms: "with
 * the Codex local switch on and my own local server registered, a Codex chat on a
 * local model writes and reads a file, and the local server never receives any
 * ChatGPT/OpenAI credential; with the switch off, nothing changes for Codex".
 *
 * Real database, real local-model rows, real codex-local-run.js; no mocks. The
 * refusal rules are the shared ADR-227 rules. The write-then-read turn runs on a
 * REAL local server and the real installed CLI only when NASSAJ_TEST_LOCAL_SERVER_URL
 * (`http://<private literal>:<port>/v1`), NASSAJ_TEST_LOCAL_MODEL and optionally
 * NASSAJ_TEST_LOCAL_SERVER_KEY are set and the server answers; it is skipped
 * otherwise (the permanent no-leak proof is codex-local-engine.header-echo.test.ts).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-codex-local-acceptance-'));
const ORIGINAL = { ...process.env };
const REAL = {
  url: process.env.NASSAJ_TEST_LOCAL_SERVER_URL ?? '',
  model: process.env.NASSAJ_TEST_LOCAL_MODEL ?? '',
  key: process.env.NASSAJ_TEST_LOCAL_SERVER_KEY ?? '',
  window: Number(process.env.NASSAJ_TEST_LOCAL_CONTEXT ?? 32768),
};
process.env.HOME = path.join(sandbox, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const database = await import('@/modules/database/index.js');
const { _resetProviderSecretsServerKeyCache, setLocalModelSecret } = await import('./provider-secrets-store.js');
const { codexLocalPathOrThrow, resolveCodexLocalRunOrThrow } = await import('./codex-local-run.js');
const { userConfigDir } = await import('./provision-user-dirs.js');

await database.initializeDatabase();
_resetProviderSecretsServerKeyCache();
database.appConfigDb.set('local_models.enabled', 'true');
database.appConfigDb.set('local_models.consent_version', '1');
database.appConfigDb.set('local_models.codex_enabled', 'true');

after(() => {
  database.closeConnection();
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL)) delete process.env[key];
  Object.assign(process.env, ORIGINAL);
  _resetProviderSecretsServerKeyCache();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const owner = database.userDb.createUser('codex-local-acc-owner', 'hash', 'user');
const stranger = database.userDb.createUser('codex-local-acc-stranger', 'hash', 'user');

type Model = { id: string; contextWindow?: number };
function registerServer(ownerId: number, baseUrl: string, models: Model[], apiKey?: string) {
  const id = crypto.randomUUID();
  const server = { id, ownerId, providerId: `nassaj_local_${id.replaceAll('-', '')}`, name: 'box', baseUrl, runtime: 'llamacpp', models };
  database.localModelServersDb.save(server);
  database.localModelServersDb.setVerifiedAddresses(server, [new URL(baseUrl).hostname]);
  if (apiKey) setLocalModelSecret(ownerId, id, apiKey);
  return server;
}

const mine = registerServer(owner.id, 'http://127.0.0.1:18080/v1', [
  { id: 'fits', contextWindow: 32768 }, { id: 'small', contextWindow: 16384 }, { id: 'unknown' },
]);
const theirs = registerServer(stranger.id, 'http://127.0.0.1:18081/v1', [{ id: 'fits', contextWindow: 32768 }]);
const publicServer = registerServer(owner.id, 'http://8.8.8.8:8080/v1', [{ id: 'fits', contextWindow: 32768 }]);
const modelOf = (server: { providerId: string }, id: string): string => `${server.providerId}/${id}`;

/** Both steps of the production launch for a NEW chat by `userId`. */
async function launch(userId: number, requestedModel: string, cliVersion = '0.166.0', codexBin = 'codex', cwd = sandbox) {
  const localPath = codexLocalPathOrThrow({ sessionId: null, requestedModel });
  assert.ok(localPath, 'a local model takes the local path');
  return resolveCodexLocalRunOrThrow({ userId, storedEngine: localPath.storedEngine, requestedModel, cliVersion, codexBin, cwd });
}

const refusedWith = (reason: string) => (error: Error & { code?: string; reason?: string }) =>
  error.code === 'ENGINE_PROVIDER_UNAVAILABLE' && error.reason === reason;

describe('Codex chat on my local model server (T-2107)', () => {
  it('my own server runs it, on its literal, with a credential-free home', async () => {
    const run = await launch(owner.id, modelOf(mine, 'fits'));
    assert.equal(run.config['model_providers.nassaj_local.base_url'], 'http://127.0.0.1:18080/v1');
    assert.equal(run.local.model, 'fits');
    assert.equal(fs.existsSync(path.join(run.env.CODEX_HOME as string, 'auth.json')), false);
    assert.equal(path.dirname(run.env.CODEX_HOME as string), path.dirname(userConfigDir(owner.id, '.codex')));
  });

  it('refuses another member\'s server, a public address, an unknown or too small window', async () => {
    await assert.rejects(launch(owner.id, modelOf(theirs, 'fits')), refusedWith('server_not_found'));
    await assert.rejects(launch(owner.id, modelOf(publicServer, 'fits')), refusedWith('address_not_private'));
    await assert.rejects(launch(owner.id, modelOf(mine, 'unknown')), refusedWith('context_unknown'));
    await assert.rejects(launch(owner.id, modelOf(mine, 'small')), refusedWith('context_too_small'));
  });

  it('refuses a CLI version that has not passed the credential proof', async () => {
    await assert.rejects(launch(owner.id, modelOf(mine, 'fits'), '0.1.0'), refusedWith('cli_version_unproven'));
  });

  it('switch off: refused with no fallback; a cloud model never takes the local path', async () => {
    database.appConfigDb.set('local_models.codex_enabled', 'false');
    try {
      await assert.rejects(launch(owner.id, modelOf(mine, 'fits')), refusedWith('feature_disabled'));
    } finally {
      database.appConfigDb.set('local_models.codex_enabled', 'true');
    }
    assert.equal(codexLocalPathOrThrow({ sessionId: null, requestedModel: 'gpt-5.5' }), null);
  });
});

/** True when the configured real server answers its model list. */
function realServerReachable(): boolean {
  if (!REAL.url || !REAL.model) return false;
  const headers = REAL.key ? ['-H', `Authorization: Bearer ${REAL.key}`] : [];
  return spawnSync('curl', ['-sf', '-m', '5', ...headers, `${REAL.url.replace(/\/+$/u, '')}/models`], { timeout: 10_000 }).status === 0;
}

const CODEX_BIN = (process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, 'codex')).find((file) => fs.existsSync(file));
const CODEX_VERSION = CODEX_BIN
  ? /(\d+\.\d+\.\d+)/u.exec(spawnSync(CODEX_BIN, ['--version'], { encoding: 'utf8' }).stdout ?? '')?.[1] ?? null : null;
const REAL_SKIP = !realServerReachable() ? 'no reachable NASSAJ_TEST_LOCAL_SERVER_URL' : (!CODEX_VERSION ? 'codex CLI not installed' : false);

/** The member tree the spawn links: a role, a skill and an allow-and-mark PreToolUse hook. */
function seedMemberTree(marker: string): void {
  const home = userConfigDir(owner.id, '.codex');
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'agents', 'researcher.toml'), 'name = "researcher"\ndescription = "r"\ndeveloper_instructions = "Research only."\n');
  fs.mkdirSync(path.join(home, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\nDemo.\n');
  if (!fs.existsSync(path.join(home, 'AGENTS.md'))) fs.writeFileSync(path.join(home, 'AGENTS.md'), '# governance\n');
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
    { type: 'command', command: `touch ${JSON.stringify(marker)}; exit 0 # nassaj-service-gate`, timeout: 10 },
  ] }] } }));
}

it('a Codex chat on my real local model writes a file and reads it back', { skip: REAL_SKIP, timeout: 300_000 }, async () => {
  const { Codex } = await import('@openai/codex-sdk');
  const { codexMultiAgentConfig, codexTurnDeveloperInstructions, composeCodexLaunchConfig } = await import('@/modules/providers/index.js');
  // eslint-disable-next-line boundaries/no-unknown
  const { getRuntimeInstructions } = await import('@/services/runtime-instructions.js');
  const marker = path.join(sandbox, 'hook-fired');
  seedMemberTree(marker);
  const server = registerServer(owner.id, REAL.url, [{ id: REAL.model, contextWindow: REAL.window }], REAL.key || undefined);
  const cwd = fs.mkdtempSync(path.join(sandbox, 'chat-'));
  const codexBin = fs.realpathSync(CODEX_BIN as string);
  const run = await launch(owner.id, modelOf(server, REAL.model), CODEX_VERSION as string, codexBin, cwd);
  // T-2107 qa high 4: the exact config the spawn chokepoint composes.
  const config = composeCodexLaunchConfig({
    multiAgentConfig: codexMultiAgentConfig(null, true),
    developerInstructions: codexTurnDeveloperInstructions('delegate', { helpers: true, reason: null, cpu: null }, getRuntimeInstructions),
    sandboxMode: 'workspace-write', docsWritableRoots: [], localConfig: run.config,
  });
  const codex = new Codex({ codexPathOverride: codexBin, env: run.env as Record<string, string>, config: config as NonNullable<ConstructorParameters<typeof Codex>[0]>['config'] });
  const thread = codex.startThread({
    model: run.local.model, workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: 'workspace-write', approvalPolicy: 'never',
  });
  const turn = await thread.run('Create a file named hello.txt in the current directory containing exactly the word: مرحبا . '
    + 'Then read the file back with a shell command and reply with its exact contents.');
  assert.equal(fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8').trim(), 'مرحبا');
  assert.match(turn.finalResponse, /مرحبا/u);
  assert.ok(fs.existsSync(marker), 'my PreToolUse hook ran in the local chat');
});
