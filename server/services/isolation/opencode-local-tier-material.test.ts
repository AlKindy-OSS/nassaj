/**
 * opencode-local-tier-material.test — ADR-LOCAL-INSTR-TIER-001 (S4).
 *
 * The pure pieces of the compact local instruction tier:
 *  - I6: the REV line of an instruction file is self-consistent and carries the
 *    right tier tag (local = `tier=local32`, full = none); fixtures, never a pinned sha;
 *  - the local `permission.task` allow-list (5 agents, everything else denied) and
 *    no webfetch rule (C4);
 *  - C2: generated agent cards without the frontmatter `model:` line, real files,
 *    never a symlink to the shared agent dir;
 *  - I5: the config writer infers caller AND tier from a `.config-local` path.
 */
import { SANDBOX_HOME } from '../../shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { localFixture, withRev } from '../../shared/tests/instruction-rev-fixture.js';

process.env.DATABASE_PATH ??= path.join(SANDBOX_HOME, 'auth.db');

const {
  LOCAL_INSTRUCTION_TIER,
  LOCAL_TASK_AGENTS,
  localAgentCardContent,
  localTaskPermission,
  materializeLocalAgentCards,
  verifyInstructionRev,
} = await import('./opencode-local-tier-material.js');
const {
  buildOpenCodeConfig,
  materializeOpenCodeConfig,
  openCodeConfigMatches,
} = await import('./opencode-config-material.js');

const root = fs.mkdtempSync(path.join(SANDBOX_HOME, 'local-tier-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('I6 — REV self-consistency and tier tag', () => {
  const body = '# rules\n\nkeep replies short\n';

  it('accepts a local file tagged tier=local32 and a full file with no tag', () => {
    assert.equal(verifyInstructionRev(localFixture(body), LOCAL_INSTRUCTION_TIER), null);
    assert.equal(verifyInstructionRev(withRev(body, null), null), null);
  });

  it('rejects a full file offered as local and a local file offered as full', () => {
    assert.match(String(verifyInstructionRev(withRev(body, null), 'local32')), /tier/u);
    assert.match(String(verifyInstructionRev(localFixture(body), null)), /tier/u);
  });

  it('rejects a full file with a tier tag appended (the tag is outside the hash)', () => {
    const full = withRev(body, null);
    const appended = `${full.trimEnd()} tier=local32\n`;
    assert.match(String(verifyInstructionRev(appended, 'local32')), /header/u);
  });

  it('rejects a local file whose tag was stripped, offered as full', () => {
    const stripped = localFixture(body).replace(' tier=local32\n', '\n');
    assert.match(String(verifyInstructionRev(stripped, null)), /header/u);
  });

  it('rejects an edited body, a missing REV line, a missing final newline and another tier', () => {
    const tampered = localFixture(body).replace('short', 'long');
    assert.match(String(verifyInstructionRev(tampered, 'local32')), /REV mismatch/u);
    assert.match(String(verifyInstructionRev(body, 'local32')), /REV line/u);
    assert.match(String(verifyInstructionRev(localFixture(body).trimEnd(), 'local32')), /newline/u);
    assert.match(String(verifyInstructionRev(withRev(body, 'local16'), 'local32')), /tier/u);
  });

  it('rejects a REV marker above the last line', () => {
    const doubled = withRev(`${localFixture(body)}more\n`, 'local32');
    assert.match(String(verifyInstructionRev(doubled, 'local32')), /above/u);
  });
});

describe('local permission block', () => {
  it('allows exactly the five agents and denies every other one; no webfetch rule (C4)', () => {
    assert.deepEqual([...LOCAL_TASK_AGENTS], ['researcher', 'backend-dev', 'devops', 'scribe', 'qa-critic']);
    const permission = localTaskPermission();
    assert.deepEqual(Object.keys(permission), ['task']);
    assert.equal(permission.task['*'], 'deny');
    for (const agent of LOCAL_TASK_AGENTS) assert.equal(permission.task[agent], 'allow');
    assert.equal(Object.keys(permission.task).length, 6);
  });

  it('only the local tier config carries the permission block', () => {
    const full = buildOpenCodeConfig(undefined, null) as Record<string, unknown>;
    const local = buildOpenCodeConfig(undefined, null, LOCAL_INSTRUCTION_TIER) as Record<string, unknown>;
    assert.equal(full.permission, undefined);
    assert.deepEqual(local.permission, localTaskPermission());
    assert.deepEqual(local.provider, full.provider, 'same provider/limit material');
    assert.ok(!JSON.stringify(local).includes('webfetch'));
  });
});

const CARD = [
  '---',
  '# GENERATED — DO NOT EDIT.',
  'description: "research"',
  'mode: subagent',
  'model: opencode/removed-free-model',
  'permission:',
  '  task: deny',
  '---',
  '',
  'body mentions model: in prose and keeps it',
  '',
].join('\n');

describe('C2 — generated agent cards without a model pin', () => {
  it('drops only the frontmatter model line', () => {
    const out = localAgentCardContent(CARD);
    assert.ok(!/^model:/mu.test(out.split('\n---\n')[0]), out);
    assert.ok(out.includes('body mentions model: in prose and keeps it'));
    assert.ok(out.includes('mode: subagent'));
    assert.ok(out.includes('  task: deny'));
  });

  it('keeps the pin when the switch says cloud pins', () => {
    assert.equal(localAgentCardContent(CARD, { inheritSessionModel: false }), CARD);
  });

  it('writes real 0444 copies of the five cards, replaces a symlinked agent dir, drops strays', () => {
    const shared = path.join(root, 'shared-agent');
    fs.mkdirSync(shared, { recursive: true });
    for (const agent of [...LOCAL_TASK_AGENTS, 'architect']) fs.writeFileSync(path.join(shared, `${agent}.md`), CARD);
    const configDir = path.join(root, 'cfg-local', 'opencode');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.symlinkSync(shared, path.join(configDir, 'agent'));

    materializeLocalAgentCards(configDir, shared);
    const agentDir = path.join(configDir, 'agent');
    assert.ok(!fs.lstatSync(agentDir).isSymbolicLink(), 'agent dir is real');
    assert.deepEqual(fs.readdirSync(agentDir).sort(), LOCAL_TASK_AGENTS.map((a) => `${a}.md`).sort());
    for (const agent of LOCAL_TASK_AGENTS) {
      const file = path.join(agentDir, `${agent}.md`);
      const stat = fs.lstatSync(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      assert.equal(stat.mode & 0o777, 0o444);
      assert.ok(!fs.readFileSync(file, 'utf8').includes('model: opencode/removed-free-model'));
    }
    assert.ok(fs.existsSync(path.join(shared, 'architect.md')), 'the shared dir is never touched');

    fs.writeFileSync(path.join(agentDir, 'stray.md'), CARD);
    fs.chmodSync(path.join(agentDir, 'researcher.md'), 0o644);
    fs.writeFileSync(path.join(agentDir, 'researcher.md'), CARD);
    materializeLocalAgentCards(configDir, shared);
    assert.ok(!fs.existsSync(path.join(agentDir, 'stray.md')));
    assert.ok(!fs.readFileSync(path.join(agentDir, 'researcher.md'), 'utf8').includes('removed-free-model'));
  });

  it('refuses with the agent-cards code when an allowed card is missing', () => {
    const shared = path.join(root, 'shared-partial');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'researcher.md'), CARD);
    const configDir = path.join(root, 'cfg-partial', 'opencode');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    assert.throws(() => materializeLocalAgentCards(configDir, shared), { code: 'local_agent_cards_unavailable' });
  });
});

describe('I5 — config identity from a .config-local path', () => {
  it('re-derives the local tier content from the path alone', () => {
    const configDir = path.join(root, 'users', '42', '.config-local', 'opencode');
    assert.equal(materializeOpenCodeConfig(configDir, { callerId: 42, tier: LOCAL_INSTRUCTION_TIER }), true);
    const target = path.join(configDir, 'opencode.json');
    const written = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.deepEqual(written.permission, localTaskPermission());
    assert.equal(openCodeConfigMatches(target), true, 'path inference finds caller and tier');
  });

  it('the ordinary .config path still infers no tier', () => {
    const configDir = path.join(root, 'users', '42', '.config', 'opencode');
    assert.equal(materializeOpenCodeConfig(configDir, { callerId: 42 }), true);
    const target = path.join(configDir, 'opencode.json');
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).permission, undefined);
    assert.equal(openCodeConfigMatches(target), true);
  });
});
