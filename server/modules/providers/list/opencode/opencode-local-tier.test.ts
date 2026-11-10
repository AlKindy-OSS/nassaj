/**
 * opencode-local-tier.test — ADR-LOCAL-INSTR-TIER-001 (S4), the per-user local
 * config dir a local-model OpenCode turn runs under.
 *
 * Proves, in a hermetic HOME with fixture instruction files:
 *  - the dir is ~/.nassaj-users/<id>/.config-local/opencode, a real 0700 dir;
 *  - its AGENTS.md is a verified copy of ~/.claude/AGENTS.local.md, and a tampered
 *    copy is repaired (sha256 gate with a source/filename option);
 *  - a missing slim source, or the full file in its place, refuses with the NEW
 *    `local_instructions_unavailable` code — never a fallback to the full file (I6/I7);
 *  - the full gate rejects a tier-tagged file (I6);
 *  - opencode.json carries the task allow-list and the MCP overlay of the user's
 *    ordinary config (I5), command/ is linked, agent/ holds generated cards (C2);
 *  - the governance badge checks the local dir when asked for the local tier (I5);
 *  - the MCP writer also materializes the local dir (I5).
 */
import { sandboxHome } from '../../tests/helpers/hermetic-sandbox.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import { localFixture, withRev } from '@/shared/tests/instruction-rev-fixture.js';

process.env.NASSAJ_OPENCODE_MCP_ENABLED = '1';
const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
const { prepareOpenCodeLocalTier } = await import('./opencode-local-tier.js');
const { ensureOpenCodeGovernance, resolveOpenCodeLocalConfigHomeForUser } = await import('./opencode-governance.js');
const { localTaskPermission, LOCAL_TASK_AGENTS } = await import('@/services/isolation/opencode-local-tier-material.js');
const { materializeOpenCodeConfig } = await import('@/services/isolation/opencode-config-material.js');
const { providerGovernanceService } = await import('@/modules/providers/services/provider-governance.service.js');
const { OpenCodeMcpProvider } = await import('./opencode-mcp.provider.js');

await initializeDatabase();
after(() => closeConnection());

const USER = 7;
const claudeDir = path.join(sandboxHome, '.claude');
const LOCAL_SOURCE = path.join(claudeDir, 'AGENTS.local.md');
const FULL_SOURCE = path.join(claudeDir, 'AGENTS.md');
const LOCAL_TEXT = localFixture('compact local rules\n');
const FULL_TEXT = withRev('# full rules\n', null);
// nassaj-core/opencode/agent through ~/.claude (present on every node), not ~/.config.
const sharedAgentDir = path.join(sandboxHome, '.claude', 'opencode', 'agent');
const sharedCommandDir = path.join(sandboxHome, '.config', 'opencode', 'command');
const userRoot = path.join(sandboxHome, '.nassaj-users', String(USER));
const localDir = path.join(userRoot, '.config-local', 'opencode');
const mainDir = path.join(userRoot, '.config', 'opencode');
const CARD = '---\ndescription: "x"\nmode: subagent\nmodel: opencode/gone-free\n---\nbody\n';

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.chmodSync(file, 0o644); } catch { /* absent */ }
  fs.writeFileSync(file, text);
};

before(() => {
  for (const agent of [...LOCAL_TASK_AGENTS, 'architect']) write(path.join(sharedAgentDir, `${agent}.md`), CARD);
  write(path.join(sharedCommandDir, 'hello.md'), 'cmd\n');
});

beforeEach(() => {
  write(LOCAL_SOURCE, LOCAL_TEXT);
  write(FULL_SOURCE, FULL_TEXT);
});

describe('local config dir', () => {
  it('lives in .config-local, is a real 0700 dir and carries the verified slim copy', () => {
    const prepared = prepareOpenCodeLocalTier(USER);
    assert.equal(prepared.configHome, path.join(userRoot, '.config-local'));
    assert.equal(resolveOpenCodeLocalConfigHomeForUser(USER), localDir);
    const stat = fs.lstatSync(localDir);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(stat.mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(localDir, 'AGENTS.md'), 'utf8'), LOCAL_TEXT);
    assert.equal(prepared.governance.governancePath, path.join(localDir, 'AGENTS.md'));
  });

  it('repairs a tampered copy', () => {
    prepareOpenCodeLocalTier(USER);
    write(path.join(localDir, 'AGENTS.md'), 'tampered\n');
    const prepared = prepareOpenCodeLocalTier(USER);
    assert.equal(prepared.governance.repaired, true);
    assert.equal(fs.readFileSync(path.join(localDir, 'AGENTS.md'), 'utf8'), LOCAL_TEXT);
  });

  it('refuses with the new code when the slim source is missing — never the full file', () => {
    fs.rmSync(LOCAL_SOURCE);
    assert.throws(() => prepareOpenCodeLocalTier(USER), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'local_instructions_unavailable');
      assert.match(error.message, /local/iu);
      assert.match(error.message, /[؀-ۿ]/u, 'Arabic text');
      assert.ok(!/GLM/u.test(error.message), 'not the GLM carrier message');
      return true;
    });
  });

  it('refuses the full file offered as the slim source (I6)', () => {
    write(LOCAL_SOURCE, FULL_TEXT);
    assert.throws(() => prepareOpenCodeLocalTier(USER), { code: 'local_instructions_unavailable' });
  });

  it('refuses a full file with a tier tag appended as the slim source', () => {
    write(LOCAL_SOURCE, `${FULL_TEXT.trimEnd()} tier=local32\n`);
    assert.throws(() => prepareOpenCodeLocalTier(USER), { code: 'local_instructions_unavailable' });
  });

  it('refuses a slim source whose REV no longer matches its body', () => {
    write(LOCAL_SOURCE, LOCAL_TEXT.replace('compact', 'edited'));
    assert.throws(() => prepareOpenCodeLocalTier(USER), { code: 'local_instructions_unavailable' });
  });

  it('writes the allow-list, links command/, generates agent cards', () => {
    prepareOpenCodeLocalTier(USER);
    const config = JSON.parse(fs.readFileSync(path.join(localDir, 'opencode.json'), 'utf8'));
    assert.deepEqual(config.permission, localTaskPermission());
    assert.ok(config.provider.glm, 'same provider material');
    assert.ok(fs.lstatSync(path.join(localDir, 'command')).isSymbolicLink());
    assert.equal(fs.readlinkSync(path.join(localDir, 'command')), sharedCommandDir);
    assert.ok(!fs.lstatSync(path.join(localDir, 'agent')).isSymbolicLink());
    assert.deepEqual(fs.readdirSync(path.join(localDir, 'agent')).sort(), LOCAL_TASK_AGENTS.map((a) => `${a}.md`).sort());
  });

  it('carries the MCP servers of the ordinary config', () => {
    const mcp = { demo: { type: 'local', command: ['echo'], enabled: true } };
    assert.equal(materializeOpenCodeConfig(mainDir, { callerId: USER, mcp }), true);
    fs.rmSync(path.join(localDir, 'opencode.json'), { force: true });
    prepareOpenCodeLocalTier(USER);
    const config = JSON.parse(fs.readFileSync(path.join(localDir, 'opencode.json'), 'utf8'));
    assert.deepEqual(config.mcp, mcp);
  });
});

describe('full gate (I6)', () => {
  it('rejects a tier-tagged file as the full source and accepts the untagged one', () => {
    const home = path.join(sandboxHome, 'gate-full');
    assert.equal(ensureOpenCodeGovernance(USER, home).ok, true);
    write(FULL_SOURCE, LOCAL_TEXT);
    assert.throws(() => ensureOpenCodeGovernance(USER, home), { code: 'governance_missing' });
  });
});

describe('badge (I5)', () => {
  it('checks the local dir against the slim source for the local tier', () => {
    prepareOpenCodeLocalTier(USER);
    const local = providerGovernanceService.getGovernance('opencode', USER, { instructionTier: 'local32' });
    assert.equal(local.status, 'governed');
    assert.equal(local.sources[0].path, path.join(localDir, 'AGENTS.md'));
    write(path.join(localDir, 'AGENTS.md'), 'tampered\n');
    const tampered = providerGovernanceService.getGovernance('opencode', USER, { instructionTier: 'local32' });
    assert.equal(tampered.status, 'ungoverned');
    const full = providerGovernanceService.getGovernance('opencode', USER);
    assert.equal(full.sources[0].path, path.join(mainDir, 'AGENTS.md'));
  });
});

describe('MCP writer (I5)', () => {
  it('also materializes the servers into an existing local dir', async () => {
    prepareOpenCodeLocalTier(USER);
    const provider = new OpenCodeMcpProvider();
    await provider.upsertServer({ name: 'fresh', scope: 'user', transport: 'stdio', command: 'false', userId: String(USER) });
    const local = JSON.parse(fs.readFileSync(path.join(localDir, 'opencode.json'), 'utf8'));
    assert.ok(local.mcp?.fresh, JSON.stringify(local.mcp));
    assert.deepEqual(local.permission, localTaskPermission(), 'still the local tier file');
  });
});

describe('round 1 — MCP overlay never stale (item 1)', () => {
  it('an ordinary config without mcp clears the local overlay', () => {
    const mcp = { secret: { type: 'remote', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer old' } } };
    assert.equal(materializeOpenCodeConfig(mainDir, { callerId: USER, mcp }), true);
    prepareOpenCodeLocalTier(USER);
    assert.ok(JSON.parse(fs.readFileSync(path.join(localDir, 'opencode.json'), 'utf8')).mcp?.secret);
    // The last server removed without the writer reaching the local dir.
    assert.equal(materializeOpenCodeConfig(mainDir, { callerId: USER, mcp: {} }), true);
    prepareOpenCodeLocalTier(USER);
    const local = fs.readFileSync(path.join(localDir, 'opencode.json'), 'utf8');
    assert.equal(JSON.parse(local).mcp, undefined);
    assert.ok(!local.includes('Bearer old'));
  });

  it('an unreadable ordinary config never keeps the stale overlay', () => {
    const mcp = { secret: { type: 'remote', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer old' } } };
    assert.equal(materializeOpenCodeConfig(mainDir, { callerId: USER, mcp }), true);
    prepareOpenCodeLocalTier(USER);
    fs.rmSync(path.join(mainDir, 'opencode.json'), { force: true });
    prepareOpenCodeLocalTier(USER);
    assert.equal(JSON.parse(fs.readFileSync(path.join(localDir, 'opencode.json'), 'utf8')).mcp, undefined);
  });

  it('add a server, remove the last one, run a local turn: no mcp in the local file', async () => {
    prepareOpenCodeLocalTier(USER);
    const provider = new OpenCodeMcpProvider();
    await provider.upsertServer({ name: 'gone', scope: 'user', transport: 'stdio', command: 'false', userId: String(USER) });
    assert.equal((await provider.removeServer({ name: 'gone', scope: 'user', userId: String(USER) })).removed, true);
    prepareOpenCodeLocalTier(USER);
    assert.equal(JSON.parse(fs.readFileSync(path.join(localDir, 'opencode.json'), 'utf8')).mcp, undefined);
  });
});

describe('round 1 — agent cards (item 2)', () => {
  it('a missing card refuses with its own code, Arabic plus an English gloss', () => {
    const card = path.join(sharedAgentDir, 'scribe.md');
    fs.rmSync(card);
    try {
      assert.throws(() => prepareOpenCodeLocalTier(USER), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'local_agent_cards_unavailable');
        assert.match(error.message, /[\u0600-\u06FF]/u);
        assert.match(error.message, /agent cards/iu);
        return true;
      });
    } finally {
      write(card, CARD);
    }
  });
});

describe('round 1 — full gate narrowed to I6 (item 3)', () => {
  const home = path.join(sandboxHome, 'gate-full-r1');

  it('accepts a full file with no REV line', () => {
    write(FULL_SOURCE, '# legacy rules, no REV\n');
    assert.equal(ensureOpenCodeGovernance(USER, home).ok, true);
  });

  it('a mismatched REV only warns and never refuses', () => {
    write(FULL_SOURCE, FULL_TEXT.replace('full rules', 'edited rules'));
    const warn = mock.method(console, 'warn', () => undefined);
    try {
      assert.equal(ensureOpenCodeGovernance(USER, home).ok, true);
      assert.ok(warn.mock.calls.some((call) => /REV/u.test(String(call.arguments[0]))), 'one warning');
      assert.ok(!JSON.stringify(warn.mock.calls.map((c) => c.arguments)).includes('tier_mismatch'));
    } finally {
      warn.mock.restore();
    }
  });

  it('refuses the local32 header in the full slot even with the tag stripped', () => {
    write(FULL_SOURCE, LOCAL_TEXT.replace(' tier=local32\n', '\n'));
    assert.throws(() => ensureOpenCodeGovernance(USER, home), { code: 'governance_missing' });
  });
});

describe('round 1 — badge and dir safety (item 4)', () => {
  it('the local badge applies the REV/tier check, not just the fingerprint', () => {
    prepareOpenCodeLocalTier(USER);
    write(LOCAL_SOURCE, FULL_TEXT);
    write(path.join(localDir, 'AGENTS.md'), FULL_TEXT);
    const badge = providerGovernanceService.getGovernance('opencode', USER, { instructionTier: 'local32' });
    assert.equal(badge.status, 'ungoverned');
  });

  it('refuses a symlinked .config-local', () => {
    const user = 8;
    const root = path.join(sandboxHome, '.nassaj-users', String(user));
    const elsewhere = path.join(sandboxHome, 'elsewhere-8');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(root, '.config-local'));
    assert.throws(() => prepareOpenCodeLocalTier(user), { code: 'MCP_CONFIG_UNSAFE_DIRECTORY' });
    assert.equal(fs.readdirSync(elsewhere).length, 0, 'nothing written through the link');
  });

  it('refuses a symlinked opencode/ dir', () => {
    const user = 9;
    const parent = path.join(sandboxHome, '.nassaj-users', String(user), '.config-local');
    const elsewhere = path.join(sandboxHome, 'elsewhere-9');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(parent, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(parent, 'opencode'));
    assert.throws(() => prepareOpenCodeLocalTier(user), { code: 'MCP_CONFIG_UNSAFE_DIRECTORY' });
    assert.equal(fs.readdirSync(elsewhere).length, 0, 'nothing written through the link');
  });
});
