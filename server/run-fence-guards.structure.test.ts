/**
 * T-1854 (qa H1b): every provider launcher reads `runFenceRevoked` at its last
 * pre-spawn point — no `await` may sit between that guard and the spawn/fetch,
 * or a revocation could land in between. The four H1 providers are also swept
 * dynamically (agy/hermes/qwen/vendor *.run-fence.test.ts); this structural
 * check keeps cursor, opencode and kimi-agent consistent with them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SERVER_ROOT = import.meta.dirname;

const LAUNCHERS: Array<[file: string, spawnMarker: string]> = [
  ['agy-cli.js', 'agProcess = spawn(agyLaunch.cmd'],
  ['hermes-cli.js', 'hermesProcess = spawnFunction(hermesLaunch.cmd'],
  ['qwen-cli.js', 'child = spawnFunction(launch.cmd'],
  ['modules/providers/shared/vendor/vendor-runtime.js', 'await fetch(config.messagesUrl'],
  ['cursor-cli.js', "runCursorProcess(baseArgs, 'initial')"],
  ['opencode-cli.js', 'opencodeProcess = spawnFunction(opencodeLaunch.cmd'],
  ['kimi-agent-cli.js', 'kimiProcess = spawn(launch.cmd'],
];

for (const [file, spawnMarker] of LAUNCHERS) {
  test(`qa H1b ${file}: the fence guard is the last check before spawn, with no await after it`, () => {
    const source = fs.readFileSync(path.join(SERVER_ROOT, file), 'utf8');
    const spawn = source.indexOf(spawnMarker);
    // The guard nearest to the spawn is the one that must not be followed by an await.
    const guard = source.lastIndexOf('if (ws?.runFenceRevoked)', spawn);
    assert.notEqual(guard, -1, 'guard present');
    assert.notEqual(spawn, -1, 'spawn marker present');
    assert.ok(guard < spawn, 'guard precedes the spawn');
    assert.doesNotMatch(source.slice(guard, spawn), /\bawait\b|\.then\(/, 'no await between guard and spawn');
  });
}

const TRANSCRIPT_WRITES: Array<[file: string, writeMarker: string]> = [
  ['qwen-cli.js', "await writeVendorTranscriptMeta('qwen'"],
  ['qwen-cli.js', "await appendVendorTranscriptTurn('qwen', sessionId, workingDir, 'user'"],
  ['modules/providers/shared/vendor/vendor-runtime.js', 'await writeTranscriptMeta(provider'],
  ['modules/providers/shared/vendor/vendor-runtime.js', 'await appendTranscript(provider, effectiveSessionId'],
];

for (const [file, writeMarker] of TRANSCRIPT_WRITES) {
  test(`qa #5 ${file}: a fence guard precedes the pre-spawn transcript write with no await between`, () => {
    const source = fs.readFileSync(path.join(SERVER_ROOT, file), 'utf8');
    const write = source.indexOf(writeMarker);
    assert.notEqual(write, -1, 'write marker present');
    const guard = source.lastIndexOf('if (ws?.runFenceRevoked)', write);
    assert.notEqual(guard, -1, 'guard present');
    const between = source.slice(source.indexOf('\n', guard), write);
    assert.doesNotMatch(between, /\bawait\b|\.then\(/, 'no await between guard and write');
  });
}

test('qa M2: both replay buffers skip a revoked fence', () => {
  const claude = fs.readFileSync(path.join(SERVER_ROOT, 'claude-sdk.js'), 'utf8');
  assert.match(claude, /sessionKey && ws\?\.runFenceRevoked !== true\s*\?\s*claudeSessionRegistry\.record/);
  const agy = fs.readFileSync(path.join(SERVER_ROOT, 'agy-cli.js'), 'utf8');
  assert.match(agy, /if \(ws\?\.runFenceRevoked !== true\) agySessionRegistry\.record\(registryKey, normalized\)/);
});
