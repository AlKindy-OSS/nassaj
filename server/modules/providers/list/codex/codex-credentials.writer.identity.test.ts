/**
 * T-1872 qa M1/M5: `codex login` executes exactly the identity its permit
 * carries. The gateway is mocked to hand a chosen handle; `current` is then
 * re-pointed so any re-acquisition would resolve a different executable.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { acquireCodexLaunchIdentity } from '@/shared/codex-executable.js';
import { createCodexMachineFixture, pointCurrent, writeCodexRelease } from '@/shared/tests/codex-release-fixture.js';

import { principal } from '../../tests/codex-credential-principal.fixture.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cred-identity-'));
const saved = { CODEX_HOME: process.env.CODEX_HOME, CODEX_PATH: process.env.CODEX_PATH };
process.env.CODEX_HOME = sandbox;
const machine = createCodexMachineFixture(path.join(sandbox, 'codex-machine'));
process.env.CODEX_PATH = machine.launcher;
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

let handle: Record<string, unknown> = {};
const trace: string[] = [];
mock.module('@/modules/execution-permissions/runtime-user-effect.js', { namedExports: {
  authorizeRuntimeUserProviderEffect: () => handle,
} });
const { CodexCredentialsWriter } = await import('./codex-credentials.writer.js');

/** A permit handle carrying `launchIdentity` (or only the gateway's acquisition error). */
function permit(launchIdentity: unknown, launchIdentityError: Error | null = null) {
  trace.length = 0;
  return {
    launchIdentity, launchIdentityError,
    consume: () => { trace.push('consume'); }, markStarted: () => { trace.push('started'); },
    attachChildIdentity: () => {}, settle: (outcome: string) => { trace.push(`settle:${outcome}`); },
    notStarted: () => { trace.push('not-started'); },
  };
}

function recordingSpawn() {
  const commands: string[] = [];
  const spawnFn = (command: string) => {
    commands.push(command);
    const child = Object.assign(new EventEmitter(), { stdin: { write: () => true, end: () => {} } });
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };
  return { spawnFn, commands };
}

test('login spawns the permit identity even after `current` moved', async () => {
  const admitted = acquireCodexLaunchIdentity();
  pointCurrent(machine.pkg, writeCodexRelease(machine.pkg, '0.157.0'));
  try {
    assert.notEqual(acquireCodexLaunchIdentity().executablePath, admitted.executablePath);
    handle = permit(admitted);
    const { spawnFn, commands } = recordingSpawn();
    await new CodexCredentialsWriter(spawnFn as never).setApiKey(1, 'sk-identity-test', undefined, principal);
    assert.deepEqual(commands, [admitted.executablePath]);
    assert.deepEqual(trace, ['consume', 'started', 'settle:succeeded']);
  } finally {
    pointCurrent(machine.pkg, machine.release);
  }
});

test('a release edited after admission refuses the login spawn', async () => {
  const admitted = acquireCodexLaunchIdentity();
  const manifest = path.join(machine.release, 'codex-package.json');
  const original = fs.readFileSync(manifest);
  handle = permit(admitted);
  const { spawnFn, commands } = recordingSpawn();
  fs.appendFileSync(manifest, ' ');
  try {
    await assert.rejects(new CodexCredentialsWriter(spawnFn as never).setApiKey(1, 'sk-x', undefined, principal));
  } finally { fs.writeFileSync(manifest, original); }
  assert.equal(commands.length, 0);
});

test('a permit without an identity refuses with its cause and never re-acquires', async () => {
  const cause = Object.assign(new Error('CODEX_MACHINE_CLI_MISSING'), { code: 'CODEX_MACHINE_CLI_MISSING' });
  handle = permit(null, cause);
  const { spawnFn, commands } = recordingSpawn();
  await assert.rejects(new CodexCredentialsWriter(spawnFn as never).setApiKey(1, 'sk-x', undefined, principal),
    (error: Error & { code?: string }) => error.code === 'CODEX_NOT_INSTALLED'
      && /Codex غير مثبّت على الجهاز/u.test(error.message));
  assert.equal(commands.length, 0);
  assert.deepEqual(trace, ['not-started']);
});
