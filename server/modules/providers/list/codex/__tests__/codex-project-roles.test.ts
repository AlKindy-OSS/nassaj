/**
 * ADR-206 S1 §4 (C3): the pre-launch project role guard. Any project-layer role (a
 * `.codex/agents/*.toml`, an inline `[agents.<name>]` table, or a config that cannot be
 * read safely) found between the cwd and $HOME (or `/`) is a hit, which turns helpers
 * off for the turn. `$CODEX_HOME` (the user layer) is skipped. The guard never throws.
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findCodexProjectRoles } from '../codex-project-roles.js';

function tree(): { root: string; home: string; cwd: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-roles-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'work', 'repo', 'pkg');
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function put(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

test('a clean walk finds nothing; known scalar [agents] keys are not roles', async () => {
  const t = tree();
  try {
    assert.equal(await findCodexProjectRoles(t.cwd, { home: t.home }), null);
    put(path.join(t.home, 'work', 'repo', '.codex', 'config.toml'), [
      'model = "gpt-6-astra"',
      '[agents]',
      'max_threads = 2', 'max_concurrent_threads_per_session = 2', 'max_depth = 3',
      'job_max_runtime_seconds = 60', 'interrupt_message = "x"', 'default_subagent_model = "m"',
      'default_subagent_reasoning_effort = "low"',
      '[features]', 'multi_agent = true',
    ].join('\n'));
    put(path.join(t.home, 'work', 'repo', '.codex', 'agents', 'README.md'), 'not a role');
    assert.equal(await findCodexProjectRoles(t.cwd, { home: t.home }), null);
  } finally {
    t.cleanup();
  }
});

test('a .codex/agents/*.toml at any level up to $HOME is a hit (also above the git root)', async () => {
  for (const level of [['work', 'repo', 'pkg'], ['work', 'repo'], ['work'], []]) {
    const t = tree();
    try {
      mkdirSync(path.join(t.home, 'work', 'repo', '.git'), { recursive: true });
      put(path.join(t.home, ...level, '.codex', 'agents', 'evil.toml'), 'description = "x"\n');
      const hit = await findCodexProjectRoles(t.cwd, { home: t.home });
      assert.equal(hit?.kind, 'agents_dir', level.join('/') || '$HOME');
    } finally {
      t.cleanup();
    }
  }
});

test('an inline [agents.<name>] table (dotted or array) in a project config.toml is a hit', async () => {
  const bodies = [
    '[agents.reviewer]\ndescription = "r"\nconfig_file = "r.toml"\n',
    'agents.reviewer.description = "r"\n',
    '[agents]\nmax_threads = 2\n[agents.x]\nnickname_candidates = ["a"]\n',
    '[[agents.pool]]\ndescription = "r"\n',
  ];
  for (const body of bodies) {
    const t = tree();
    try {
      put(path.join(t.home, 'work', '.codex', 'config.toml'), body);
      assert.equal((await findCodexProjectRoles(t.cwd, { home: t.home }))?.kind, 'inline_role', body);
    } finally {
      t.cleanup();
    }
  }
});

test('an unparsable, oversized or unreadable project config is a hit (fail-closed for delegation)', async () => {
  const t = tree();
  try {
    const file = path.join(t.home, 'work', '.codex', 'config.toml');
    put(file, '[agents\nbroken');
    assert.equal((await findCodexProjectRoles(t.cwd, { home: t.home }))?.kind, 'unparsable_config');
    put(file, `# ${'x'.repeat(1024 * 1024)}\n`);
    assert.equal((await findCodexProjectRoles(t.cwd, { home: t.home }))?.kind, 'unreadable_config');
    put(file, 'model = "m"\n');
    if (process.getuid?.() !== 0) {
      chmodSync(file, 0o000);
      assert.equal((await findCodexProjectRoles(t.cwd, { home: t.home }))?.kind, 'unreadable_config');
      chmodSync(file, 0o600);
      const agents = path.join(t.home, 'work', '.codex', 'agents');
      mkdirSync(agents);
      chmodSync(agents, 0o000);
      assert.equal((await findCodexProjectRoles(t.cwd, { home: t.home }))?.kind, 'unreadable_config');
      chmodSync(agents, 0o700);
    }
  } finally {
    t.cleanup();
  }
});

test('a symlinked config.toml is not followed: it is a hit, its target is never parsed', async () => {
  const t = tree();
  try {
    const outside = path.join(t.root, 'outside.toml');
    writeFileSync(outside, 'model = "harmless"\n');
    put(path.join(t.home, 'work', '.codex', 'keep'), '');
    symlinkSync(outside, path.join(t.home, 'work', '.codex', 'config.toml'));
    assert.equal((await findCodexProjectRoles(t.cwd, { home: t.home }))?.kind, 'unreadable_config');
  } finally {
    t.cleanup();
  }
});

test('a hard-linked config.toml and a symlinked .codex or agents dir are hits', async () => {
  const t = tree();
  try {
    const outside = path.join(t.root, 'shared.toml');
    writeFileSync(outside, 'model = "m"\n');
    put(path.join(t.home, 'work', '.codex', 'keep'), '');
    linkSync(outside, path.join(t.home, 'work', '.codex', 'config.toml'));
    assert.equal((await findCodexProjectRoles(t.cwd, { home: t.home }))?.kind, 'unreadable_config');
    rmSync(path.join(t.home, 'work', '.codex'), { recursive: true });

    const elsewhere = path.join(t.root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(t.home, 'work', '.codex'));
    assert.equal((await findCodexProjectRoles(t.cwd, { home: t.home }))?.kind, 'symlinked_layer');
    rmSync(path.join(t.home, 'work', '.codex'));

    mkdirSync(path.join(t.home, 'work', '.codex'));
    symlinkSync(elsewhere, path.join(t.home, 'work', '.codex', 'agents'));
    assert.equal((await findCodexProjectRoles(t.cwd, { home: t.home }))?.kind, 'symlinked_layer');
  } finally {
    t.cleanup();
  }
});

test('$CODEX_HOME is skipped (user layer), even when the walk passes through it', async () => {
  const t = tree();
  try {
    // The user home's own materialized roster and inline roles are not project roles.
    const codexHome = path.join(t.home, '.codex');
    put(path.join(codexHome, 'agents', 'architect.toml'), 'description = "a"\n');
    put(path.join(codexHome, 'config.toml'), '[agents.mine]\ndescription = "m"\n');
    assert.equal(await findCodexProjectRoles(t.cwd, { home: t.home, excludedCodexHomes: [codexHome] }), null);
    // Without the exclusion the same directory is a hit: the skip is by identity.
    assert.equal((await findCodexProjectRoles(t.cwd, { home: t.home }))?.kind, 'agents_dir');
    // A symlink naming $CODEX_HOME is skipped by its real path too.
    const alias = path.join(t.root, 'alias-home');
    symlinkSync(codexHome, alias);
    assert.equal(await findCodexProjectRoles(t.cwd, { home: t.home, excludedCodexHomes: [alias] }), null);
  } finally {
    t.cleanup();
  }
});

test('outside $HOME the walk goes to `/`; above $HOME it stops at $HOME', async () => {
  const t = tree();
  try {
    put(path.join(t.root, '.codex', 'agents', 'above-home.toml'), 'description = "x"\n');
    assert.equal(await findCodexProjectRoles(t.cwd, { home: t.home }), null, 'above $HOME is not walked');
    const outside = path.join(t.root, 'srv', 'app');
    mkdirSync(outside, { recursive: true });
    assert.equal((await findCodexProjectRoles(outside, { home: t.home }))?.kind, 'agents_dir', 'walks to /');
  } finally {
    t.cleanup();
  }
});

test('a symlinked cwd is walked by both its spelling and its real path', async () => {
  const t = tree();
  try {
    const real = path.join(t.root, 'real', 'repo');
    mkdirSync(real, { recursive: true });
    put(path.join(t.root, 'real', '.codex', 'agents', 'x.toml'), 'description = "x"\n');
    const link = path.join(t.home, 'linked-repo');
    symlinkSync(real, link);
    assert.equal((await findCodexProjectRoles(link, { home: t.home }))?.kind, 'agents_dir');
  } finally {
    t.cleanup();
  }
});

test('the guard never throws: a missing or relative cwd yields null, not a refusal', async () => {
  assert.equal(await findCodexProjectRoles(path.join(os.tmpdir(), 'no-such-dir-adr206', 'x'), { home: '/nonexistent-home' }), null);
  await assert.doesNotReject(findCodexProjectRoles('', { home: os.homedir() }));
  await assert.doesNotReject(findCodexProjectRoles(undefined as unknown as string));
});
