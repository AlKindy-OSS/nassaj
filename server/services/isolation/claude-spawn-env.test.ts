/**
 * claude-spawn-env.test — ADR-226 H3: one function, claudeSpawnEnvFor, builds Claude's env for
 * the Claude spawn and for every harness that mirrors Claude's policy, with credential grants
 * honoured; it throws exactly where Claude's spawn throws.
 */
// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
type Row = Record<string, any>;
let mod: Row;

describe('ADR-226 claudeSpawnEnvFor', () => {
  before(async () => {
    const db = await import('@/modules/database/index.js');
    await db.initializeDatabase();
    db.getConnection().prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(31, 'spawn-env-31', 'x');
    mod = { ...(await import('./claude-spawn-env.js')), ...(await import('./resolve-provider-env.js')) };
  });

  it('equals the resolver\'s Claude env with grants honoured (what the Claude spawn used before)', () => {
    const base = { PATH: '/usr/bin:/bin', HOME: process.env.HOME };
    const env = mod.claudeSpawnEnvFor(31, base);
    assert.deepEqual(env, mod.resolveProviderEnv(31, 'claude', base));
    assert.ok(env.CLAUDE_CONFIG_DIR.endsWith(path.join('31', '.claude')), env.CLAUDE_CONFIG_DIR);
  });

  it('throws where Claude\'s spawn throws: no member', () => {
    assert.throws(() => mod.claudeSpawnEnvFor(null, {}));
  });

  it('is the one call behind the Claude spawn, the engine and dsh', () => {
    const read = (rel: string) => fs.readFileSync(path.join(SERVER, rel), 'utf8');
    assert.match(read('claude-sdk.js'), /sdkOptions\.env = claudeSpawnEnvFor\(assertModelRunActor\(ws\?\.userId\), sdkOptions\.env\)/);
    assert.match(read('services/permission-parity/claude-parity-engine.js'), /claudeSpawnEnvFor\(userId, process\.env\)/);
    assert.match(read('modules/providers/list/dsh/dsh-permission-parity.js'), /claudeSpawnEnvFor\(userId, process\.env\)/);
    for (const rel of ['services/permission-parity/claude-parity-engine.js', 'modules/providers/list/dsh/dsh-permission-parity.js']) {
      assert.doesNotMatch(read(rel), /honorGrants:\s*false/, `${rel}: no grant-blind Claude env`);
    }
  });
});
