import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  classifyClaudeHeader,
  classifyCodexHeader,
  classifyLocation,
  classifyTree,
  locationId,
  parseArgs,
  resolveDbPath,
  runAudit,
  sniffFormat,
} from './session-source-audit.mjs';

// Fixtures follow the key shapes of real first lines (redacted values).
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const jl = (...objs) => `${objs.map((o) => JSON.stringify(o)).join('\n')}\n`;
const claudeLines = (id, extra = {}) => jl(
  { type: 'ai-title', aiTitle: 'x', sessionId: id },
  { type: 'queue-operation', operation: 'enqueue', timestamp: 't', sessionId: id },
  { parentUuid: null, isSidechain: false, type: 'user', message: {}, uuid: 'u', cwd: '/w', sessionId: id, ...extra },
);
const codexMeta = (id, extra = {}) => jl({
  type: 'session_meta',
  payload: { session_id: id, id, forked_from_id: null, parent_thread_id: null, cwd: '/w', ...extra },
});
const ctx = { home: '/h', usersRoot: '/h/.nassaj-users' };

describe('classifyLocation', () => {
  it('separates member 1 from member 10 (prefix trap)', () => {
    assert.deepEqual(classifyLocation('/h/.nassaj-users/10/.claude/projects/p/a.jsonl', ctx),
      { tree: 'member', memberId: 10, provider: 'claude' });
    assert.equal(classifyLocation('/h/.nassaj-users/1/.codex/sessions/2026/a.jsonl', ctx).memberId, 1);
  });
  it('flags operator, vendor, non-numeric and outside paths', () => {
    assert.equal(classifyLocation('/h/.claude/projects/p/a.jsonl', ctx).tree, 'operator');
    assert.equal(classifyLocation('/h/.nassaj-vendor-sessions/qwen/x/a.jsonl', ctx).provider, 'qwen');
    assert.equal(classifyLocation('/h/.nassaj-users/x1/.claude/projects/a.jsonl', ctx).tree, 'outside');
    assert.equal(classifyLocation('/var/tmp/a.jsonl', ctx).tree, 'outside');
    assert.equal(classifyLocation('/h/.nassaj-users/2/notes/a.jsonl', ctx).tree, 'outside');
  });
});

describe('locationId', () => {
  it('reads the id per provider', () => {
    assert.equal(locationId('claude', `/p/${A}.jsonl`), A);
    assert.equal(locationId('codex', `/s/rollout-2026-07-15T23-38-17-${B}.jsonl`), B);
    assert.equal(locationId('antigravity', `/h/.gemini/antigravity-cli/brain/${C}/.system_generated/logs/transcript.jsonl`), C);
    assert.equal(locationId('codex', '/s/rollout-no-uuid.jsonl'), null);
  });
});

describe('classifyClaudeHeader', () => {
  it('match, other, nassaj fork, resume-like, no id', () => {
    assert.equal(classifyClaudeHeader(claudeLines(A), A).kind, 'match');
    assert.equal(classifyClaudeHeader(claudeLines(B), A).kind, 'other');
    assert.equal(classifyClaudeHeader(claudeLines(B, { forkedFrom: { sessionId: B } }), A).kind, 'nassaj_fork');
    assert.equal(classifyClaudeHeader(claudeLines(B), A, new Set([B])).kind, 'resume_like');
    assert.equal(classifyClaudeHeader(jl({ type: 'user', sessionId: B }, { type: 'user', sessionId: A }), A).kind, 'resume_like');
    assert.equal(classifyClaudeHeader(jl({ type: 'summary', leafUuid: 'l' }), A).kind, 'no_id');
  });
  it('ignores a truncated last line and garbage lines', () => {
    const text = `not json\n${claudeLines(A)}{"type":"user","sessionId":"${B}`;
    const r = classifyClaudeHeader(text, A);
    assert.equal(r.kind, 'match');
    assert.equal(r.distinctIds, 1);
  });
});

describe('classifyCodexHeader', () => {
  it('match, fork, subagent, other, no meta', () => {
    assert.equal(classifyCodexHeader(codexMeta(B), B).kind, 'match');
    assert.equal(classifyCodexHeader(codexMeta(C, { forked_from_id: A }), B).kind, 'fork');
    assert.equal(classifyCodexHeader(codexMeta(C, { parent_thread_id: A }), B).kind, 'subagent');
    assert.equal(classifyCodexHeader(codexMeta(C), B).kind, 'other');
    assert.equal(classifyCodexHeader(claudeLines(A), B).kind, 'no_meta');
    assert.equal(classifyCodexHeader(codexMeta(B, { session_id: A }), B).sessionIdDiffers, true);
  });
});

describe('sniffFormat', () => {
  it('detects claude, codex, unknown', () => {
    assert.equal(sniffFormat(claudeLines(A)), 'claude');
    assert.equal(sniffFormat(codexMeta(B)), 'codex');
    assert.equal(sniffFormat('{"x":1}\n'), 'unknown');
    assert.equal(sniffFormat(''), 'unknown');
  });
});

describe('classifyTree', () => {
  const loc = { tree: 'member', memberId: 10, provider: 'claude' };
  it('accepts own tree and grantor tree, rejects others', () => {
    assert.equal(classifyTree(loc, [{ user_id: 10, attribution: 'spawn' }], [], 'claude'), 'ok');
    assert.equal(classifyTree(loc, [{ user_id: 1, attribution: 'spawn' }], [], 'claude'), 'mismatch');
    const grants = [{ owner_user_id: 10, grantee_user_id: 1, provider: 'claude' }];
    assert.equal(classifyTree(loc, [{ user_id: 1, attribution: 'spawn' }], grants, 'claude'), 'ok');
    assert.equal(classifyTree(loc, [{ user_id: 1, attribution: 'spawn' }], grants, 'codex'), 'mismatch');
  });
  it('agy grants use the gemini unit; provenance rows do not count', () => {
    const agyLoc = { ...loc, provider: 'antigravity' };
    const grants = [{ owner_user_id: 10, grantee_user_id: 1, provider: 'gemini' }];
    assert.equal(classifyTree(agyLoc, [{ user_id: 1, attribution: 'spawn' }], grants, 'antigravity'), 'ok');
    assert.equal(classifyTree(loc, [{ user_id: 10, attribution: 'provenance' }], [], 'claude'), 'no_spawn_participants');
    assert.equal(classifyTree({ tree: 'operator', memberId: null }, [], [], 'claude'), 'not_member_tree');
  });
});

describe('resolveDbPath', () => {
  it('reads DATABASE_PATH and resolves relative to the live root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssa-env-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'X=1\nDATABASE_PATH="data/db.sqlite"\n');
      assert.equal(resolveDbPath(dir), path.join(dir, 'data/db.sqlite'));
      fs.writeFileSync(path.join(dir, '.env'), 'X=1\n');
      assert.throws(() => resolveDbPath(dir), /DATABASE_PATH/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runAudit (sandbox: operator + members 1 and 10)', () => {
  it('classifies every category and never writes to the DB', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssa-'));
    try {
      const home = path.join(root, 'home');
      const users = path.join(home, '.nassaj-users');
      const put = (rel, text) => {
        const p = path.join(home, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
        return p;
      };
      const ok = put(`.nassaj-users/1/.claude/projects/p/${A}.jsonl`, claudeLines(A));
      const forged = put(`.nassaj-users/10/.claude/projects/p/${B}.jsonl`, claudeLines('44444444-4444-4444-8444-444444444444'));
      const relabel = put(`.nassaj-users/1/.codex/sessions/2026/01/01/rollout-x-${C}.jsonl`, codexMeta(C));
      const outside = path.join(root, 'elsewhere', 'x.jsonl');
      fs.mkdirSync(path.dirname(outside), { recursive: true });
      fs.writeFileSync(outside, claudeLines('x'));
      const link = path.join(home, '.nassaj-users/1/.claude/projects/p/link.jsonl');
      fs.symlinkSync(outside, link);
      // Shared physical projects/ (legit case b) and an intermediate-dir hop into another tree.
      put(`.claude/projects/s/${C}.jsonl`, claudeLines(C));
      fs.mkdirSync(path.join(users, '2/.claude'), { recursive: true });
      fs.symlinkSync(path.join(home, '.claude/projects'), path.join(users, '2/.claude/projects'));
      const shared = path.join(users, `2/.claude/projects/s/${C}.jsonl`);
      fs.mkdirSync(path.join(users, '3/.claude/projects'), { recursive: true });
      fs.symlinkSync(path.join(users, '10/.claude/projects/p'), path.join(users, '3/.claude/projects/p'));
      const hop = path.join(users, `3/.claude/projects/p/${B}.jsonl`);
      fs.mkdirSync(path.join(users, 'user-A'));

      const dbPath = path.join(root, 'db.sqlite');
      const w = new DatabaseSync(dbPath);
      w.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, provider TEXT, jsonl_path TEXT);
        CREATE TABLE session_participants (session_id TEXT, user_id INTEGER, attribution TEXT);
        CREATE TABLE provider_credential_grants (owner_user_id INTEGER, grantee_user_id INTEGER, provider TEXT);`);
      const ins = w.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
      ins.run(A, 'claude', ok);
      ins.run(B, 'claude', forged);
      ins.run('r3', 'claude', relabel);
      ins.run('link', 'claude', link);
      ins.run(C, 'claude', shared);
      ins.run('hop', 'claude', hop);
      ins.run('gone', 'codex', path.join(home, '.codex/sessions/missing.jsonl'));
      ins.run('nul', 'opencode', null);
      const part = w.prepare('INSERT INTO session_participants VALUES (?, ?, ?)');
      part.run(A, 1, 'spawn');
      part.run(B, 1, 'spawn');
      w.close();
      const before = fs.statSync(dbPath).mtimeMs;

      const { report, summary } = await runAudit({ dbPath, home, usersRoot: users, maxFiles: 100, timeBudgetMs: 5000 });
      assert.deepEqual(report.idMismatch.claude.match, [A, C]);
      assert.deepEqual(report.idMismatch.claude.other, [B, 'link', 'hop']);
      assert.deepEqual(report.treeMismatch.mismatch, [B]);
      assert.deepEqual(report.treeMismatchDetail, [{ sessionId: B, treeMember: 10, expectedMembers: [1] }]);
      assert.deepEqual(report.providerMismatch.location, ['r3']);
      assert.deepEqual(report.outsideRoots.symlinkFinal, ['link']);
      assert.deepEqual(report.outsideRoots.realpathOutside, ['link']);
      assert.deepEqual(report.outsideRoots.realpathNotClaimedTree, ['hop']);
      assert.deepEqual(report.outsideRoots.info_sharedPhysicalRoot, [C]);
      assert.equal(report.outsideRoots.storedPathOutside, undefined);
      assert.equal(report.meta.nonNumericUserDirs, 1);
      assert.deepEqual(report.meta.sharedRealRoots, [{ provider: 'claude', trees: 2 }]);
      assert.deepEqual(report.missingFile.ENOENT, ['gone']);
      assert.deepEqual(report.coverage.nullPath, ['nul']);
      assert.equal(summary.treeMismatch.mismatch, 1);
      assert.equal(fs.statSync(dbPath).mtimeMs, before);
      const text = JSON.stringify(report);
      assert.ok(!text.includes(home), 'report must not carry paths');
      assert.ok(!JSON.stringify(summary).includes(A), 'summary must not carry ids');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('parseArgs live root', () => {
  it('uses --live-root, then NASSAJ_LIVE_ROOT, then the cwd, with no host default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssa-root-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ssa-other-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_PATH=data/db.sqlite\n');
      const expected = path.join(dir, 'data/db.sqlite');
      assert.equal(parseArgs(['--live-root', dir], { env: {}, cwd: other }).dbPath, expected);
      assert.equal(parseArgs([], { env: { NASSAJ_LIVE_ROOT: dir }, cwd: other }).dbPath, expected);
      assert.equal(parseArgs([], { env: {}, cwd: dir }).dbPath, expected);
      assert.throws(() => parseArgs([], { env: {}, cwd: other }), /ENOENT|DATABASE_PATH/);
      assert.equal(parseArgs(['--db', '/x/db.sqlite'], { env: {}, cwd: other }).dbPath, '/x/db.sqlite');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
