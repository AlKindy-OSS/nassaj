/**
 * opencode-local-tier-material.test — ADR-LOCAL-INSTR-TIER-001 (S4).
 *
 * The pure pieces of the compact local instruction tier:
 *  - I6: the REV line of an instruction file is self-consistent and carries the
 *    right tier tag (local = `tier=local32`, full = none); fixtures, never a pinned sha;
 *  - the local permission block: `permission.task` allow-list (5 agents, everything
 *    else denied) and a webfetch deny (owner decision 2026-11-13, supersedes qa C4),
 *    also appended last to the turn's L1;
 *  - C2: generated agent cards without the frontmatter `model:` line, real files,
 *    never a symlink to the shared agent dir; the researcher card allows webfetch,
 *    the other four deny it;
 *  - owner decision 2026-11-13: the researcher (LOCAL_CLOUD_SUBAGENTS) keeps its cloud
 *    `opencode/...` pin; a missing, local or other-provider pin refuses the turn;
 *  - I5: the config writer infers caller AND tier from a `.config-local` path.
 */
import { SANDBOX_HOME } from '../../shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { localFixture, withRev } from '../../shared/tests/instruction-rev-fixture.js';

process.env.DATABASE_PATH ??= path.join(SANDBOX_HOME, 'auth.db');

const {
  LOCAL_CLOUD_SUBAGENTS,
  LOCAL_CLOUD_DENIED_TOOLS,
  LOCAL_CLOUD_SECRET_PATTERNS,
  LOCAL_CLOUD_SECRET_TOOLS,
  LOCAL_CLOUD_SUBAGENT_MODELS,
  LOCAL_RESEARCHER_REPORT_LIMIT_LINE,
  LOCAL_COORDINATOR_DENIED_TOOLS,
  LOCAL_INSTRUCTION_TIER,
  LOCAL_TASK_AGENTS,
  LOCAL_WEB_RESEARCH_AGENTS,
  localAgentCardContent,
  localCloudModelPin,
  localTierFilePermission,
  localTierL1,
  localTierPermission,
  withLocalTierClaudeDenies,
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
  it('allows exactly the five agents, denies every other one, and denies webfetch (owner 2026-11-13)', () => {
    assert.deepEqual([...LOCAL_TASK_AGENTS], ['researcher', 'backend-dev', 'devops', 'scribe', 'qa-critic']);
    assert.deepEqual([...LOCAL_COORDINATOR_DENIED_TOOLS], ['webfetch']);
    assert.ok(Object.isFrozen(LOCAL_COORDINATOR_DENIED_TOOLS));
    assert.deepEqual([...LOCAL_WEB_RESEARCH_AGENTS], ['researcher']);
    const permission = localTierPermission() as Record<string, any>;
    assert.deepEqual(Object.keys(permission), ['task', 'webfetch']);
    assert.equal(permission.webfetch, 'deny');
    assert.equal(permission.task['*'], 'deny');
    for (const agent of LOCAL_TASK_AGENTS) assert.equal(permission.task[agent], 'allow');
    assert.equal(Object.keys(permission.task).length, 6);
  });

  it('only the local tier config carries the permission block (a GLM config is unchanged)', () => {
    const full = buildOpenCodeConfig(undefined, null) as Record<string, unknown>;
    const local = buildOpenCodeConfig(undefined, null, LOCAL_INSTRUCTION_TIER) as Record<string, unknown>;
    assert.equal(full.permission, undefined);
    assert.ok(!JSON.stringify(full).includes('webfetch'), 'a GLM config has no webfetch rule');
    assert.deepEqual(local.permission, localTierFilePermission());
    assert.deepEqual(local.provider, full.provider, 'same provider/limit material');
  });

  // qa round 1, probe F (real opencode 1.19.5): L1 is merged in the FILE's key order, so
  // an L1 key the file also has (task) keeps the file's position. A file block without a
  // leading "*" therefore puts task BEFORE L1's "*":"allow" and explore/general come back
  // even with localTierL1 appending task last. This leading "*" is the essential anchor
  // of the task list; the L1 append only protects keys absent from the file.
  it('the file block opens with the "*":"allow" L1 opens with, so L1 cannot land after it', () => {
    const file = localTierFilePermission();
    assert.deepEqual(Object.keys(file), ['*', 'task', 'webfetch']);
    assert.equal(file['*'], 'allow');
    assert.ok(!('*' in localTierPermission()), 'the L1 block never moves "*"');
  });
});

describe('local L1 (OPENCODE_PERMISSION) — the local block goes last', () => {
  const glmL1 = JSON.stringify({ '*': 'allow', bash: { 'pm2 restart': 'deny', 'pm2 restart *': 'deny' }, edit: 'deny' });

  it('appends the task allow-list and the webfetch deny after "*":"allow", keeping every other rule', () => {
    const out = JSON.parse(localTierL1(glmL1));
    assert.deepEqual(Object.keys(out), ['*', 'bash', 'edit', 'task', 'webfetch']);
    assert.equal(out['*'], 'allow');
    assert.deepEqual(out.bash, { 'pm2 restart': 'deny', 'pm2 restart *': 'deny' });
    assert.equal(out.edit, 'deny');
    assert.equal(out.webfetch, 'deny');
    assert.deepEqual(out.task, localTierPermission().task);
  });

  it('moves an earlier webfetch/task rule last and never weakens an outright deny', () => {
    const earlier = JSON.parse(localTierL1(JSON.stringify({ webfetch: 'allow', '*': 'allow' })));
    assert.deepEqual(Object.keys(earlier), ['*', 'task', 'webfetch']);
    assert.equal(earlier.webfetch, 'deny');
    const denied = JSON.parse(localTierL1(JSON.stringify({ '*': 'allow', task: 'deny', webfetch: 'deny' })));
    assert.equal(denied.task, 'deny', "Claude's Task deny stays a whole-tool deny");
    assert.equal(denied.webfetch, 'deny');
  });

  it('refuses an L1 that is not a JSON object', () => {
    assert.throws(() => localTierL1('[]'));
    assert.throws(() => localTierL1('nope'));
  });
});

describe("a Claude webfetch deny stays a deny for the researcher (never weaken)", () => {
  it('adds an inline researcher deny only when the turn L1 denies webfetch outright', () => {
    const env = { PATH: '/usr/bin' };
    assert.equal(withLocalTierClaudeDenies(env, '{"*":"allow"}'), env, 'no Claude deny: env unchanged');
    const out = withLocalTierClaudeDenies({ ...env, OPENCODE_CONFIG_CONTENT: '{"lsp":false}' }, '{"*":"allow","webfetch":"deny"}');
    assert.deepEqual(JSON.parse(out.OPENCODE_CONFIG_CONTENT as string), {
      lsp: false, agent: { researcher: { permission: { webfetch: 'deny' } } },
    });
    const fresh = withLocalTierClaudeDenies(env, '{"*":"allow","webfetch":"deny"}');
    assert.deepEqual(JSON.parse(fresh.OPENCODE_CONFIG_CONTENT as string).agent.researcher.permission, { webfetch: 'deny' });
  });
});

const PIN = 'model: opencode/deepseek-v4.1-flash-free';
const CARD = [
  '---',
  '# GENERATED — DO NOT EDIT.',
  'description: "research"',
  'mode: subagent',
  'model: opencode/deepseek-v4.1-flash-free',
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

  it('owner 2026-11-13: only the researcher keeps its cloud model line; the other four drop it', () => {
    assert.deepEqual([...LOCAL_CLOUD_SUBAGENTS], ['researcher']);
    assert.deepEqual([...LOCAL_CLOUD_SUBAGENT_MODELS], ['opencode/deepseek-v4.1-flash-free']);
    for (const agent of LOCAL_CLOUD_SUBAGENTS) assert.ok(LOCAL_TASK_AGENTS.includes(agent));
    assert.match(localAgentCardContent(CARD, { agent: 'researcher' }), new RegExp(`^${PIN}$`, 'mu'));
    for (const agent of ['backend-dev', 'devops', 'scribe', 'qa-critic']) {
      assert.ok(!/^model:/mu.test(localAgentCardContent(CARD, { agent })), agent);
    }
  });

  const front = (card: string) => card.slice(0, card.indexOf('\n---', 4));
  const pinned = (card: string) => card.replace('mode: subagent\n', `mode: subagent\n${PIN}\n`);

  it('the researcher card allows webfetch explicitly; the other four deny it (owner 2026-11-13)', () => {
    const researcher = localAgentCardContent(CARD, { agent: 'researcher' });
    assert.match(front(researcher), /^permission:\n {2}webfetch: allow\n {2}task: deny$/mu, researcher);
    assert.match(front(researcher), new RegExp(`^${PIN}$`, 'mu'), 'keeps its cloud pin');
    for (const agent of ['backend-dev', 'devops', 'scribe', 'qa-critic']) {
      const card = localAgentCardContent(CARD, { agent });
      assert.match(front(card), /^ {2}webfetch: deny$/mu, card);
      assert.ok(!/webfetch: allow/u.test(card));
    }
  });

  it('adds a researcher allow only when the card has no webfetch rule; a deny replaces any rule', () => {
    const bare = pinned('---\ndescription: "x"\nmode: subagent\n---\nbody\n');
    assert.ok(front(localAgentCardContent(bare, { agent: 'researcher' })).startsWith(
      `---\ndescription: "x"\nmode: subagent\n${PIN}\npermission:\n  webfetch: allow\n`));
    const allow = '---\nmode: subagent\npermission:\n  webfetch: allow\n---\nbody\n';
    assert.match(localAgentCardContent(allow, { agent: 'devops' }), /permission:\n {2}webfetch: deny\n---/u);
  });

  it("never weakens a card's own webfetch rule for the researcher (deny, ask, pattern map)", () => {
    const cards = {
      denied: '---\nmode: subagent\npermission:\n  webfetch: deny\n---\nbody\n',
      ask: '---\nmode: subagent\npermission:\n  webfetch: ask\n---\nbody\n',
      nested: '---\nmode: subagent\npermission:\n  webfetch:\n    "*": ask\n  bash: deny\n---\nbody\n',
      map: '---\nmode: subagent\npermission:\n  webfetch:\n    "*": allow\n    "*.internal": deny\n---\nbody\n',
    };
    for (const [name, raw] of Object.entries(cards)) {
      const card = pinned(raw);
      const out = front(localAgentCardContent(card, { agent: 'researcher' }));
      assert.ok(out.startsWith(`${front(card)}\n`), `${name}: the card's own rule is kept as written\n${out}`);
      assert.ok(!out.slice(front(card).length).includes('webfetch'), `${name}: no webfetch rule added`);
    }
  });

  it('a non-research card loses its own webfetch pattern map to a whole-tool deny', () => {
    const map = '---\nmode: subagent\npermission:\n  webfetch:\n    "*": allow\n    "*.internal": deny\n  bash: deny\n---\nbody\n';
    assert.equal(localAgentCardContent(map, { agent: 'devops' }),
      '---\nmode: subagent\npermission:\n  webfetch: deny\n  bash: deny\n---\nbody\n');
  });

  it('qa r1: every top-level model key is stripped from a local card, quoted or spaced', () => {
    const card = '---\nmode: subagent\nmodel: a/b\n"model": c/d\nmodel : e/f\n\'model\': g/h\n---\nbody\n';
    assert.equal(localAgentCardContent(card, { agent: 'devops' }), '---\nmode: subagent\npermission:\n  webfetch: deny\n---\nbody\n');
  });

  it('qa r1: the researcher pin is checked exactly and written back as one clean line', () => {
    const quoted = CARD.replace(PIN, `model: "${PIN.slice('model: '.length)}"`);
    const out = front(localAgentCardContent(quoted, { agent: 'researcher' }));
    assert.equal(out.match(/^["']?model["']?\s*:/gmu)?.length, 1, out);
    assert.match(out, new RegExp(`^${PIN}$`, 'mu'));
    assert.equal(localCloudModelPin(CARD), 'opencode/deepseek-v4.1-flash-free');
  });

  it('qa r1: the researcher card denies reading the governance secret files (deny-only, never an allow)', () => {
    const out = front(localAgentCardContent(CARD, { agent: 'researcher' }));
    for (const tool of LOCAL_CLOUD_SECRET_TOOLS) {
      const block = out.slice(out.indexOf(`\n  ${tool}:\n`));
      for (const pattern of ['.env', '.env.*', '.mcp.json', 'id_rsa', '*.pem', 'auth.json', '.ssh/**', '*.key']) {
        assert.ok(block.includes(`\n    ${JSON.stringify(pattern)}: deny`), `${tool} denies ${pattern}`);
        assert.ok(block.includes(`\n    ${JSON.stringify(`**/${pattern}`)}: deny`), `${tool} denies **/${pattern}`);
      }
    }
    assert.ok(!/^ {4}.*: allow$/mu.test(out), `no allow entry that could re-open an L1 deny:\n${out}`);
    for (const agent of ['backend-dev', 'devops', 'scribe', 'qa-critic']) {
      assert.ok(!localAgentCardContent(CARD, { agent }).includes('".env"'), `${agent} is unchanged`);
    }
  });

  it('coordinator decision: the researcher card denies grep outright (its output is not path-guarded)', () => {
    assert.deepEqual([...LOCAL_CLOUD_SECRET_TOOLS], ['read', 'glob', 'list']);
    assert.deepEqual([...LOCAL_CLOUD_DENIED_TOOLS], ['grep']);
    const out = front(localAgentCardContent(CARD, { agent: 'researcher' }));
    assert.match(out, /^ {2}grep: deny$/mu);
    assert.ok(!out.includes('\n  grep:\n'), 'no grep pattern map');
    for (const own of ['  grep: allow\n', '  grep:\n    "*": allow\n    "*.env": deny\n']) {
      const card = CARD.replace('  task: deny\n', `  task: deny\n${own}`);
      const generated = front(localAgentCardContent(card, { agent: 'researcher' }));
      assert.equal(generated.match(/^ {2}grep\s*:/gmu)?.length, 1, generated);
      assert.match(generated, /^ {2}grep: deny$/mu);
      assert.ok(!generated.includes('"*": allow'), 'the own grep map is gone');
    }
    for (const agent of ['backend-dev', 'devops', 'scribe', 'qa-critic']) {
      assert.ok(!/grep/u.test(localAgentCardContent(CARD, { agent })), `${agent} is unchanged`);
    }
  });

  it("qa r1: a researcher card's own read-family rule: a deny is kept, anything else refuses", () => {
    const denied = CARD.replace('  task: deny\n', '  task: deny\n  read: deny\n');
    const out = front(localAgentCardContent(denied, { agent: 'researcher' }));
    assert.match(out, /^ {2}read: deny$/mu);
    assert.ok(!out.includes('\n  read:\n'), 'the whole-tool deny stays whole');
    const allow = CARD.replace('  task: deny\n', '  task: deny\n  read:\n    "*": allow\n');
    assert.throws(() => localAgentCardContent(allow, { agent: 'researcher' }),
      (error: any) => error.code === 'local_agent_cards_unavailable' && /read/u.test(error.reason));
  });

  it('coordinator margin: only the researcher card body gets the concise-report line', () => {
    assert.match(LOCAL_RESEARCHER_REPORT_LIMIT_LINE, /at most ~6,000 characters/u);
    const researcher = localAgentCardContent(CARD, { agent: 'researcher' });
    assert.ok(researcher.endsWith(`\n${LOCAL_RESEARCHER_REPORT_LIMIT_LINE}\n`), researcher);
    assert.ok(researcher.includes('body mentions model: in prose and keeps it'));
    for (const agent of ['backend-dev', 'devops', 'scribe', 'qa-critic']) {
      assert.ok(!localAgentCardContent(CARD, { agent }).includes(LOCAL_RESEARCHER_REPORT_LIMIT_LINE), agent);
    }
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
      const written = fs.readFileSync(file, 'utf8');
      assert.equal(written.includes(PIN), agent === 'researcher', `${agent}: ${written}`);
      assert.ok(written.includes(`  webfetch: ${agent === 'researcher' ? 'allow' : 'deny'}\n`), `${agent}: ${written}`);
    }
    assert.ok(fs.existsSync(path.join(shared, 'architect.md')), 'the shared dir is never touched');

    fs.writeFileSync(path.join(agentDir, 'stray.md'), CARD);
    fs.chmodSync(path.join(agentDir, 'researcher.md'), 0o644);
    fs.writeFileSync(path.join(agentDir, 'researcher.md'), CARD);
    materializeLocalAgentCards(configDir, shared);
    assert.ok(!fs.existsSync(path.join(agentDir, 'stray.md')));
    assert.ok(fs.readFileSync(path.join(agentDir, 'researcher.md'), 'utf8').includes('  webfetch: allow\n'), 'regenerated');
  });

  it('refuses with the agent-cards code when an allowed card is missing', () => {
    const shared = path.join(root, 'shared-partial');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'researcher.md'), CARD);
    const configDir = path.join(root, 'cfg-partial', 'opencode');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    assert.throws(() => materializeLocalAgentCards(configDir, shared), { code: 'local_agent_cards_unavailable' });
  });

  it('fail closed: a researcher card without an opencode/<model> pin refuses the turn (no silent local run)', () => {
    const configDir = path.join(root, 'cfg-cloud-pin', 'opencode');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const bad = {
      none: CARD.replace(/^model: .*\n/mu, ''),
      local: CARD.replace(/^model: .*$/mu, 'model: nassaj_local_abc/m1'),
      otherProvider: CARD.replace(/^model: .*$/mu, 'model: glm/glm-5.2'),
      noModelId: CARD.replace(/^model: .*$/mu, 'model: opencode/'),
      bareProvider: CARD.replace(/^model: .*$/mu, 'model: opencode'),
      // qa r1: same provider, wrong model (trains on data / paid on a member key).
      bigPickle: CARD.replace(/^model: .*$/mu, 'model: opencode/big-pickle'),
      paidOpus: CARD.replace(/^model: .*$/mu, 'model: opencode/claude-opus-4-8'),
      trailingComment: CARD.replace(/^model: .*$/mu, `${PIN} # pinned`),
      // qa r1: two model lines — opencode uses the LAST one.
      twoLines: CARD.replace(/^model: .*$/mu, `${PIN}\nmodel: nassaj_local_abc/m1`),
      twoAllowed: CARD.replace(/^model: .*$/mu, `${PIN}\n${PIN}`),
      quotedSecond: CARD.replace(/^model: .*$/mu, `${PIN}\n"model": nassaj_local_abc/m1`),
    };
    for (const [name, researcher] of Object.entries(bad)) {
      const shared = path.join(root, `shared-pin-${name}`);
      fs.mkdirSync(shared, { recursive: true });
      for (const agent of LOCAL_TASK_AGENTS) fs.writeFileSync(path.join(shared, `${agent}.md`), CARD);
      fs.writeFileSync(path.join(shared, 'researcher.md'), researcher);
      assert.throws(() => materializeLocalAgentCards(configDir, shared), (error: any) =>
        error.code === 'local_agent_cards_unavailable'
        && /fix the researcher model pin in nassaj-core/u.test(error.reason)
        && !/update nassaj-core/iu.test(error.reason), name);
    }
  });
});

describe('I5 — config identity from a .config-local path', () => {
  it('re-derives the local tier content from the path alone', () => {
    const configDir = path.join(root, 'users', '42', '.config-local', 'opencode');
    assert.equal(materializeOpenCodeConfig(configDir, { callerId: 42, tier: LOCAL_INSTRUCTION_TIER }), true);
    const target = path.join(configDir, 'opencode.json');
    const written = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.deepEqual(written.permission, localTierFilePermission());
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

/*
 * Drift guard for LOCAL_CLOUD_SECRET_PATTERNS against nassaj-core's plugin SECRETS `decl`
 * lists. It reads the LIVE plugin (~/.claude/opencode/plugin/nassaj-governance.js of the
 * real account home, not the sandbox HOME) as text, never executing it: a checked-in
 * fixture would be one more copy and could not see nassaj-core change. ~/.claude is
 * nassaj-core on every node, so this runs wherever the server runs; where it is absent
 * (a bare CI checkout) the test skips and says so. NASSAJ_TEST_GOVERNANCE_PLUGIN overrides
 * the path.
 */
const PLUGIN_PATH = process.env.NASSAJ_TEST_GOVERNANCE_PLUGIN
  || path.join(os.userInfo().homedir, '.claude', 'opencode', 'plugin', 'nassaj-governance.js');

/** Every `decl: [...]` string inside the plugin's `const SECRETS = [ ... ];` block. */
function pluginDeclPatterns(source: string): string[] {
  const start = source.indexOf('const SECRETS = [');
  assert.ok(start >= 0, 'SECRETS block not found in the plugin');
  const block = source.slice(start, source.indexOf('\n];', start));
  const lists = [...block.matchAll(/decl:\s*\[([^\]]*)\]/gu)].map((match) => match[1]);
  assert.ok(lists.length > 10, `too few decl lists parsed: ${lists.length}`);
  return lists.flatMap((list) => [...list.matchAll(/"([^"]*)"/gu)].map((match) => match[1]));
}

describe('secret patterns stay in step with the nassaj-core governance plugin', () => {
  it('LOCAL_CLOUD_SECRET_PATTERNS equals the plugin decl list', { skip: fs.existsSync(PLUGIN_PATH) ? false : `no plugin at ${PLUGIN_PATH}` }, () => {
    const decl = pluginDeclPatterns(fs.readFileSync(PLUGIN_PATH, 'utf8'));
    assert.deepEqual([...LOCAL_CLOUD_SECRET_PATTERNS].sort(), [...new Set(decl)].sort());
  });

  it('the parser itself catches a pattern added to the plugin', () => {
    const fake = 'const SECRETS = [\n'
      + Array.from({ length: 11 }, (_, i) => `  { id: "s${i}", decl: ["p${i}", "**/q${i}"] },\n`).join('')
      + '];\n';
    assert.deepEqual(pluginDeclPatterns(fake).slice(0, 2), ['p0', '**/q0']);
    assert.equal(pluginDeclPatterns(fake).length, 22);
  });
});
