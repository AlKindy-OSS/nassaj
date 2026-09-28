/**
 * codex-machine-launch.test.ts — T-1872 launch-seam proof.
 *
 * child_process is mocked at MODULE level (before the SDK and the resolver are
 * imported), so the assertions observe the argv the real @openai/codex-sdk hands
 * to spawn: the executed file is the frozen machine identity, never the
 * SDK-bundled npm copy and never a PATH `codex`. A static guard then rejects
 * every source pattern that could re-introduce another Codex binary.
 */
import assert from 'node:assert/strict';
import * as realChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCodexMachineFixture, pointCurrent, writeCodexRelease } from './tests/codex-release-fixture.js';

type SpawnCall = { command: string; args: string[]; env: NodeJS.ProcessEnv };
const spawnCalls: SpawnCall[] = [];
const versionCalls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];

/** A child that answers one Codex exec turn with a minimal JSONL stream. */
function fakeCodexChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    kill() { child.killed = true; return true; },
  });
  setImmediate(() => {
    child.stdout.end(`${JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' })}\n`
      + `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })}\n`);
    child.stdout.on('end', () => setImmediate(() => child.emit('exit', 0, null)));
  });
  return child;
}

const childProcessMock = {
  // Everything else stays real so unrelated modules (resolveProviderEnv's graph) load.
  ...realChildProcess,
  spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    spawnCalls.push({ command, args, env: options.env });
    return fakeCodexChild();
  },
  execFileSync: (file: string, args: string[], options: Record<string, unknown>) => {
    versionCalls.push({ file, args, options });
    return 'codex-cli 0.156.0\n';
  },
};
// One mock covers both specifiers: the SDK imports bare 'child_process'.
mock.module('node:child_process', { namedExports: childProcessMock });

const { Codex } = await import('@openai/codex-sdk');
const {
  acquireCodexLaunchIdentity, assertCodexIdentityUnchanged, codexLaunchOptions,
} = await import('./codex-executable.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-machine-launch-'));
const machine = createCodexMachineFixture(root);
const savedCodexPath = process.env.CODEX_PATH;
process.env.CODEX_PATH = machine.launcher;
after(() => {
  if (savedCodexPath === undefined) delete process.env.CODEX_PATH; else process.env.CODEX_PATH = savedCodexPath;
  fs.rmSync(root, { recursive: true, force: true });
});

/** The file a (possibly bwrap-caged) launch finally executes. */
const executedFile = (call: SpawnCall): string => (
  path.basename(call.command) === 'bwrap' ? call.args[call.args.indexOf('--') + 1]! : call.command
);

async function runSdkTurn(identity: ReturnType<typeof acquireCodexLaunchIdentity>): Promise<SpawnCall> {
  const before = spawnCalls.length;
  const codex = new Codex(codexLaunchOptions({ PATH: '/usr/bin', HOME: root }, identity));
  const thread = codex.startThread({ skipGitRepoCheck: true });
  assertCodexIdentityUnchanged(identity);
  const { events } = await thread.runStreamed('hello');
  for await (const _event of events) { /* drain */ }
  assert.equal(spawnCalls.length, before + 1, 'exactly one SDK spawn');
  return spawnCalls.at(-1)!;
}

test('the version probe is a fixed, shell-less, env-less argv on the release realpath', () => {
  versionCalls.length = 0;
  const identity = acquireCodexLaunchIdentity();
  assert.equal(versionCalls.length, 1);
  assert.equal(versionCalls[0]!.file, identity.executablePath);
  assert.deepEqual(versionCalls[0]!.args, ['--version']);
  assert.equal(versionCalls[0]!.options.shell, false);
  assert.deepEqual(versionCalls[0]!.options.env, {});
  // qa M2: unchanged native bytes + inode reuse the probed version (no child per launch).
  acquireCodexLaunchIdentity();
  assert.equal(versionCalls.length, 1);
  // A new binary inode is probed again.
  const binary = identity.executablePath;
  const bytes = fs.readFileSync(binary);
  fs.rmSync(binary);
  fs.writeFileSync(binary, bytes, { mode: 0o755 });
  const again = acquireCodexLaunchIdentity();
  assert.equal(versionCalls.length, 2);
  assert.equal(versionCalls[1]!.file, again.executablePath);
});

test('the SDK internal spawn carries codexPathOverride === identity.executablePath', async () => {
  const identity = acquireCodexLaunchIdentity();
  const options = codexLaunchOptions({ PATH: '/usr/bin' }, identity);
  assert.equal(options.codexPathOverride, identity.executablePath);
  const call = await runSdkTurn(identity);
  assert.equal(executedFile(call), identity.executablePath);
  assert.equal(call.args[0], 'exec');
  assert.ok(String(call.env.PATH).startsWith(identity.pathDirs[0]!));
  assert.ok(!executedFile(call).includes('node_modules'), 'never the SDK-bundled binary');
});

test('a caged launch is judged by the argv after bwrap `--`', () => {
  const identity = acquireCodexLaunchIdentity();
  const caged = { command: '/opt/bwrap', args: ['--die-with-parent', '--', identity.executablePath, 'exec'], env: {} };
  assert.equal(executedFile(caged), identity.executablePath);
});

test('swapping current between measure and launch leaves the executed file unchanged', async () => {
  const identity = acquireCodexLaunchIdentity();
  const next = writeCodexRelease(machine.pkg, '0.157.0');
  pointCurrent(machine.pkg, next);
  try {
    const call = await runSdkTurn(identity);
    assert.equal(executedFile(call), path.join(fs.realpathSync(machine.release), 'bin', 'codex'));
  } finally { pointCurrent(machine.pkg, machine.release); }
});

test('a release file modified after measurement refuses with CODEX_RUNTIME_CHANGED', async () => {
  const identity = acquireCodexLaunchIdentity();
  const rg = path.join(machine.release, 'codex-path', 'rg');
  const original = fs.readFileSync(rg);
  fs.appendFileSync(rg, 'tampered');
  const before = spawnCalls.length;
  try {
    await assert.rejects(runSdkTurn(identity), { code: 'CODEX_RUNTIME_CHANGED' });
    assert.equal(spawnCalls.length, before, 'nothing spawned');
  } finally { fs.writeFileSync(rg, original); }
});

test('A6: a member env carrying CODEX_PATH=/evil (via resolveProviderEnv) is ignored', async () => {
  const { resolveProviderEnv } = await import('@/services/isolation/resolve-provider-env.js');
  const memberEnv = resolveProviderEnv(null, 'codex', { ...process.env, CODEX_PATH: '/evil' });
  assert.equal(memberEnv.CODEX_PATH, '/evil', 'the member env really carries the override');
  const identity = acquireCodexLaunchIdentity();
  assert.equal(identity.releaseRoot, fs.realpathSync(machine.release));
  const call = await runSdkTurn(identity);
  assert.equal(executedFile(call), identity.executablePath);
  assert.notEqual(executedFile(call), '/evil');
});

// ---------------------------------------------------------------------------
// Static guard: no other Codex binary can come back through source.
// ---------------------------------------------------------------------------
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAGE_BWRAP = 'services/isolation/provider-cage.js';
const RESOLVER = 'shared/codex-executable.js';
// Out of scope for T-1872 part 1 (owned by the parallel harness-update work).
const HARNESS_UPDATE = 'modules/providers/harness-update/';

function productionSources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return ['node_modules', 'tests', '__tests__'].includes(entry.name) ? [] : productionSources(absolute);
    return /\.(?:[cm]?js|ts)$/u.test(entry.name) && !/\.(?:test|spec)\./u.test(entry.name) ? [absolute] : [];
  });
}

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp, readonly string[]]> = [
  ['SDK entry resolved for a binary path', /import\.meta\.resolve\(\s*['"]@openai\/codex-sdk['"]\s*\)/u, [RESOLVER]],
  ['bundled @openai/codex package resolution', /['"`]@openai\/(?:codex\/package\.json|codex-\$\{|\$\{base\})/u, [CAGE_BWRAP]],
  ['literal codex spawn command', /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(\s*['"`]codex['"`\s]/u, []],
  ['PATH-resolved codex', /resolveCliExecutablePath\(\s*['"]codex['"]\s*\)/u, []],
  ['literal codex default binary', /DEFAULT_CODEX_BINARY|binary\s*\?\?\s*['"]codex['"]/u, []],
  ['shell command starting with a bare codex word', /return\s+[`'"]codex(?:\s|[`'"])/u, []],
];

test('static guard: no source re-introduces a non-machine Codex binary', () => {
  const offenders: string[] = [];
  for (const file of productionSources(SERVER_ROOT)) {
    const relative = path.relative(SERVER_ROOT, file).split(path.sep).join('/');
    if (relative.startsWith(HARNESS_UPDATE)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const [label, pattern, allowed] of FORBIDDEN) {
      if (pattern.test(source) && !allowed.includes(relative)) offenders.push(`${relative}: ${label}`);
    }
  }
  assert.deepEqual(offenders, []);
  // The one allowed SDK-entry resolution is the source digest, not a binary locator.
  const resolver = fs.readFileSync(path.join(SERVER_ROOT, RESOLVER), 'utf8');
  assert.equal(resolver.match(/import\.meta\.resolve\(/gu)?.length, 1);
  assert.match(resolver, /export const resolveCodexSdkSourceEntry = \(\) => fileURLToPath\(import\.meta\.resolve\('@openai\/codex-sdk'\)\)/u);
});

test('static guard itself rejects each forbidden pattern', () => {
  const samples = [
    "const entry = import.meta.resolve('@openai/codex-sdk');",
    "require.resolve('@openai/codex/package.json')",
    "spawn('codex', ['exec'])",
    "resolveCliExecutablePath('codex')",
    "const DEFAULT_CODEX_BINARY = 'codex';",
    "return 'codex';",
  ];
  samples.forEach((sample, index) => assert.ok(FORBIDDEN[index]![1].test(sample), FORBIDDEN[index]![0]));
});
