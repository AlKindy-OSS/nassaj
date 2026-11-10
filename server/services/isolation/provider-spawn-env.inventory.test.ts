/**
 * provider-spawn-env.inventory.test — ADR-152 amendment 1 §3.4 / §3.5 (T-2083, BE-7).
 *
 * Every provider launch site builds its child env through resolveProviderEnv —
 * the one place that pre-strips inherited credentials, applies the member's own
 * tree and runs the final host-secret strip — and never hands raw `process.env`
 * (or a spread of it) to a child. Model-run sites additionally name a real
 * member through assertModelRunActor. Extends the Claude-only
 * claude-spawn-env.inventory.test.ts to every harness launcher.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');

type Site = { file: string; modelRun: boolean };

/** Every launcher of a provider child, relative to server/. */
const SITES: readonly Site[] = [
  { file: 'claude-sdk.js', modelRun: true },
  { file: 'openai-codex.js', modelRun: true },
  { file: 'cursor-cli.js', modelRun: true },
  { file: 'opencode-cli.js', modelRun: true },
  { file: 'qwen-cli.js', modelRun: true },
  { file: 'agy-cli.js', modelRun: true },
  { file: 'kimi-agent-cli.js', modelRun: true },
  { file: 'modules/providers/shared/vendor/vendor-runtime.js', modelRun: true },
  { file: 'modules/turn-supervisor/adapters/claude-sdk-adapter.ts', modelRun: true },
  { file: 'modules/turn-supervisor/adapters/codex-cli-adapter.ts', modelRun: true },
  { file: 'modules/turn-supervisor/adapters/extended-cli-adapter.ts', modelRun: true },
  { file: 'modules/turn-supervisor/hosted-turn-supervisor.service.ts', modelRun: true },
  // Terminals run the member's own login tree (honorGrants:false); the PTY entry
  // refuses a socket without an authenticated member before this point.
  { file: 'services/standalone-terminals/standalone-terminal-registry.ts', modelRun: false },
  { file: 'modules/websocket/services/shell-websocket.service.ts', modelRun: false },
];

/** A spawn option that forwards the server env unchecked. */
const RAW_ENV_OPTION = /\benv\s*:\s*(process\.env|\{\s*\.\.\.process\.env\s*\})\s*[,}]/;

/** Raw source: positive checks look for real calls (a comment naming one is rare). */
function source(rel: string): string {
  return fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
}

/** Source without line comments, for the negative raw-env check. */
function code(rel: string): string {
  return source(rel).split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line)).join('\n');
}

test('every provider launcher builds its child env through resolveProviderEnv or the gated seam', () => {
  for (const { file } of SITES) {
    assert.match(source(file), /\bresolveProviderEnv\(|\bresolveModelRunEnv\(|resolveEnvFn\(/,
      `${file} must resolve its child env through the seam`);
  }
});

test('no provider launcher hands raw process.env to a child', () => {
  for (const { file } of SITES) {
    assert.doesNotMatch(code(file), RAW_ENV_OPTION, `${file} spawns with raw process.env`);
  }
});

test('every model-run launcher names a real member (assertModelRunActor, or the gate that calls it)', () => {
  for (const { file, modelRun } of SITES) {
    if (!modelRun) continue;
    // resolveModelRunEnv (credential-gate.js) runs assertModelRunActor first.
    assert.match(source(file), /\bassertModelRunActor\(|\bresolveModelRunEnv\(/, `${file} must refuse a model run without a member`);
  }
});

test('ADR-152 A1 §3.5: the gated seam refuses a missing member before anything else', () => {
  const gate = source('services/isolation/credential-gate.js');
  const body = gate.slice(gate.indexOf('export function assertCredentialLinked'));
  assert.ok(body.indexOf('assertModelRunActor(actor)') >= 0 && body.indexOf('assertModelRunActor(actor)') < body.indexOf('predicate('),
    'the actor is checked before any predicate runs');
});
