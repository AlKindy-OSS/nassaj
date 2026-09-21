import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test, { mock } from 'node:test';

const startedIdentities: unknown[] = [];
const settlements: string[] = [];
const authorizations: Array<Record<string, unknown>> = [];
mock.module('@/modules/providers/index.js', {
  namedExports: { assertSessionAccessible: () => undefined },
});
mock.module('./resolve-claude-run-profile.js', {
  namedExports: {
    resolveClaudeRunProfileOrThrow: async () => ({
      env: { ANTHROPIC_API_KEY: 'broker-test-key', PATH: '/usr/bin' }, effectiveEngine: 'anthropic',
    }),
  },
});
mock.module('@/modules/execution-permissions/runtime-user-effect.js', {
  namedExports: {
    authorizeRuntimeUserProviderEffect: (input: Record<string, unknown>) => {
      authorizations.push(input);
      return {
        consume() {},
        markStarted(identity?: unknown) { startedIdentities.push(identity); },
        settle(outcome: string) { settlements.push(outcome); },
        notStarted() { settlements.push('not_started'); },
      };
    },
  },
});

// The broker records the wrapper's kernel identity via readRuntimeProcessIdentity.
// Default to a fabricated live identity; set identityMode='null' to exercise the
// path where the kernel identity of a started wrapper could not be read.
let identityMode: 'live' | 'null' = 'live';
mock.module('@/modules/execution-permissions/index.js', {
  namedExports: {
    readRuntimeProcessIdentity: (pid: number) =>
      identityMode === 'null' ? null : { pid, bootId: 'test-boot-id', startTicks: 'test-start-ticks' },
  },
});

const broker = await import('./managed-claude-launch-broker.js');

const actor = Object.freeze({
  id: 7, role: 'admin', status: 'active', authenticationKind: 'session', authorizationGeneration: 4,
});

function register() {
  return broker.registerManagedClaudeTerminal({
    authenticatedPrincipal: actor, userId: 7, mode: 'general', sessionId: null,
    cwd: process.cwd(), realBinary: '/bin/true', baseEnv: { PATH: '/usr/bin' },
  });
}

function envFor(registration: { selector: string; socketPath: string }): NodeJS.ProcessEnv {
  return {
    NASSAJ_MANAGED_CLAUDE_BROKER_SOCKET: registration.socketPath,
    NASSAJ_MANAGED_CLAUDE_BROKER_SELECTOR: registration.selector,
  };
}

test('broker rejects missing and foreign selectors without exposing the actor', async () => {
  const registration = register();
  broker.bindManagedClaudeTerminal(registration.selector, process.pid);
  assert.equal(Object.hasOwn(registration, 'authenticatedPrincipal'), false);
  assert.equal(Object.hasOwn(registration, 'authorizationGeneration'), false);
  await assert.rejects(
    broker.requestManagedClaudeBroker({ NASSAJ_MANAGED_CLAUDE_BROKER_SOCKET: registration.socketPath }, 'authorize', { argv: [] }),
    (error: Error & { code?: string }) => error.code === 'BROKER_CONTRACT_MISSING',
  );
  await assert.rejects(
    broker.requestManagedClaudeBroker({ ...envFor(registration), NASSAJ_MANAGED_CLAUDE_BROKER_SELECTOR: 'foreign-selector' }, 'authorize', { argv: [] }),
    (error: Error & { code?: string }) => error.code === 'BROKER_SELECTOR_UNKNOWN',
  );
  broker.revokeManagedClaudeTerminal(registration.selector);
});

test('broker binds authorization to the PTY identity and rejects a mismatched pid/start ticks', async () => {
  const registration = register();
  broker.bindManagedClaudeTerminal(registration.selector, process.pid);
  await assert.rejects(
    broker.requestManagedClaudeBroker(envFor(registration), 'authorize', { argv: [], pid: process.pid + 100_000 }),
    (error: Error & { code?: string }) => error.code === 'BROKER_PTY_IDENTITY_MISMATCH',
  );
  await assert.rejects(
    broker.requestManagedClaudeBroker(envFor(registration), 'authorize', { argv: [], startTicks: 'not-the-process-start' }),
    (error: Error & { code?: string }) => error.code === 'BROKER_PTY_IDENTITY_MISMATCH',
  );
  broker.revokeManagedClaudeTerminal(registration.selector);
});

test('broker expires a selector and fails closed after terminal revocation', async () => {
  const clock = mock.method(Date, 'now', () => 1_000_000);
  const registration = register();
  broker.bindManagedClaudeTerminal(registration.selector, process.pid);
  clock.mock.mockImplementation(() => 1_000_000 + 30 * 60_000 + 1);
  await assert.rejects(
    broker.requestManagedClaudeBroker(envFor(registration), 'authorize', { argv: [] }),
    (error: Error & { code?: string }) => error.code === 'BROKER_SELECTOR_EXPIRED',
  );
  clock.mock.restore();
  broker.revokeManagedClaudeTerminal(registration.selector);
  await assert.rejects(
    broker.requestManagedClaudeBroker(envFor(registration), 'authorize', { argv: [] }),
    (error: Error & { code?: string }) => error.code === 'BROKER_SELECTOR_UNKNOWN',
  );
});

test('separate terminal selectors remain isolated and a launch consumes only its own permit', async () => {
  const first = register();
  const second = register();
  broker.bindManagedClaudeTerminal(first.selector, process.pid);
  broker.bindManagedClaudeTerminal(second.selector, process.pid);
  const firstAuthorization = await broker.requestManagedClaudeBroker(envFor(first), 'authorize', { argv: [] });
  const secondAuthorization = await broker.requestManagedClaudeBroker(envFor(second), 'authorize', { argv: [] });
  assert.notEqual(firstAuthorization.launch, secondAuthorization.launch);
  assert.equal(Object.hasOwn(firstAuthorization.env as object, 'NASSAJ_MANAGED_CLAUDE_BROKER_SELECTOR'), false);
  assert.equal(Object.hasOwn(firstAuthorization.env as object, 'NASSAJ_MANAGED_CLAUDE_BROKER_SOCKET'), false);
  assert.equal((firstAuthorization.env as NodeJS.ProcessEnv).ANTHROPIC_API_KEY, 'broker-test-key');
  await broker.requestManagedClaudeBroker(envFor(first), 'start', { launch: firstAuthorization.launch });
  // B-1074: the broker records the wrapper's exact kernel identity so boot
  // reconciliation can prove its death without fencing 1:claude:spawn.
  assert.equal(startedIdentities.length, 1);
  const recorded = startedIdentities.at(-1) as { pid: number; bootId: string; startTicks: string };
  assert.equal(recorded.pid, process.pid);
  assert.equal(typeof recorded.startTicks, 'string');
  assert.equal(typeof recorded.bootId, 'string');
  await assert.rejects(
    broker.requestManagedClaudeBroker(envFor(second), 'start', { launch: firstAuthorization.launch }),
    (error: Error & { code?: string }) => error.code === 'BROKER_LAUNCH_INVALID',
  );
  await broker.requestManagedClaudeBroker(envFor(first), 'settle', { launch: firstAuthorization.launch, exitCode: 0 });
  broker.revokeManagedClaudeTerminal(first.selector);
  broker.revokeManagedClaudeTerminal(second.selector);
});

test('authorization uses only the server-held authenticated actor generation', async () => {
  authorizations.length = 0;
  const registration = register();
  broker.bindManagedClaudeTerminal(registration.selector, process.pid);
  await broker.requestManagedClaudeBroker(envFor(registration), 'authorize', { argv: [] });
  assert.equal(authorizations.length, 1);
  assert.deepEqual(authorizations[0]!.authenticatedPrincipal, actor);
  assert.equal(Object.isFrozen(authorizations[0]!.authenticatedPrincipal), true);
  assert.equal((authorizations[0]!.authenticatedPrincipal as { authorizationGeneration: number }).authorizationGeneration, 4);
  broker.revokeManagedClaudeTerminal(registration.selector);
});

async function resetBeforeReply(socketPath: string, request: Record<string, unknown>): Promise<void> {
  for (let attempt = 0; attempt < 50 && !fs.existsSync(socketPath); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // Send a request, then reset the socket so the server's reply write lands on a
  // peer that is already gone — the exact race that raised the unhandled EPIPE.
  await new Promise<void>((resolve, reject) => {
    const client = net.createConnection(socketPath);
    client.on('error', reject);
    client.on('connect', () => { client.end(JSON.stringify(request)); client.destroy(); resolve(); });
  });
  // Give the server time to run the handler and attempt the doomed write.
  await new Promise(resolve => setTimeout(resolve, 150));
}

test('a client that resets before a SUCCESS reply never crashes the broker', async () => {
  const registration = register();
  broker.bindManagedClaudeTerminal(registration.selector, process.pid);
  await resetBeforeReply(registration.socketPath, {
    action: 'authorize', selector: registration.selector, pid: process.pid, startTicks: null, argv: [],
  });
  // The process is still alive and the socket still serves legitimate traffic.
  const authorization = await broker.requestManagedClaudeBroker(envFor(registration), 'authorize', { argv: [] });
  assert.equal((authorization.env as NodeJS.ProcessEnv).ANTHROPIC_API_KEY, 'broker-test-key');
  broker.revokeManagedClaudeTerminal(registration.selector);
});

test('a client that resets before an ERROR reply never crashes the broker', async () => {
  const registration = register();
  broker.bindManagedClaudeTerminal(registration.selector, process.pid);
  // An unknown selector drives the catch branch (BROKER_SELECTOR_UNKNOWN reply).
  await resetBeforeReply(registration.socketPath, {
    action: 'authorize', selector: 'unknown-selector', pid: process.pid, startTicks: null, argv: [],
  });
  const authorization = await broker.requestManagedClaudeBroker(envFor(registration), 'authorize', { argv: [] });
  assert.equal((authorization.env as NodeJS.ProcessEnv).ANTHROPIC_API_KEY, 'broker-test-key');
  broker.revokeManagedClaudeTerminal(registration.selector);
});

test('broker socket is created only after a private directory is established', async () => {
  const registration = register();
  for (let attempt = 0; attempt < 50 && !fs.existsSync(registration.socketPath); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fs.statSync(registration.socketPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(registration.socketPath)).mode & 0o777, 0o700);
  broker.revokeManagedClaudeTerminal(registration.selector);
});

async function registerAndStart() {
  const registration = register();
  broker.bindManagedClaudeTerminal(registration.selector, process.pid);
  const authorization = await broker.requestManagedClaudeBroker(envFor(registration), 'authorize', { argv: [] });
  await broker.requestManagedClaudeBroker(envFor(registration), 'start', { launch: authorization.launch });
  return registration;
}

test('revoke with a dead wrapper settles failed and writes no fence', async () => {
  settlements.length = 0;
  const registration = await registerAndStart();
  const killed: number[] = [];
  const restore = broker.__setTerminateDepsForTest({
    childAlive: () => false, // Proven dead before any signal.
    kill: (pid: number) => { killed.push(pid); },
  });
  broker.revokeManagedClaudeTerminal(registration.selector);
  await broker.__whenTerminationSettledForTest();
  restore();
  assert.deepEqual(settlements, ['failed']);
  assert.equal(killed.length, 0); // A proven-dead wrapper is never signalled.
});

test('revoke with an immortal wrapper settles reconciled_unknown after the kill window', async () => {
  settlements.length = 0;
  const registration = await registerAndStart();
  const signals: string[] = [];
  let clock = 0;
  const restore = broker.__setTerminateDepsForTest({
    childAlive: () => true, // Survives every probe.
    kill: (_pid: number, signal: NodeJS.Signals | number) => { signals.push(String(signal)); },
    now: () => { clock += 2_000; return clock; },
    delay: () => Promise.resolve(),
  });
  broker.revokeManagedClaudeTerminal(registration.selector);
  await broker.__whenTerminationSettledForTest();
  restore();
  assert.deepEqual(settlements, ['reconciled_unknown']);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); // Escalated, then gave up honestly.
});

test('revoke of a started launch whose wrapper identity was unreadable settles reconciled_unknown and signals nothing', async () => {
  settlements.length = 0;
  identityMode = 'null'; // start() records started=true with a null kernel identity.
  const killed: number[] = [];
  try {
    const registration = await registerAndStart();
    const restore = broker.__setTerminateDepsForTest({
      childAlive: () => true, // Must never be consulted: with no identity there is nothing to probe.
      kill: (pid: number) => { killed.push(pid); },
    });
    broker.revokeManagedClaudeTerminal(registration.selector);
    await broker.__whenTerminationSettledForTest();
    restore();
  } finally {
    identityMode = 'live';
  }
  assert.deepEqual(settlements, ['reconciled_unknown']); // Lease settled, never left open.
  assert.equal(killed.length, 0); // No identity means no signal is ever sent.
});

// B-1074 records the wrapper's identity so a proven-dead wrapper avoids the fence,
// but it cannot help a wrapper the server is not permitted to signal: a kill that
// throws EPERM leaves the wrapper alive, so the window expires to reconciled_unknown.
test('revoke settles reconciled_unknown when the wrapper cannot be signalled (kill throws EPERM)', async () => {
  settlements.length = 0;
  const registration = await registerAndStart();
  const signals: string[] = [];
  let clock = 0;
  const restore = broker.__setTerminateDepsForTest({
    childAlive: () => true, // The wrapper stays alive because it is never actually signalled.
    kill: (_pid: number, signal: NodeJS.Signals | number) => {
      signals.push(String(signal));
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    },
    now: () => { clock += 2_000; return clock; },
    delay: () => Promise.resolve(),
  });
  broker.revokeManagedClaudeTerminal(registration.selector);
  await broker.__whenTerminationSettledForTest();
  restore();
  assert.deepEqual(settlements, ['reconciled_unknown']);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); // Both attempts threw EPERM and changed nothing.
});
