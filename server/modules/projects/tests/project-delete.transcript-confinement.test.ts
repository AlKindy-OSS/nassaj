/**
 * B-1596 — project force-delete removes transcripts only through the confined
 * deletion primitive (removeSessionTranscript), driven through the real entry
 * point `deleteOrArchiveProject(projectId, true)`.
 *
 * Sandbox: a /var/tmp HOME with the operator trees and two members, /1 and
 * /10 (the prefix trap). The project being deleted belongs to member 1; every
 * "victim" file lives in member 10's tree (or outside every tree) and is made
 * as admissible as possible (named `<id>.jsonl`, header carrying the id), so
 * only confinement, pinning and binding keep it. Headers are the redacted
 * real-transcript fixtures (services/__fixtures__/session-share, B-1520).
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
// eslint-disable-next-line import-x/order -- must evaluate before every other import
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getConnection, initializeDatabase, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
// eslint-disable-next-line boundaries/dependencies -- fixture layout constant, as in adr201-sandbox.e2e
import { AGY_BRAIN_UNDER_HOME } from '@/modules/providers/list/antigravity/agy-brain-layout.js';
import { deleteOrArchiveProject } from '@/modules/projects/services/project-delete.service.js';
import { AppError } from '@/shared/utils.js';
import { setProviderSharingConfig } from '@/services/provider-sharing.js';

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
// T-1880: the pre-separation operator spelling `$CORE_DIR/projects` lives in the sandbox too.
process.env.NASSAJ_GOVERNANCE_DIR = path.join(SANDBOX_HOME, 'nassaj-core');
const FIXTURES = path.join(import.meta.dirname, '..', '..', '..', 'services', '__fixtures__', 'session-share');
const CLAUDE_FIXTURE_ID = '00000000-0000-4000-a000-000000000013';
const CODEX_FIXTURE_ID = '00000000-0000-7000-9000-000000000001';
const USERS = path.join(SANDBOX_HOME, '.nassaj-users');
const CLAUDE_PROJECT = '-home-operator-Project-Confinement';

await initializeDatabase();
const ownerId = userDb.createUser('delete-owner', 'hash-o', 'user').id;
// Members up to /10 exist and Claude is isolated, so every member's Claude home is a T-1880 lookup root.
for (let filler = 2; userDb.createUser(`delete-member-${filler}`, 'hash', 'user').id < 10; filler += 1);
setProviderSharingConfig({ claude: 'isolated' });

let counter = 0;
/** A fresh id in the fixture's UUID shape. */
function nextId(prefix = '00000000-0000-4000-a000-'): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(12, '0')}`;
}

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const claudeText = (id: string): string =>
  fs.readFileSync(path.join(FIXTURES, 'claude.jsonl'), 'utf8').replaceAll(CLAUDE_FIXTURE_ID, id);
const codexText = (id: string): string =>
  fs.readFileSync(path.join(FIXTURES, 'codex.jsonl'), 'utf8').replaceAll(CODEX_FIXTURE_ID, id);
const agyText = (): string => fs.readFileSync(path.join(FIXTURES, 'antigravity.jsonl'), 'utf8');

const memberProjects = (member: string): string => path.join(USERS, member, '.claude', 'projects');
const memberClaude = (member: string, id: string, project = CLAUDE_PROJECT): string =>
  path.join(memberProjects(member), project, `${id}.jsonl`);
const operatorClaude = (id: string): string => path.join(SANDBOX_HOME, '.claude', 'projects', CLAUDE_PROJECT, `${id}.jsonl`);
const codexRollout = (id: string): string =>
  path.join(SANDBOX_HOME, '.codex', 'sessions', '2026', '09', '01', `rollout-2026-09-01T17-24-33-${id}.jsonl`);
const agyTranscript = (id: string): string =>
  path.join(SANDBOX_HOME, AGY_BRAIN_UNDER_HOME, id, '.system_generated', 'logs', 'transcript.jsonl');

/** A fresh project row (member 1's workspace) and its path. */
function newProject(): { projectId: string; projectPath: string } {
  const projectPath = path.join(SANDBOX_HOME, 'workspaces', nextId('project-'));
  fs.mkdirSync(projectPath, { recursive: true });
  const created = projectsDb.createProjectPath(projectPath, null, ownerId);
  const projectId = created.project?.project_id;
  assert.ok(projectId, 'project row created');
  return { projectId, projectPath: created.project!.project_path };
}

/** Inserts a session row of `projectPath` directly (the stored value is the attack surface). */
function recordSession(projectPath: string, id: string, provider: string, jsonlPath: string): void {
  getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path, jsonl_path) VALUES (?, ?, ?, ?)')
    .run(id, provider, projectPath, jsonlPath);
}

type DeleteOutcome = Awaited<ReturnType<typeof deleteOrArchiveProject>>;

/** Force-deletes the project and asserts its rows are gone (unchanged row behaviour). */
async function forceDelete(project: { projectId: string; projectPath: string }, ids: string[]): Promise<DeleteOutcome> {
  const outcome = await deleteOrArchiveProject(project.projectId, true);
  assert.equal(projectsDb.getProjectById(project.projectId), null, 'project row deleted');
  for (const id of ids) assert.equal(sessionsDb.getSessionById(id), null, `session row ${id} deleted`);
  return outcome;
}

/** A victim transcript in member 10's tree, named and headed for `id`. */
function victimIn10(id: string, project = CLAUDE_PROJECT): string {
  return write(memberClaude('10', id, project), claudeText(id));
}

function assertIntact(file: string, text: string, links = 1): void {
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'victim content intact');
  assert.equal(fs.statSync(file).nlink, links, 'victim link count unchanged');
}

test('legitimate delete removes each session transcript (operator, /1, /10, codex, agy) and nothing else', async () => {
  const project = newProject();
  const ids = { op: nextId(), m1: nextId(), m10: nextId(), codex: nextId('00000000-0000-7000-9000-'), agy: nextId() };
  const files = {
    op: write(operatorClaude(ids.op), claudeText(ids.op)),
    m1: write(memberClaude('1', ids.m1), claudeText(ids.m1)),
    m10: write(memberClaude('10', ids.m10), claudeText(ids.m10)),
    codex: write(codexRollout(ids.codex), codexText(ids.codex)),
    agy: write(agyTranscript(ids.agy), agyText()),
  };
  recordSession(project.projectPath, ids.op, 'claude', files.op);
  recordSession(project.projectPath, ids.m1, 'claude', files.m1);
  recordSession(project.projectPath, ids.m10, 'claude', files.m10);
  recordSession(project.projectPath, ids.codex, 'codex', files.codex);
  recordSession(project.projectPath, ids.agy, 'antigravity', files.agy);
  const bystander = write(memberClaude('1', nextId()), claudeText('bystander'));
  await forceDelete(project, Object.values(ids));
  for (const [key, file] of Object.entries(files)) assert.equal(fs.existsSync(file), false, `${key} transcript removed`);
  assert.equal(fs.existsSync(bystander), true, 'an unrelated transcript in the same directory stays');
  assert.equal(fs.readdirSync(path.dirname(files.m1)).some((name) => name.includes('nassaj-removing')), false);
});

test('a forged jsonl_path into another member\'s tree (or outside every tree) is not deleted', async () => {
  const project = newProject();
  const victimId = nextId();
  const victim = victimIn10(victimId);
  const stranger = write(path.join(USERS, '10', 'notes.txt'), 'member 10 private notes\n');
  const forgedA = nextId();
  const forgedB = nextId();
  recordSession(project.projectPath, forgedA, 'claude', victim);
  recordSession(project.projectPath, forgedB, 'claude', path.join(memberProjects('1'), '..', '..', '..', '10', 'notes.txt'));
  await forceDelete(project, [forgedA, forgedB]);
  assertIntact(victim, claudeText(victimId));
  assertIntact(stranger, 'member 10 private notes\n');
});

test('a symlink at the recorded name is neither followed nor removed', async () => {
  const project = newProject();
  const id = nextId();
  const victim = victimIn10(id, '-victim-name-link');
  const recorded = memberClaude('1', id, '-name-link');
  fs.mkdirSync(path.dirname(recorded), { recursive: true });
  fs.symlinkSync(victim, recorded);
  recordSession(project.projectPath, id, 'claude', recorded);
  await forceDelete(project, [id]);
  assertIntact(victim, claudeText(id));
  assert.equal(fs.lstatSync(recorded).isSymbolicLink(), true, 'the planted link is refused, not removed');
});

test('a symlink at the parent directory does not reach member 10', async () => {
  const project = newProject();
  const id = nextId();
  const victim = victimIn10(id, '-victim-dir-link');
  fs.mkdirSync(memberProjects('1'), { recursive: true });
  fs.symlinkSync(path.dirname(victim), path.join(memberProjects('1'), '-dir-link'));
  recordSession(project.projectPath, id, 'claude', memberClaude('1', id, '-dir-link'));
  await forceDelete(project, [id]);
  assertIntact(victim, claudeText(id));
});

test('a symlink at the member root (/1 → /10) is not followed', async () => {
  const project = newProject();
  const id = nextId();
  const victim = victimIn10(id, '-victim-root-link');
  // Member 1's own projects root becomes a link to member 10's for this case only.
  const root1 = memberProjects('1');
  fs.mkdirSync(root1, { recursive: true });
  const aside = `${root1}.aside`;
  fs.renameSync(root1, aside);
  fs.symlinkSync(memberProjects('10'), root1);
  try {
    recordSession(project.projectPath, id, 'claude', memberClaude('1', id, '-victim-root-link'));
    await forceDelete(project, [id]);
  } finally {
    fs.unlinkSync(root1);
    fs.renameSync(aside, root1);
  }
  assertIntact(victim, claudeText(id));
});

test('a hardlink at the recorded name is refused', async () => {
  const project = newProject();
  const id = nextId();
  const victim = victimIn10(id, '-victim-hardlink');
  const recorded = memberClaude('1', id, '-hardlink');
  fs.mkdirSync(path.dirname(recorded), { recursive: true });
  fs.linkSync(victim, recorded);
  recordSession(project.projectPath, id, 'claude', recorded);
  await forceDelete(project, [id]);
  assertIntact(victim, claudeText(id), 2);
  assert.equal(fs.existsSync(recorded), true, 'the hardlinked name is left in place');
});

test('a header id mismatch is not deleted', async () => {
  const project = newProject();
  const id = nextId();
  const other = nextId();
  const recorded = write(memberClaude('1', id, '-mismatch'), claudeText(other));
  recordSession(project.projectPath, id, 'claude', recorded);
  await forceDelete(project, [id]);
  assertIntact(recorded, claudeText(other));
});

/**
 * Runs `swap` once, right before the first by-name rename or unlink the delete
 * performs (the check-to-unlink window), then lets the real call proceed.
 */
async function withSwapBeforeRemoval(swap: () => void, run: () => Promise<void>): Promise<void> {
  const promises = fs.promises as unknown as Record<'rename' | 'unlink', (...args: unknown[]) => Promise<void>>;
  const original = { rename: promises.rename, unlink: promises.unlink };
  let fired = false;
  const wrap = (name: 'rename' | 'unlink') => (...args: unknown[]) => {
    if (!fired) { fired = true; swap(); }
    return original[name].apply(fs.promises, args);
  };
  promises.rename = wrap('rename');
  promises.unlink = wrap('unlink');
  try {
    await run();
  } finally {
    Object.assign(promises, original);
  }
  assert.equal(fired, true, 'the swap ran inside the removal window');
}

test('race: the parent directory swapped for a link to /10 between check and unlink deletes nothing foreign', async () => {
  const project = newProject();
  const id = nextId();
  const victim = victimIn10(id, '-race-dir');
  const recorded = write(memberClaude('1', id, '-race-dir'), claudeText(id));
  recordSession(project.projectPath, id, 'claude', recorded);
  const parked = `${path.dirname(recorded)}.moved`;
  await withSwapBeforeRemoval(() => {
    fs.renameSync(path.dirname(recorded), parked);
    fs.symlinkSync(path.dirname(victim), path.dirname(recorded));
  }, () => forceDelete(project, [id]));
  assertIntact(victim, claudeText(id));
  assert.equal(fs.existsSync(path.join(parked, `${id}.jsonl`)), false, 'the pinned directory\'s own transcript is removed');
});

test('race: the name swapped for a link to a /10 file between check and unlink deletes nothing foreign', async () => {
  const project = newProject();
  const id = nextId();
  const victim = victimIn10(id, '-race-name');
  const recorded = write(memberClaude('1', id, '-race-name'), claudeText(id));
  recordSession(project.projectPath, id, 'claude', recorded);
  await withSwapBeforeRemoval(() => {
    const staging = `${recorded}.staging`;
    fs.linkSync(victim, staging);
    fs.renameSync(staging, recorded);
  }, () => forceDelete(project, [id]));
  assertIntact(victim, claudeText(id), 2);
  assert.equal(fs.statSync(recorded).ino, fs.statSync(victim).ino, 'the swapped-in link is put back, not removed');
});

/** Collects `console.warn` calls made while `run` executes. */
async function captureWarnings(run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const original = console.warn;
  const seen: Array<Record<string, unknown>> = [];
  console.warn = (...args: unknown[]) => { seen.push((args[1] ?? {}) as Record<string, unknown>); };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return seen;
}

/** Patches one `fs.promises` method for the duration of `run`. */
async function withPatchedFs<T>(
  name: 'unlink' | 'link' | 'open', patch: (original: (...args: unknown[]) => Promise<unknown>) => (...args: unknown[]) => Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const promises = fs.promises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = promises[name];
  promises[name] = patch((...args) => original.apply(fs.promises, args));
  try {
    return await run();
  } finally {
    promises[name] = original;
  }
}

const eio = (): Error => Object.assign(new Error('synthetic EIO'), { code: 'EIO' });

test('T6: a refused file produces exactly one warning', async () => {
  const project = newProject();
  const id = nextId();
  recordSession(project.projectPath, id, 'claude', write(memberClaude('1', id, '-one-warning'), claudeText(nextId())));
  const warnings = await captureWarnings(() => forceDelete(project, [id]));
  const forId = warnings.filter((warning) => warning.sessionId === id);
  assert.equal(forId.length, 1, JSON.stringify(warnings));
  assert.equal(forId[0].reason, 'id_mismatch');
});

test('M3/T-1880: a legacy-spelled row removes the file at its current operator location', async () => {
  const project = newProject();
  const id = nextId();
  const current = write(operatorClaude(id), claudeText(id));
  const legacy = path.join(process.env.NASSAJ_GOVERNANCE_DIR!, 'projects', CLAUDE_PROJECT, `${id}.jsonl`);
  recordSession(project.projectPath, id, 'claude', legacy);
  await forceDelete(project, [id]);
  assert.equal(fs.existsSync(current), false, 'the relocated transcript is removed');
});

test('M3/T-1880: a legacy-spelled row never removes the same file under member root /10', async () => {
  const project = newProject();
  const id = nextId();
  const victim = victimIn10(id);
  const legacy = path.join(process.env.NASSAJ_GOVERNANCE_DIR!, 'projects', CLAUDE_PROJECT, `${id}.jsonl`);
  recordSession(project.projectPath, id, 'claude', legacy);
  const warnings = await captureWarnings(() => forceDelete(project, [id]));
  assertIntact(victim, claudeText(id));
  // The lookup does find the /10 copy (Claude is isolated); confinement to the operator tree refuses it.
  assert.deepEqual(warnings.filter((warning) => warning.sessionId === id).map((warning) => warning.reason), ['outside_tree']);
});

test('M1: a transient admission failure refuses the delete with 409 before anything is committed', async () => {
  const project = newProject();
  const id = nextId();
  const file = write(memberClaude('1', id, '-transient'), claudeText(id));
  recordSession(project.projectPath, id, 'claude', file);
  await withPatchedFs('open', (open) => async (...args) => {
    if (args[0] === file) throw eio();
    return open(...args);
  }, async () => {
    await assert.rejects(() => deleteOrArchiveProject(project.projectId, true),
      (error: unknown) => error instanceof AppError && error.statusCode === 409);
  });
  assert.notEqual(projectsDb.getProjectById(project.projectId), null, 'project row kept for a retry');
  assert.notEqual(sessionsDb.getSessionById(id), null, 'session row kept for a retry');
  assert.equal(fs.existsSync(file), true);
  await forceDelete(project, [id]);
  assert.equal(fs.existsSync(file), false, 'the retry removes it');
});

test('M1/M4: a failure after the commit is reported, and the file stays visible at its name', async () => {
  const project = newProject();
  const id = nextId();
  const file = write(memberClaude('1', id, '-post-commit'), claudeText(id));
  recordSession(project.projectPath, id, 'claude', file);
  let failures = 1; // one transient failure: the unlink of the parked name
  const outcome = await withPatchedFs('unlink', (unlink) => async (...args) => {
    if (String(args[0]).includes('nassaj-removing') && failures-- > 0) throw eio();
    return unlink(...args);
  }, () => forceDelete(project, [id]));
  assert.deepEqual(outcome?.transcripts, { removed: 0, keptForSafety: 0, failed: 1 });
  assert.equal(fs.readFileSync(file, 'utf8'), claudeText(id), 'restored at its own name');
  assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.includes('nassaj-removing')), false);
});

test('M1: the outcome counts removed and refused-for-safety transcripts', async () => {
  const project = newProject();
  const ok = nextId();
  const forged = nextId();
  recordSession(project.projectPath, ok, 'claude', write(memberClaude('1', ok, '-counts'), claudeText(ok)));
  recordSession(project.projectPath, forged, 'claude', victimIn10(nextId(), '-counts-victim'));
  const outcome = await forceDelete(project, [ok, forged]);
  assert.deepEqual(outcome?.transcripts, { removed: 1, keptForSafety: 1, failed: 0 });
});

/**
 * Cursor agent transcript layout (cursor-session-synchronizer): the chat lives at
 * `<home>/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` beside
 * `<slug>/worker.log`; its first record is the user turn and carries no id.
 * No Cursor transcript or Cursor row exists on this host (checked read-only on
 * 2026-10-13), so this header follows the shape the synchronizer and the
 * history parser read (`role`, `message.content[0].text` in `<user_query>`).
 */
const cursorText = (): string => `${JSON.stringify({
  role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nREDACTED\n</user_query>' }] },
})}\n${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'REDACTED' }] } })}\n`;
const cursorChat = (home: string, slug: string, id: string): string =>
  path.join(home, '.cursor', 'projects', slug, 'agent-transcripts', id, `${id}.jsonl`);

test('M2: a cursor transcript in the operator tree is removed; wrong layout, name or header is not', async () => {
  const project = newProject();
  const ok = nextId();
  const wrongDir = nextId();
  const noHeader = nextId();
  const flat = nextId();
  const files = {
    ok: write(cursorChat(SANDBOX_HOME, 'p-cursor', ok), cursorText()),
    wrongDir: write(path.join(SANDBOX_HOME, '.cursor', 'projects', 'p-cursor', 'agent-transcripts', 'other', `${wrongDir}.jsonl`), cursorText()),
    noHeader: write(cursorChat(SANDBOX_HOME, 'p-cursor', noHeader), '{"type":"summary"}\n'),
    flat: write(path.join(SANDBOX_HOME, '.cursor', 'projects', 'p-cursor', `${flat}.jsonl`), cursorText()),
  };
  recordSession(project.projectPath, ok, 'cursor', files.ok);
  recordSession(project.projectPath, wrongDir, 'cursor', files.wrongDir);
  recordSession(project.projectPath, noHeader, 'cursor', files.noHeader);
  recordSession(project.projectPath, flat, 'cursor', files.flat);
  await forceDelete(project, [ok, wrongDir, noHeader, flat]);
  assert.equal(fs.existsSync(files.ok), false, 'the bound cursor transcript is removed');
  for (const key of ['wrongDir', 'noHeader', 'flat'] as const) assert.equal(fs.existsSync(files[key]), true, key);
});

test('M2: a cursor row pointing into member /10 or through a symlinked chat dir is not removed', async () => {
  const project = newProject();
  const id = nextId();
  const linked = nextId();
  const victim = write(cursorChat(path.join(USERS, '10'), 'p-cursor', id), cursorText());
  const victimLinked = write(cursorChat(path.join(USERS, '10'), 'p-cursor', linked), cursorText());
  const operatorTranscripts = path.join(SANDBOX_HOME, '.cursor', 'projects', 'p-cursor-link', 'agent-transcripts');
  fs.mkdirSync(operatorTranscripts, { recursive: true });
  fs.symlinkSync(path.dirname(victimLinked), path.join(operatorTranscripts, linked));
  // The synchronizer records only the operator's Cursor tree, so a member path is never admitted.
  recordSession(project.projectPath, id, 'cursor', victim);
  recordSession(project.projectPath, linked, 'cursor', path.join(operatorTranscripts, linked, `${linked}.jsonl`));
  await forceDelete(project, [id, linked]);
  assert.equal(fs.readFileSync(victim, 'utf8'), cursorText());
  assert.equal(fs.readFileSync(victimLinked, 'utf8'), cursorText());
});

/** Runs `run` with `target` at `mode`, restoring 0o700/0o600 afterwards so the sandbox can be removed. */
async function withMode<T>(target: string, mode: number, run: () => Promise<T>): Promise<T> {
  const restore = fs.statSync(target).isDirectory() ? 0o700 : 0o600;
  fs.chmodSync(target, mode);
  try {
    return await run();
  } finally {
    fs.chmodSync(target, restore);
  }
}

for (const [label, pick, mode] of [
  ['the transcript chmod 000', (file: string) => file, 0o000],
  ['its directory chmod 000', (file: string) => path.dirname(file), 0o000],
  ['its directory read-only (0500)', (file: string) => path.dirname(file), 0o500],
] as const) {
  test(`N1: ${label} cannot block the owner's delete forever; the file is kept for safety`, async () => {
    const project = newProject();
    const id = nextId();
    const file = write(memberClaude('1', id, `-n1-${mode}-${label.length}`), claudeText(id));
    recordSession(project.projectPath, id, 'claude', file);
    const outcome = await withMode(pick(file), mode, () => forceDelete(project, [id]));
    assert.deepEqual(outcome?.transcripts, { removed: 0, keptForSafety: 1, failed: 0 });
    assert.equal(fs.readFileSync(file, 'utf8'), claudeText(id), 'the file is kept');
  });
}

test('B-1607: project delete also removes each session\'s subagents, Codex children and agy brain', async () => {
  const project = newProject();
  const ids = { claude: nextId(), codex: nextId('00000000-0000-7000-9000-'), agy: nextId() };
  const claude = write(memberClaude('1', ids.claude), claudeText(ids.claude));
  const subagent = write(path.join(path.dirname(claude), ids.claude, 'subagents', 'agent-a1.jsonl'),
    `${JSON.stringify({ type: 'user', sessionId: ids.claude })}\n`);
  const codex = write(codexRollout(ids.codex), codexText(ids.codex));
  const childId = nextId('00000000-0000-7000-9000-');
  const child = write(path.join(path.dirname(codex), `rollout-2026-09-01T17-30-00-${childId}.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: { id: childId, session_id: ids.codex, thread_source: 'subagent' } })}\n`);
  const agy = write(agyTranscript(ids.agy), agyText());
  const brain = path.join(SANDBOX_HOME, AGY_BRAIN_UNDER_HOME, ids.agy);
  write(path.join(brain, 'scratch', 'notes.md'), 'n');
  recordSession(project.projectPath, ids.claude, 'claude', claude);
  recordSession(project.projectPath, ids.codex, 'codex', codex);
  recordSession(project.projectPath, ids.agy, 'antigravity', agy);
  const outcome = await forceDelete(project, Object.values(ids));
  assert.deepEqual(outcome.transcripts, { removed: 3, keptForSafety: 0, failed: 0 });
  for (const file of [claude, subagent, codex, child]) assert.equal(fs.existsSync(file), false, path.basename(file));
  assert.equal(fs.existsSync(path.join(path.dirname(claude), ids.claude)), false, 'the session dir is gone');
  assert.equal(fs.existsSync(brain), false, 'the agy brain is gone');
});

test('T8: a project delete reads each Codex rollout header a bounded number of times (shared day index)', async () => {
  const project = newProject();
  const ids = Array.from({ length: 40 }, () => nextId('00000000-0000-7000-9000-'));
  const day = path.join(SANDBOX_HOME, '.codex', 'sessions', '2026', '08', '01');
  ids.forEach((id, index) => {
    const file = write(path.join(day, `rollout-2026-08-01T10-00-${String(index).padStart(2, '0')}-${id}.jsonl`), codexText(id));
    recordSession(project.projectPath, id, 'codex', file);
  });
  const promises = fs.promises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = promises.open;
  let rolloutOpens = 0;
  promises.open = (...args) => {
    if (String(args[0]).includes('rollout-2026-08-01')) rolloutOpens += 1;
    return original.apply(fs.promises, args);
  };
  try {
    const outcome = await forceDelete(project, ids);
    assert.equal(outcome.transcripts?.removed, ids.length);
  } finally {
    promises.open = original;
  }
  // Probe + admission + one index pass ≈ 3 opens per rollout; a per-session scan would be ~40 per rollout.
  assert.ok(rolloutOpens <= ids.length * 4, `rollout opens: ${rolloutOpens}`);
});
