/**
 * ADR-173 rev.3 P3: the transcript bridge, on real temp trees under /var/tmp.
 *
 * A shared writer's CLI resumes from `<writer CLAUDE_CONFIG_DIR>/projects/<enc>/<sid>.jsonl`;
 * the bridge makes that name reach the conversation's one recorded file through file links
 * only (M-d: never a dir link, which would share the creator's memory/), refuses any
 * conflicting node, and permanent delete removes only its own links (condition 6).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { locateClaudeTranscript } from '../claude-projects-roots.js';
import {
  ensureClaudeResumeReachable,
  removeClaudeResumeBridgeLinks,
  type ResumeBridgeDeps,
} from '../claude-resume-bridge.js';

const SID = '4f1c2a7e-0b8d-4c55-9a51-3b0e6f2d9c11';
const PROVEN = '2.1.325';

type Trees = { base: string; cwd: string; enc: string; creator: string; member: string; recorded: string };

/** Creator home with the recorded transcript; member home with a REAL projects dir (M7 drift). */
function trees(t: test.TestContext, sourceEntries: string[] = []): Trees {
  const base = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'nassaj-resume-bridge-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'work', 'overlay-cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const enc = cwd.replace(/[^a-zA-Z0-9-]/gu, '-');
  const creator = path.join(base, 'users', '1', '.claude');
  const member = path.join(base, 'users', '2', '.claude');
  fs.mkdirSync(path.join(creator, 'projects', enc), { recursive: true });
  fs.mkdirSync(path.join(member, 'projects'), { recursive: true });
  const recorded = path.join(creator, 'projects', enc, `${SID}.jsonl`);
  fs.writeFileSync(recorded, `${JSON.stringify({ type: 'user', sessionId: SID })}\n`);
  for (const entry of sourceEntries) fs.mkdirSync(path.join(creator, 'projects', enc, entry));
  return { base, cwd, enc, creator, member, recorded };
}

/** Deps of a shared writer on a proven CLI. */
function deps(overrides: Partial<ResumeBridgeDeps> = {}): Partial<ResumeBridgeDeps> {
  return {
    sharedWritingEnabled: () => true,
    isSharedWriter: async () => true,
    cliVersion: async () => PROVEN,
    audit: () => undefined,
    ...overrides,
  };
}

function input(tr: Trees, configDir = tr.member, sharedResume = true) {
  return { sessionId: SID, recordedJsonlPath: tr.recorded, runCwd: tr.cwd, configDir, sharedResume, userId: 2 };
}

const isLink = (file: string) => fs.lstatSync(file).isSymbolicLink();
const writerFile = (tr: Trees, root = tr.member) => path.join(root, 'projects', tr.enc, `${SID}.jsonl`);

test('M-d: an overlay alone in its recorded dir still gets file links, never a dir link', async (t) => {
  const tr = trees(t, [SID, 'memory']);
  const audits: unknown[] = [];
  const result = await ensureClaudeResumeReachable(input(tr), deps({ audit: (_e, p) => audits.push(p) }));
  assert.equal(result.state, 'linked');
  assert.equal(result.mode, 'file_link');
  const target = path.join(tr.member, 'projects', tr.enc);
  assert.ok(!isLink(target), 'a real writer dir: the creator\'s memory/ is never shared');
  assert.equal(fs.readlinkSync(writerFile(tr)), tr.recorded);
  assert.equal(fs.realpathSync(writerFile(tr)), tr.recorded);
  assert.equal(result.transcriptHome, tr.creator, 'repair uses the recorded file\'s home');
  assert.equal(audits.length, 1, 'shared_write_turn audited');
});

test('M-d: an existing writer dir link, even to the recorded dir, is refused and left alone', async (t) => {
  const tr = trees(t);
  const target = path.join(tr.member, 'projects', tr.enc);
  fs.symlinkSync(path.dirname(tr.recorded), target);
  await assert.rejects(ensureClaudeResumeReachable(input(tr), deps()), { code: 'shared_write_transcript_conflict' });
  assert.equal(fs.readlinkSync(target), path.dirname(tr.recorded));
});

test('C1 / test 7: a shared cwd never yields a dir link, writer dir absent', async (t) => {
  const tr = trees(t, [SID]);
  const result = await ensureClaudeResumeReachable(input(tr), deps());
  assert.equal(result.mode, 'file_link');
  const dir = path.join(tr.member, 'projects', tr.enc);
  assert.ok(fs.lstatSync(dir).isDirectory() && !isLink(dir), 'real mkdir');
  assert.equal(fs.readlinkSync(writerFile(tr)), tr.recorded);
  assert.equal(fs.readlinkSync(path.join(dir, SID)), path.join(path.dirname(tr.recorded), SID),
    'an existing recorded sidecar is linked');
});

test('R4: the bridge never creates <sid>/ in the creator tree; the sidecar is linked only if it exists', async (t) => {
  const tr = trees(t);
  const sidecar = path.join(path.dirname(tr.recorded), SID);
  const first = await ensureClaudeResumeReachable(input(tr), deps());
  assert.equal(first.mode, 'file_link');
  assert.throws(() => fs.lstatSync(sidecar), { code: 'ENOENT' }, 'nothing created in the creator tree');
  const writerSidecar = path.join(tr.member, 'projects', tr.enc, SID);
  assert.throws(() => fs.lstatSync(writerSidecar), { code: 'ENOENT' }, 'no link to an absent sidecar');
  // The writer's CLI then keeps its own subagents in a real <sid>/; the next turn accepts it.
  fs.mkdirSync(writerSidecar);
  fs.mkdirSync(sidecar);
  const again = await ensureClaudeResumeReachable(input(tr), deps());
  assert.equal(again.state, 'reachable');
  assert.ok(!isLink(writerSidecar), 'the writer\'s own sidecar is left as it is');
});

test('R4: a writer <sid> node that is neither its own dir nor the sidecar link is a conflict', async (t) => {
  const tr = trees(t, [SID]);
  fs.mkdirSync(path.join(tr.member, 'projects', tr.enc));
  fs.writeFileSync(path.join(tr.member, 'projects', tr.enc, SID), 'not a dir\n');
  await assert.rejects(ensureClaudeResumeReachable(input(tr), deps()),
    { code: 'shared_write_transcript_conflict' });
});

test('R5: an unproven CLI or a non-writer creates no projects dir in the writer tree', async (t) => {
  const tr = trees(t);
  fs.rmSync(path.join(tr.member, 'projects'), { recursive: true });
  await assert.rejects(ensureClaudeResumeReachable(input(tr), deps({ cliVersion: async () => '9.9.9' })),
    { code: 'shared_writing_cli_unproven' });
  await assert.rejects(ensureClaudeResumeReachable(input(tr), deps({ isSharedWriter: async () => false })),
    { code: 'shared_writing_forbidden' });
  assert.deepEqual(fs.readdirSync(tr.member), [], 'the writer tree is untouched');
  const proven = await ensureClaudeResumeReachable(input(tr), deps());
  assert.equal(proven.mode, 'file_link', 'a proven CLI then creates it');
  assert.equal(fs.realpathSync(writerFile(tr)), tr.recorded);
});

test('C1 / test 7: a shared cwd never yields a dir link, writer dir present', async (t) => {
  const tr = trees(t);
  const dir = path.join(tr.member, 'projects', tr.enc);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'other-session.jsonl'), '{}\n');
  const result = await ensureClaudeResumeReachable(input(tr), deps());
  assert.equal(result.mode, 'file_link');
  assert.ok(!isLink(dir));
  assert.equal(fs.readFileSync(path.join(dir, 'other-session.jsonl'), 'utf8'), '{}\n');
});

test('a conflicting real <sid>.jsonl in the writer tree is refused and left untouched', async (t) => {
  const tr = trees(t);
  fs.mkdirSync(path.join(tr.member, 'projects', tr.enc));
  fs.writeFileSync(writerFile(tr), 'member fork\n');
  await assert.rejects(ensureClaudeResumeReachable(input(tr), deps()), { code: 'shared_write_transcript_conflict' });
  assert.equal(fs.readFileSync(writerFile(tr), 'utf8'), 'member fork\n');
});

test('an existing writer dir link elsewhere is refused, never replaced or followed', async (t) => {
  const tr = trees(t);
  const elsewhere = path.join(tr.base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(tr.member, 'projects', tr.enc));
  await assert.rejects(ensureClaudeResumeReachable(input(tr), deps()),
    { code: 'shared_write_transcript_conflict' });
  assert.equal(fs.readlinkSync(path.join(tr.member, 'projects', tr.enc)), elsewhere);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('unproven CLI version is refused with shared_writing_cli_unproven and creates nothing', async (t) => {
  const tr = trees(t);
  await assert.rejects(ensureClaudeResumeReachable(input(tr), deps({ cliVersion: async () => '9.9.9' })),
    { code: 'shared_writing_cli_unproven' });
  assert.deepEqual(fs.readdirSync(path.join(tr.member, 'projects')), []);
});

test('flag 0: no links even when sharedResume is passed', async (t) => {
  const tr = trees(t);
  const result = await ensureClaudeResumeReachable(input(tr), deps({ sharedWritingEnabled: () => false }));
  assert.equal(result.state, 'not_bridged');
  assert.equal(result.transcriptHome, tr.member);
  assert.deepEqual(fs.readdirSync(path.join(tr.member, 'projects')), []);
});

test('sharedResume false: no links, today\'s behaviour', async (t) => {
  const tr = trees(t);
  const result = await ensureClaudeResumeReachable(input(tr, tr.member, false), deps());
  assert.equal(result.state, 'not_bridged');
  assert.deepEqual(fs.readdirSync(path.join(tr.member, 'projects')), []);
});

test('condition 1: the bridge re-checks the writer itself and refuses a non-writer', async (t) => {
  const tr = trees(t);
  await assert.rejects(ensureClaudeResumeReachable(input(tr), deps({ isSharedWriter: async () => false })),
    { code: 'shared_writing_forbidden' });
  assert.deepEqual(fs.readdirSync(path.join(tr.member, 'projects')), []);
});

test('a recorded file whose dir is not encode(runCwd) is refused for a shared writer', async (t) => {
  const tr = trees(t);
  const wrongCwd = { ...input(tr), runCwd: path.join(tr.base, 'work') };
  await assert.rejects(ensureClaudeResumeReachable(wrongCwd, deps()), { code: 'shared_write_transcript_unavailable' });
});

test('same tree (member projects links to the shared store): reachable, no link, no proof needed', async (t) => {
  const tr = trees(t);
  fs.rmSync(path.join(tr.member, 'projects'), { recursive: true });
  fs.symlinkSync(path.join(tr.creator, 'projects'), path.join(tr.member, 'projects'));
  const result = await ensureClaudeResumeReachable(input(tr), deps({ cliVersion: async () => '9.9.9' }));
  assert.equal(result.state, 'reachable');
  assert.equal(result.mode, 'same_tree');
});

test('idempotent: the second turn finds its own links and creates nothing', async (t) => {
  const tr = trees(t);
  await ensureClaudeResumeReachable(input(tr), deps());
  const again = await ensureClaudeResumeReachable(input(tr), deps());
  assert.equal(again.state, 'reachable');
  assert.equal(again.mode, 'file_link');
});

test('test 4: under an engine pin / ADR-152 grant the link lands in the FINAL projects root', async (t) => {
  const tr = trees(t);
  const derived = path.join(tr.base, 'users', '2', '.claude-engine-glm');
  fs.mkdirSync(derived);
  fs.symlinkSync(path.join(tr.member, 'projects'), path.join(derived, 'projects'));
  const result = await ensureClaudeResumeReachable(input(tr, derived), deps());
  assert.equal(result.mode, 'file_link');
  assert.ok(isLink(path.join(derived, 'projects')), 'derived projects stays a link');
  assert.ok(isLink(writerFile(tr)), 'link in realpath(<final dir>/projects)');
});

test('a bridged resume names the recorded file\'s home as the repair target', async (t) => {
  const tr = trees(t);
  const result = await ensureClaudeResumeReachable(input(tr), deps());
  assert.equal(result.transcriptHome, tr.creator);
});

test('unconfigured authority (no composition root): a shared resume is refused', async (t) => {
  const tr = trees(t);
  const { isSharedWriter: _omitted, ...rest } = deps();
  await assert.rejects(ensureClaudeResumeReachable(input(tr), rest), { code: 'shared_writing_forbidden' });
});

test('L3 / condition 6: permanent delete removes only the bridge links, never through them', async (t) => {
  const tr = trees(t, [SID]);
  await ensureClaudeResumeReachable(input(tr), deps());
  const third = path.join(tr.base, 'users', '3', '.claude');
  fs.mkdirSync(path.join(third, 'projects'), { recursive: true });
  fs.symlinkSync(path.join(tr.base, 'elsewhere'), path.join(third, 'projects', tr.enc));
  const removed = removeClaudeResumeBridgeLinks({
    sessionId: SID, recordedJsonlPath: tr.recorded, configDirs: [tr.creator, tr.member, third],
  });
  assert.equal(removed, 2, 'file link and sidecar link');
  assert.ok(fs.existsSync(tr.recorded), 'creator file intact');
  assert.ok(fs.existsSync(path.join(path.dirname(tr.recorded), SID)), 'creator sidecar intact');
  assert.ok(isLink(path.join(third, 'projects', tr.enc)), 'a foreign link is left alone');
});

test('L3: locateClaudeTranscript never returns a bridge link as a fallback candidate', async (t) => {
  const tr = trees(t);
  await ensureClaudeResumeReachable(input(tr), deps());
  const roots = [path.join(tr.member, 'projects')];
  const lists = () => ({ roots, spellings: roots });
  const stale = path.join(tr.base, 'gone', 'projects', tr.enc, `${SID}.jsonl`);
  assert.deepEqual(locateClaudeTranscript(stale, lists), { state: 'unknown' }, 'a fallback through a link is never returned');
  assert.deepEqual(locateClaudeTranscript(tr.recorded, lists), { state: 'present', path: tr.recorded });
});

test('R6: permanent delete removes the writer dir the bridge created once it is empty', async (t) => {
  const tr = trees(t, [SID]);
  await ensureClaudeResumeReachable(input(tr), deps());
  const dir = path.join(tr.member, 'projects', tr.enc);
  removeClaudeResumeBridgeLinks({ sessionId: SID, recordedJsonlPath: tr.recorded, configDirs: [tr.member] });
  assert.throws(() => fs.lstatSync(dir), { code: 'ENOENT' }, 'the bridge-created dir is gone');
  assert.ok(fs.existsSync(tr.recorded), 'creator file intact');
});

test('R6: a bridge-created dir the CLI also wrote into, or a dir the bridge did not create, stays', async (t) => {
  const used = trees(t);
  await ensureClaudeResumeReachable(input(used), deps());
  const usedDir = path.join(used.member, 'projects', used.enc);
  fs.mkdirSync(path.join(usedDir, 'memory'));
  removeClaudeResumeBridgeLinks({ sessionId: SID, recordedJsonlPath: used.recorded, configDirs: [used.member] });
  assert.ok(fs.existsSync(path.join(usedDir, 'memory')), 'not empty: kept');

  const own = trees(t);
  const ownDir = path.join(own.member, 'projects', own.enc);
  fs.mkdirSync(ownDir);
  await ensureClaudeResumeReachable(input(own), deps());
  removeClaudeResumeBridgeLinks({ sessionId: SID, recordedJsonlPath: own.recorded, configDirs: [own.member] });
  assert.deepEqual(fs.readdirSync(ownDir), [], 'links removed');
  assert.ok(fs.lstatSync(ownDir).isDirectory(), 'a dir the writer already had is never removed');
});

/** A writer tree left with a bridge link from an earlier shared turn (CRIT-1). */
async function staleLinkedTree(t: test.TestContext, mode: 'file_link' | 'dir_link'): Promise<Trees> {
  const tr = trees(t, [SID]);
  if (mode === 'dir_link') {
    fs.symlinkSync(path.dirname(tr.recorded), path.join(tr.member, 'projects', tr.enc));
  } else {
    await ensureClaudeResumeReachable(input(tr), deps());
  }
  return tr;
}

test('CRIT-1: a non-shared resume through a stale bridge file link is refused, never followed', async (t) => {
  const tr = await staleLinkedTree(t, 'file_link');
  const before = fs.readFileSync(tr.recorded, 'utf8');
  await assert.rejects(ensureClaudeResumeReachable(input(tr, tr.member, false), deps()),
    { code: 'shared_writing_forbidden' });
  assert.equal(fs.readFileSync(tr.recorded, 'utf8'), before, 'creator file untouched');
  assert.ok(isLink(writerFile(tr)), 'the link is left as it is (permanent delete owns removal)');
});

test('CRIT-1: a non-shared resume through a stale dir link is refused', async (t) => {
  const tr = await staleLinkedTree(t, 'dir_link');
  await assert.rejects(ensureClaudeResumeReachable(input(tr, tr.member, false), deps()),
    { code: 'shared_writing_forbidden' });
});

test('CRIT-1: flag 0 with a stale bridge link is refused, even with sharedResume', async (t) => {
  const tr = await staleLinkedTree(t, 'file_link');
  await assert.rejects(ensureClaudeResumeReachable(input(tr), deps({ sharedWritingEnabled: () => false })),
    { code: 'shared_writing_forbidden' });
});

test('CRIT-1: a non-shared resume of the writer\'s own recorded transcript (or none) is today\'s no-op', async (t) => {
  const tr = trees(t);
  assert.equal((await ensureClaudeResumeReachable(input(tr, tr.member, false), deps())).state, 'not_bridged');
  fs.mkdirSync(path.join(tr.member, 'projects', tr.enc));
  fs.writeFileSync(writerFile(tr), '{}\n');
  assert.equal((await ensureClaudeResumeReachable(input(tr, tr.member, false), deps())).state, 'not_bridged');
  assert.equal((await ensureClaudeResumeReachable(input(tr, tr.creator, false), deps())).state, 'not_bridged',
    'the creator resuming in his own tree');
});

test('CRIT-1: projects linked to a shared store is not a stale bridge link', async (t) => {
  const tr = trees(t);
  fs.rmSync(path.join(tr.member, 'projects'), { recursive: true });
  fs.symlinkSync(path.join(tr.creator, 'projects'), path.join(tr.member, 'projects'));
  assert.equal((await ensureClaudeResumeReachable(input(tr, tr.member, false), deps())).state, 'not_bridged');
});
