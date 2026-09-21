/**
 * codex-coordinator-agents.test.ts — T-886. Pure filesystem unit test of the
 * coordinator-delegate TOML generator: no DB, no SDK, no spawn, NO fs mocks (the
 * synthetic-fixtures lesson — every path is a real temp file under a sandboxed $HOME).
 *
 * Proves:
 *  - coordinatorAgentNames() reads the FULL roster from ~/.claude/agents/*.md (dynamic,
 *    not a hardcoded pair), sorted, and EXCLUDES structural non-cards (INDEX/README/
 *    _format);
 *  - the root contract is delegate-only, names bare (بلا @), and references the whole
 *    available roster (analysis AND execution agents);
 *  - normalizeCodexModel yields a BARE id (بلا @) and rejects the unusable;
 *  - buildAgentToml emits name (no @) + description + the session model (DROPPING the
 *    card's Claude id) + a leaf contract + an agentDefinitionHash, OMITS sandbox_mode so
 *    the delegate inherits the session sandbox (E12: a write agent can write), and
 *    returns null for a missing/malformed card;
 *  - materializeCoordinatorAgents writes a TOML for EVERY present card (incl. write
 *    agents), is idempotent, rewrites on card/model drift, and FAILS CLOSED (ok:false,
 *    nothing half-written) on a missing model, an empty roster, or a malformed card.
 *
 * HOME is sandboxed before importing the module so coordinatorAgentCardPath() (which
 * reads $HOME/.claude/agents/<name>.md) resolves into the temp tree. Runner: node:test/tsx.
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-coord-agents-'));
const ORIGINAL_HOME = process.env.HOME;
const sandboxHome = path.join(sandbox, 'home');
const CARDS_DIR = path.join(sandboxHome, '.claude', 'agents');
fs.mkdirSync(CARDS_DIR, { recursive: true });
process.env.HOME = sandboxHome;

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Realistic cards mirroring ~/.claude/agents/*.md frontmatter (incl. the Claude model
// id that MUST be dropped, and a list-valued `triggers:` that must be ignored).
const ARCHITECT_CARD = `---
name: architect
model: claude-opus-4-8
name_ar: المِعمار
description: تصميم المعمارية واتخاذ القرارات التقنية.
role: تصميم المعمارية واتخاذ القرارات التقنية الكبرى
scope: engineering
max_words: 400
triggers:
  - "architecture"
  - "schema"
---

## الدور
يُستدعى عند بدء مشروع جديد.
بوابة الرفض: خارج التخصص → أعد للمنسّق.
`;

const QA_CARD = `---
name: qa-critic
model: claude-opus-4-8
name_ar: الناقد
description: مراجعة نقدية للكود والقرارات بصلاحية فيتو.
role: مراجعة نقدية للكود والقرارات مع صلاحية فيتو
scope: engineering
---

## الدور
الناقد الصارم. يملك صلاحية فيتو.
`;

// A WRITE agent — proves the roster is no longer analysis-only and that its TOML omits
// sandbox_mode (so it inherits the session's workspace-write and can actually write).
const BACKEND_CARD = `---
name: backend-dev
model: claude-opus-4-8
name_ar: البنّاء
description: بناء APIs ومنطق الأعمال وطبقة البيانات.
role: بناء APIs ومنطق الأعمال وطبقة البيانات على السيرفر
scope: engineering
---

## الدور
يُستدعى عند تنفيذ endpoint أو migration.
`;

function seedCards(): void {
  // Clear the dir so each case starts from a known roster (drift/missing independence).
  for (const e of fs.readdirSync(CARDS_DIR)) fs.rmSync(path.join(CARDS_DIR, e), { force: true });
  fs.writeFileSync(path.join(CARDS_DIR, 'architect.md'), ARCHITECT_CARD);
  fs.writeFileSync(path.join(CARDS_DIR, 'qa-critic.md'), QA_CARD);
}

const {
  coordinatorAgentNames,
  CODEX_AGENTS_SUBDIR,
  COORDINATOR_ROOT_CONTRACT,
  normalizeCodexModel,
  coordinatorAgentCardPath,
  buildAgentToml,
  materializeCoordinatorAgents,
  pruneStaleCoordinatorAgents,
} = await import('./codex-coordinator-agents.js');

// Reseed cards before EACH case so drift/missing/malformed cases stay independent.
beforeEach(seedCards);

after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** A fresh, NON-existent CODEX_HOME (materialize must create agents/ itself). */
function freshHome(name: string): string {
  const home = path.join(sandbox, name);
  fs.rmSync(home, { recursive: true, force: true });
  return home;
}

describe('coordinatorAgentNames — dynamic roster from the cards dir', () => {
  it('returns the present cards, sorted, without .md', () => {
    assert.deepEqual(coordinatorAgentNames(), ['architect', 'qa-critic']);
    assert.equal(CODEX_AGENTS_SUBDIR, 'agents');
  });

  it('enrolls a newly added card automatically (roster is not a hardcoded pair)', () => {
    fs.writeFileSync(path.join(CARDS_DIR, 'backend-dev.md'), BACKEND_CARD);
    assert.deepEqual(coordinatorAgentNames(), ['architect', 'backend-dev', 'qa-critic']);
  });

  it('excludes structural non-cards (INDEX/README/_format), keeps hyphenated ids', () => {
    fs.writeFileSync(path.join(CARDS_DIR, 'INDEX.md'), '# فهرس');
    fs.writeFileSync(path.join(CARDS_DIR, 'README.md'), '# readme');
    fs.writeFileSync(path.join(CARDS_DIR, '_format.md'), '# format contract');
    fs.writeFileSync(path.join(CARDS_DIR, 'a11y-architect.md'), BACKEND_CARD);
    const names = coordinatorAgentNames();
    assert.deepEqual(names, ['a11y-architect', 'architect', 'qa-critic']);
    for (const junk of ['INDEX', 'README', '_format']) {
      assert.equal(names.includes(junk), false, `${junk} must be excluded from the roster`);
    }
  });
});

describe('codex-coordinator-agents — contract constant', () => {
  it('root contract is delegate-only and names agents by bare name (بلا @)', () => {
    assert.match(COORDINATOR_ROOT_CONTRACT, /منسّق نسّاج/);
    assert.match(COORDINATOR_ROOT_CONTRACT, /spawn_agent/);
    assert.match(COORDINATOR_ROOT_CONTRACT, /بلا @/);
  });

  it('root contract references the full roster (analysis AND execution) + forbids unconfigured spawns', () => {
    // Concise practical phrasing — points at the whole available roster (not a hand-kept
    // list of 25), and names representative analysis + WRITE agents so the model knows
    // execution delegation is in scope.
    assert.match(COORDINATOR_ROOT_CONTRACT, /كامل وكلاء نسّاج/);
    assert.ok(COORDINATOR_ROOT_CONTRACT.includes('architect'), 'names an analysis agent');
    assert.ok(COORDINATOR_ROOT_CONTRACT.includes('backend-dev'), 'names a write agent');
    // Directive: an unavailable specialization ⇒ tell the owner, do NOT spawn an
    // unconfigured agent, do NOT self-execute.
    assert.match(COORDINATOR_ROOT_CONTRACT, /غير مُهيّأ/);
  });

  it('resolves cards under $HOME/.claude/agents', () => {
    assert.equal(coordinatorAgentCardPath('architect'), path.join(CARDS_DIR, 'architect.md'));
  });
});

describe('normalizeCodexModel — bare id, no @ (Gate 1B)', () => {
  it('passes a bare id through unchanged', () => {
    assert.equal(normalizeCodexModel('gpt-5-codex'), 'gpt-5-codex');
  });

  it('strips a provider@ / @ prefix to the bare id', () => {
    assert.equal(normalizeCodexModel('codex@gpt-5-codex'), 'gpt-5-codex');
    assert.equal(normalizeCodexModel('@gpt-5-codex'), 'gpt-5-codex');
  });

  it('returns null for empty / whitespace / non-string (fail-closed upstream)', () => {
    assert.equal(normalizeCodexModel(''), null);
    assert.equal(normalizeCodexModel('   '), null);
    assert.equal(normalizeCodexModel(null), null);
    assert.equal(normalizeCodexModel(undefined), null);
    assert.equal(normalizeCodexModel(42), null);
  });
});

describe('buildAgentToml — schema, identity, model, leaf, hash, no @, no sandbox_mode', () => {
  it('emits the full delegate TOML and DROPS the card Claude id', () => {
    const built = buildAgentToml('architect', 'gpt-5-codex');
    assert.ok(built, 'must build for a present card');
    const { toml, hash } = built;

    // Identity = card `name`, referenced with NO leading @.
    assert.match(toml, /^name = "architect"$/m);
    assert.equal(toml.includes('@architect'), false, 'no @-prefixed agent name');
    assert.equal(toml.includes('"@'), false, 'no @ opening any TOML string');

    // Model is the passed BARE Codex model; the card's Claude id is DROPPED.
    assert.match(toml, /^model = "gpt-5-codex"$/m);
    assert.equal(toml.includes('claude-opus-4-8'), false, 'Claude model id must not leak into the TOML');

    // No sandbox_mode line — the delegate inherits the session sandbox (E12).
    assert.equal(/^sandbox_mode/m.test(toml), false, 'must NOT pin a child sandbox_mode');

    // Leaf contract + the card's own refusal gate carried into developer_instructions.
    assert.match(toml, /developer_instructions = """/);
    assert.match(toml, /أنت وكيل leaf: لا تفوّض/);
    assert.match(toml, /أعد النتيجة للمنسّق/);
    assert.match(toml, /بوابة الرفض/);

    // agentDefinitionHash comment present and equal to the returned hash.
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.match(toml, new RegExp(`^# agentDefinitionHash = "${hash}"$`, 'm'));
  });

  it('normalizes an @-prefixed model into the TOML (بلا @)', () => {
    const built = buildAgentToml('qa-critic', 'codex@gpt-5-codex');
    assert.ok(built);
    assert.match(built.toml, /^model = "gpt-5-codex"$/m);
    assert.match(built.toml, /^name = "qa-critic"$/m);
  });

  it('returns null for a missing card', () => {
    assert.equal(buildAgentToml('does-not-exist', 'gpt-5-codex'), null);
  });

  it('returns null for a malformed (no frontmatter) card', () => {
    fs.writeFileSync(path.join(CARDS_DIR, 'architect.md'), 'no frontmatter at all');
    assert.equal(buildAgentToml('architect', 'gpt-5-codex'), null);
  });

  it('returns null when the model is unusable (fail-closed input)', () => {
    assert.equal(buildAgentToml('architect', ''), null);
    assert.equal(buildAgentToml('architect', '   '), null);
  });
});

describe('materializeCoordinatorAgents — dynamic roster, idempotent, drift, fail-closed', () => {
  it('writes a TOML for EVERY present card — including a write agent (no sandbox_mode)', () => {
    fs.writeFileSync(path.join(CARDS_DIR, 'backend-dev.md'), BACKEND_CARD);
    const home = freshHome('home-ok');
    const res = materializeCoordinatorAgents(home, 'gpt-5-codex');
    assert.equal(res.ok, true);
    assert.deepEqual(res.agents, ['architect', 'backend-dev', 'qa-critic']);
    assert.equal(res.agentsDir, path.join(home, 'agents'));

    for (const name of ['architect', 'backend-dev', 'qa-critic']) {
      const p = path.join(home, 'agents', `${name}.toml`);
      assert.equal(fs.existsSync(p), true, `${name}.toml must exist`);
      const toml = fs.readFileSync(p, 'utf8');
      assert.match(toml, new RegExp(`^name = "${name}"$`, 'm'));
      assert.equal(/^sandbox_mode/m.test(toml), false, `${name} must inherit the session sandbox`);
      assert.match(toml, /^model = "gpt-5-codex"$/m);
      assert.match(toml, /^# agentDefinitionHash = "[0-9a-f]{64}"$/m);
      assert.equal(toml.includes(`@${name}`), false, 'no @-prefixed delegate name');
    }
  });

  it('is idempotent: an unchanged card+model is NOT rewritten', () => {
    const home = freshHome('home-idem');
    assert.equal(materializeCoordinatorAgents(home, 'gpt-5-codex').ok, true);
    const p = path.join(home, 'agents', 'architect.toml');
    const mtime1 = fs.statSync(p).mtimeMs;

    assert.equal(materializeCoordinatorAgents(home, 'gpt-5-codex').ok, true);
    const mtime2 = fs.statSync(p).mtimeMs;
    assert.equal(mtime1, mtime2, 'unchanged delegate must not be rewritten (idempotent)');
  });

  it('rewrites on drift when the source card changes', () => {
    const home = freshHome('home-card-drift');
    assert.equal(materializeCoordinatorAgents(home, 'gpt-5-codex').ok, true);
    const p = path.join(home, 'agents', 'architect.toml');
    const before = fs.readFileSync(p, 'utf8');

    fs.writeFileSync(
      path.join(CARDS_DIR, 'architect.md'),
      ARCHITECT_CARD.replace('يُستدعى عند بدء مشروع جديد.', 'نص محدَّث للبطاقة.'),
    );
    assert.equal(materializeCoordinatorAgents(home, 'gpt-5-codex').ok, true);
    const after = fs.readFileSync(p, 'utf8');
    assert.notEqual(before, after, 'a changed card must rewrite the delegate TOML');
    assert.match(after, /نص محدَّث للبطاقة\./);
  });

  it('rewrites on drift when the resolved model changes', () => {
    const home = freshHome('home-model-drift');
    materializeCoordinatorAgents(home, 'gpt-5-codex');
    const p = path.join(home, 'agents', 'architect.toml');
    assert.match(fs.readFileSync(p, 'utf8'), /^model = "gpt-5-codex"$/m);

    materializeCoordinatorAgents(home, 'gpt-5.5');
    assert.match(fs.readFileSync(p, 'utf8'), /^model = "gpt-5.5"$/m);
  });

  it('FAIL-CLOSED: refuses (ok:false) when the model is missing — writes nothing', () => {
    const home = freshHome('home-nomodel');
    const res = materializeCoordinatorAgents(home, '');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'model_missing');
    assert.equal(fs.existsSync(path.join(home, 'agents')), false, 'no dir/files created without a model');
  });

  it('FAIL-CLOSED: refuses (ok:false) when the roster is empty', () => {
    for (const e of fs.readdirSync(CARDS_DIR)) fs.rmSync(path.join(CARDS_DIR, e), { force: true });
    const home = freshHome('home-empty');
    const res = materializeCoordinatorAgents(home, 'gpt-5-codex');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'roster_empty');
  });

  it('FAIL-CLOSED: refuses when a rostered card is malformed (no frontmatter)', () => {
    // architect.md is present (so it enrolls in the roster) but has no frontmatter, so
    // buildAgentToml returns null ⇒ materialize aborts before writing it.
    fs.writeFileSync(path.join(CARDS_DIR, 'architect.md'), 'no frontmatter at all');
    const home = freshHome('home-malformed');
    const res = materializeCoordinatorAgents(home, 'gpt-5-codex');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'card_unavailable:architect');
    assert.equal(
      fs.existsSync(path.join(home, 'agents', 'architect.toml')),
      false,
      'the malformed delegate must not have a TOML',
    );
  });
});

describe('sweep — orphan delegate TOMLs are pruned on the next materialize (T-903 §1)', () => {
  it('a card removed from the roster has its stale TOML swept on the next run', () => {
    const home = freshHome('home-sweep');
    // First launch materializes both delegates.
    assert.deepEqual(materializeCoordinatorAgents(home, 'gpt-5-codex').agents, ['architect', 'qa-critic']);
    const orphanPath = path.join(home, 'agents', 'qa-critic.toml');
    assert.equal(fs.existsSync(orphanPath), true, 'qa-critic.toml must exist before removal');

    // Owner removes the qa-critic card; the NEXT launch (materialize) must sweep it.
    fs.rmSync(path.join(CARDS_DIR, 'qa-critic.md'), { force: true });
    const res = materializeCoordinatorAgents(home, 'gpt-5-codex');
    assert.equal(res.ok, true);
    assert.deepEqual(res.agents, ['architect'], 'roster shrank to the surviving card');
    assert.deepEqual(res.pruned, ['qa-critic'], 'the removed card’s TOML must be reported pruned');
    assert.equal(fs.existsSync(orphanPath), false, 'the orphan TOML must be deleted');
    assert.equal(
      fs.existsSync(path.join(home, 'agents', 'architect.toml')),
      true,
      'a current-roster delegate must be preserved',
    );
  });

  it('never deletes a FOREIGN/hand-placed TOML (no agentDefinitionHash marker)', () => {
    const home = freshHome('home-sweep-foreign');
    materializeCoordinatorAgents(home, 'gpt-5-codex');
    const foreignPath = path.join(home, 'agents', 'not-ours.toml');
    fs.writeFileSync(foreignPath, 'name = "not-ours"\n# hand-placed, no hash marker\n');

    const pruned = pruneStaleCoordinatorAgents(path.join(home, 'agents'), coordinatorAgentNames());
    assert.equal(pruned.includes('not-ours'), false, 'a foreign TOML must never be pruned');
    assert.equal(fs.existsSync(foreignPath), true, 'the foreign TOML must survive the sweep');
  });

  it('is a no-op (never throws, returns []) on a non-existent agents dir', () => {
    const pruned = pruneStaleCoordinatorAgents(path.join(sandbox, 'no-such-dir', 'agents'), ['architect']);
    assert.deepEqual(pruned, []);
  });
});
