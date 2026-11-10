/**
 * T-2098 qa item 7 — the composite local pin `local:<server>:<owner>:<digest>` is
 * an internal value; every reader that hands an engine to a DTO, a user-facing
 * label or a failure ledger goes through ONE normalizer (`publicEngineValue`)
 * and sees `local`. The inventory pins down which production files read the
 * engine column, so a new reader cannot skip the normalizer unnoticed.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { resolveEffectiveEngine } from '../../../src/components/chat/view/subcomponents/engineGuard.js';

import { formatLocalEnginePin, publicEngineValue } from './local-engine-pin.js';

const ROOT = process.cwd();
const PIN = formatLocalEnginePin({ serverId: crypto.randomUUID(), ownerId: 7, origin: 'http://192.168.8.137:8080' });

test('publicEngineValue maps a local pin to `local` and leaves everything else alone', () => {
  assert.equal(publicEngineValue(PIN), 'local');
  assert.equal(publicEngineValue('local'), 'local');
  assert.equal(publicEngineValue('kimi'), 'kimi');
  assert.equal(publicEngineValue('anthropic'), 'anthropic');
  assert.equal(publicEngineValue(null), null);
  assert.equal(publicEngineValue(undefined), null);
});

test('the client engine resolver sees `local`, never the composite pin', () => {
  assert.equal(resolveEffectiveEngine(publicEngineValue(PIN), 'claude', 'gpt-oss-20b', {}), 'local');
});

test('the session agents view reports `local` for a local-pinned chat', async () => {
  const sandbox = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't2098-public-'));
  process.env.HOME = path.join(sandbox, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  process.env.DATABASE_PATH = path.join(sandbox, 'db.sqlite');
  const db = await import('@/modules/database/index.js');
  after(() => { db.closeConnection(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  await db.initializeDatabase();
  const { participantsService } = await import('@/modules/providers/index.js');
  const sessionId = crypto.randomUUID();
  db.getConnection().prepare(
    "INSERT INTO sessions (session_id, provider, project_path, jsonl_path, engine_provider, engine_provider_source) VALUES (?, 'claude', NULL, NULL, ?, 'server_verdict')",
  ).run(sessionId, PIN);
  const view = await participantsService.listSessionAgents(sessionId);
  assert.equal(view.engine, 'local');
});

/** Code lines (comments dropped) of a production file. */
function codeOf(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/u.test(line)).join('\n');
}

test('inventory: every production reader of the engine column is classified', () => {
  // internal = compares or re-writes the raw pin; dto = hands it outward and must normalize.
  const EXPECTED: Record<string, 'internal' | 'dto'> = {
    'server/modules/database/repositories/sessions.db.ts': 'internal',
    'server/modules/database/repositories/engine-restamp-authority.ts': 'internal',
    'server/modules/database/repositories/engine-restamp-settlement.db.ts': 'internal',
    'server/modules/database/schema.ts': 'internal',
    'server/modules/database/migrations.ts': 'internal',
    'server/modules/providers/services/engine-restamp-model-store.service.ts': 'internal',
    // T-2087 context guard: compares against the official engines only; a local pin is "not official".
    'server/modules/context-guard/index.ts': 'internal',
    'server/modules/providers/services/participants.service.ts': 'dto',
  };
  const files = fs.globSync('server/**/*.{ts,js}', { cwd: ROOT })
    .filter((file) => !file.includes('.test.') && !file.includes('test-harness'));
  const readers = files.filter((file) => /\bengine_provider\b/u.test(codeOf(file)));
  assert.deepEqual(readers.sort(), Object.keys(EXPECTED).sort());
  for (const [file, kind] of Object.entries(EXPECTED)) {
    if (kind === 'dto') assert.match(codeOf(file), /publicEngineValue\(/u, `${file} must normalize the pin`);
  }
});

test('inventory: user-facing engine labels and the failure ledger in the Claude body normalize the pin', () => {
  const code = codeOf('server/claude-sdk.js');
  const labels = [...code.matchAll(/engineProviderLabel\(([^)]*)\)/gu)].map((match) => match[1]);
  assert.ok(labels.length >= 2);
  for (const argument of labels) assert.match(argument, /^publicEngineValue\(/u, `engineProviderLabel(${argument})`);
  assert.match(code, /provider: publicEngineValue\(engagedEngine\)/u, 'provider_run_failures gets `local`');
  assert.match(code, /engineProvider: publicEngineValue\(effectiveEngineProvider\) \?\? OFFICIAL_ENGINE/u, 'audit metadata');
});
