/**
 * T-1880: root spellings, layout-independent transcript lookup and the
 * spelling-independent cost key, on real temp trees (symlinks included).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CLAUDE_HOME_READY,
  OPERATOR_ROOT_ID,
  buildClaudeRootCatalog,
  claudeRelativeSourceKey,
  filePresence,
  legacySourceKeyCandidates,
  locateClaudeTranscript,
  relativeTranscriptPath,
  resolveGovernanceDir,
} from '../claude-projects-roots.js';

/** Root-list provider for tests; counts calls so laziness is observable. */
function lists(roots: string[], spellings: string[]) {
  const provider = () => { provider.calls += 1; return { roots, spellings }; };
  provider.calls = 0;
  return provider;
}

type Layout = { base: string; core: string; ch: string; transcript: string };

/** Post-separation layout: real $CH/projects/<slug>/s.jsonl, $CORE/projects/<slug> compat link. */
function separatedLayout(t: test.TestContext, compatLink = true): Layout {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-roots-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const core = path.join(base, 'nassaj-core');
  const ch = path.join(base, '.claude');
  mkdirSync(path.join(ch, 'projects', '-slug'), { recursive: true });
  mkdirSync(path.join(core, 'projects'), { recursive: true });
  const transcript = path.join(ch, 'projects', '-slug', 's.jsonl');
  writeFileSync(transcript, '{}\n');
  if (compatLink) symlinkSync(path.join(ch, 'projects', '-slug'), path.join(core, 'projects', '-slug'));
  return { base, core, ch, transcript };
}

test('feature marker is all-true and frozen', () => {
  assert.deepEqual({ ...CLAUDE_HOME_READY }, { watcherRecheck: true, costKeyV2: true, resolverFallback: true });
  assert.ok(Object.isFrozen(CLAUDE_HOME_READY));
});

test('relativeTranscriptPath: longest known root wins, else <slug>/<file>', () => {
  assert.equal(relativeTranscriptPath('/a/projects/-s/x/sub/y.jsonl', ['/a', '/a/projects']), path.join('-s', 'x', 'sub', 'y.jsonl'));
  assert.equal(relativeTranscriptPath('/elsewhere/deep/-s/y.jsonl', ['/a/projects']), path.join('-s', 'y.jsonl'));
  assert.equal(relativeTranscriptPath('/a/projectsX/-s/y.jsonl', ['/a/projects']), path.join('-s', 'y.jsonl'));
});

test('filePresence: ELOOP (the migration self-loop instant) is unknown, not absent', (t) => {
  const { core, transcript } = separatedLayout(t, false);
  const loop = path.join(core, 'projects', '-loop');
  symlinkSync(loop, loop);
  assert.equal(filePresence(transcript), 'present');
  assert.equal(filePresence(path.join(core, 'projects', 'missing.jsonl')), 'absent');
  assert.equal(filePresence(path.join(loop, 's.jsonl')), 'unknown');
  assert.equal(filePresence(path.dirname(transcript)), 'absent', 'a directory is not a transcript');
});

test('locate: old core spelling resolves via compat link or, without it, under the current root', (t) => {
  const withLink = separatedLayout(t, true);
  const legacy = path.join(withLink.core, 'projects', '-slug', 's.jsonl');
  const roots = [path.join(withLink.ch, 'projects')];
  assert.deepEqual(locateClaudeTranscript(legacy, lists(roots, [path.join(withLink.core, 'projects')])), { state: 'present', path: legacy });

  const noLink = separatedLayout(t, false);
  const stale = path.join(noLink.core, 'projects', '-slug', 's.jsonl');
  const found = locateClaudeTranscript(stale, lists([path.join(noLink.ch, 'projects')], [path.join(noLink.core, 'projects')]));
  assert.deepEqual(found, { state: 'present', path: noLink.transcript });
});

test('locate: absent only when every candidate is provably missing', (t) => {
  const { core, ch } = separatedLayout(t, false);
  const roots = [path.join(ch, 'projects')];
  assert.deepEqual(locateClaudeTranscript(path.join(core, 'projects', '-slug', 'gone.jsonl'), lists(roots, [])), { state: 'absent' });
  const loop = path.join(core, 'projects', '-loop');
  symlinkSync(loop, loop);
  assert.deepEqual(locateClaudeTranscript(path.join(loop, 'gone.jsonl'), lists(roots, [])), { state: 'unknown' });
});

test('catalog: spellings grouped by realpath; operator id 0 owns the legacy spellings', (t) => {
  const { base, core, ch } = separatedLayout(t, false);
  const memberHome = path.join(base, 'users', '1', '.claude');
  mkdirSync(memberHome, { recursive: true });
  symlinkSync(path.join(ch, 'projects'), path.join(memberHome, 'projects'));
  const isolated = path.join(base, 'users', '2', '.claude', 'projects');
  mkdirSync(isolated, { recursive: true });
  const operator = path.join(ch, 'projects');
  const legacy = [path.join(core, 'projects')];

  const catalog = buildClaudeRootCatalog(
    [operator, path.join(memberHome, 'projects'), isolated, path.join(base, 'missing', 'projects')], operator, legacy,
  );
  assert.equal(catalog.length, 2, 'missing roots drop out; the linked member joins the operator');
  const [op, member] = catalog;
  assert.equal(op.rootId, OPERATOR_ROOT_ID);
  assert.deepEqual(op.spellings.sort(), [operator, path.join(memberHome, 'projects'), ...legacy].sort());
  assert.match(member.rootId, /^m[0-9a-f]{10}$/);
  assert.ok(!member.spellings.includes(legacy[0]), 'legacy core spellings never reach a member root');
  const again = buildClaudeRootCatalog([isolated], operator).find((entry) => entry.real === isolated);
  assert.equal(again?.rootId, member.rootId, 'member id is deterministic');
});

test('key is identical before and after relocation; candidates cover both spellings', (t) => {
  const { core, ch, transcript } = separatedLayout(t, false);
  const legacy = [path.join(core, 'projects')];
  const [after] = buildClaudeRootCatalog([path.join(ch, 'projects')], path.join(ch, 'projects'), legacy);
  // Pre-separation: the operator root realpaths into the core checkout.
  mkdirSync(path.join(core, 'projects', '-slug'), { recursive: true });
  const before = buildClaudeRootCatalog([path.join(core, 'projects')], path.join(core, 'projects'), legacy)[0];
  const coreFile = path.join(core, 'projects', '-slug', 's.jsonl');

  assert.equal(claudeRelativeSourceKey(after, transcript), 'claude-rel:0/-slug/s.jsonl');
  assert.equal(claudeRelativeSourceKey(before, coreFile), 'claude-rel:0/-slug/s.jsonl');
  assert.deepEqual(new Set(legacySourceKeyCandidates(after, transcript)), new Set([transcript, coreFile]));
});

test('governance dir: env override, then the real NASSAJ.md of ~/.claude, then ~/nassaj-core', (t) => {
  const { base, core, ch } = separatedLayout(t, false);
  const previousHome = process.env.HOME;
  t.after(() => { process.env.HOME = previousHome; });
  process.env.HOME = base;
  assert.equal(resolveGovernanceDir({ NASSAJ_GOVERNANCE_DIR: '/g/x' }), '/g/x');
  assert.equal(resolveGovernanceDir({}), path.join(base, 'nassaj-core'));
  writeFileSync(path.join(core, 'NASSAJ.md'), 'x');
  symlinkSync(path.join(core, 'NASSAJ.md'), path.join(ch, 'NASSAJ.md'));
  assert.equal(resolveGovernanceDir({}), core);
});

test('L1: a member root id comes from its own config-dir literal; link spellings never move it', (t) => {
  const { base, ch } = separatedLayout(t, false);
  const own = path.join(base, 'users', '2', '.claude', 'projects');
  mkdirSync(own, { recursive: true });
  const alias = path.join(base, 'a-alias-projects'); // sorts before `own`
  symlinkSync(own, alias);
  const operator = path.join(ch, 'projects');
  const idOf = (literals: string[]) => buildClaudeRootCatalog(literals, operator).find((entry) => entry.real === own)?.rootId;
  const baseline = idOf([own]);
  assert.match(baseline ?? '', /^m[0-9a-f]{10}$/);
  assert.equal(idOf([own, alias]), baseline, 'adding a spelling keeps the id');
  assert.equal(idOf([alias, own]), baseline, 'order is irrelevant');
  assert.equal(idOf([own]), baseline, 'removing it again keeps the id');
});

test('M1: the stored path is checked before any root list is built', (t) => {
  const { core, ch, transcript } = separatedLayout(t, false);
  const provider = lists([path.join(ch, 'projects')], [path.join(core, 'projects')]);
  assert.deepEqual(locateClaudeTranscript(transcript, provider), { state: 'present', path: transcript });
  assert.equal(provider.calls, 0);
  locateClaudeTranscript(path.join(core, 'projects', '-slug', 's.jsonl'), provider);
  assert.equal(provider.calls, 1);
});
