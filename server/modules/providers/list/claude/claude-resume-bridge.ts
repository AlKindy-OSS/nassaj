/**
 * claude-resume-bridge — ADR-173 rev.3 P3, the transcript bridge.
 *
 * A Claude conversation has ONE recorded transcript (`sessions.jsonl_path`), never
 * rebound. A shared writer's CLI resumes from `<writer CLAUDE_CONFIG_DIR>/projects/
 * <encoded cwd>/<sid>.jsonl`; when that name does not already reach the recorded file
 * (member trees normally link `projects` to the shared store), the bridge links it with
 * file links only (M-d): a real writer dir holding links `<sid>.jsonl` and, when the
 * recorded `<sid>/` already exists, `<sid>/` (R4: nothing is created in the creator
 * tree). Never a dir link: it would share the creator's per-project `memory/` with the
 * writer's CLI. Both modes are recorded in the P0 proof; only `file_link` is used.
 * An existing different node is refused (`shared_write_transcript_conflict`): nothing is
 * ever replaced, and no existing link is followed for writing. Links are created only
 * for a server-computed `sharedResume` the bridge re-checks itself (qa condition 1), and
 * only with a CLI version whose link mode the P0 proof admits. The link section is one
 * synchronous block (the lock: the server is a single Node process).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as database from '@/modules/database/index.js';
import { canonicalFileSync, openPinnedSync } from '@/modules/providers/shared/pinned-fd.js';
import { isSharedResumeModeProven } from '@/services/isolation/claude-shared-resume-proof.js';

import { encodeClaudeProjectDir } from './claude-project-dir.js';
import { isSharedSessionWritingEnabled } from './shared-session-writing-flag.js';

const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;

export type SharedResumeRefusalCode =
  | 'shared_write_transcript_conflict'
  | 'shared_write_transcript_unavailable'
  | 'shared_writing_cli_unproven'
  | 'shared_writing_forbidden';

const REFUSAL_MESSAGES: Record<SharedResumeRefusalCode, string> = {
  shared_write_transcript_conflict: 'Your Claude history already holds a different copy of this conversation.',
  shared_write_transcript_unavailable: 'This conversation\'s transcript cannot be reached for shared writing.',
  shared_writing_cli_unproven: 'The installed Claude CLI version is not yet proven for shared writing.',
  shared_writing_forbidden: 'You can no longer write in this conversation.',
};

/** A refusal of a shared-writer resume; the run never starts. */
export class SharedResumeRefusal extends Error {
  readonly code: SharedResumeRefusalCode;

  constructor(code: SharedResumeRefusalCode) {
    super(REFUSAL_MESSAGES[code]);
    this.name = 'SharedResumeRefusal';
    this.code = code;
  }
}

export type BridgeMode = 'same_tree' | 'file_link';
type LinkMode = Exclude<BridgeMode, 'same_tree'>;

export type ResumeBridgeInput = {
  sessionId: string;
  recordedJsonlPath: string | null | undefined;
  runCwd: string | null | undefined;
  /** The FINAL env.CLAUDE_CONFIG_DIR of the spawn (engine-pin / grant applied). */
  configDir: string | null | undefined;
  /** Server-computed (chat boundary); anything but `true` creates no link. */
  sharedResume: boolean;
  userId: number | string | null;
};

export type ResumeBridgeResult = {
  state: 'not_bridged' | 'reachable' | 'linked';
  mode?: BridgeMode;
  /** Config home whose projects tree holds the transcript the resume replays (repair target). */
  transcriptHome: string | null;
};

export type ResumeBridgeDeps = {
  sharedWritingEnabled: () => boolean;
  isSharedWriter: (sessionId: string, userId: number | string | null) => Promise<boolean> | boolean;
  cliVersion: () => Promise<string | null>;
  isModeProven: (version: string | null, mode: LinkMode) => boolean;
  audit: (event: 'shared_write_turn', payload: { userId: number | string | null; sessionId: string; mode: BridgeMode; linksCreated: number }) => void;
};

type Recorded = { file: string; dir: string; encDir: string; sidecar: string; home: string };

function realOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * The recorded transcript, opened with the pinned reader (a regular single-link file at
 * its kernel-confirmed realpath) and checked to sit in `<home>/projects/encode(runCwd)`.
 */
function readRecordedTranscript(input: ResumeBridgeInput): Recorded | null {
  const { sessionId, recordedJsonlPath, runCwd } = input;
  if (!SESSION_ID.test(sessionId) || !recordedJsonlPath || !runCwd || !path.isAbsolute(recordedJsonlPath)) return null;
  const file = canonicalFileSync(recordedJsonlPath);
  if (!file || path.basename(file) !== `${sessionId}.jsonl`) return null;
  const dir = path.dirname(file);
  const projects = path.dirname(dir);
  if (path.basename(dir) !== encodeClaudeProjectDir(runCwd) || path.basename(projects) !== 'projects') return null;
  try {
    fs.closeSync(openPinnedSync(file).fd);
  } catch {
    return null;
  }
  return { file, dir, encDir: path.basename(dir), sidecar: path.join(dir, sessionId), home: path.dirname(projects) };
}

/**
 * Marker of a writer dir the bridge itself created (R6): permanent delete removes such a
 * dir only once it holds nothing but this marker. Never guessed from the dir's contents.
 */
const BRIDGE_DIR_MARKER = '.nassaj-resume-bridge';

/** `<configDir>/projects`; no CLAUDE_CONFIG_DIR = the CLI's own default, ~/.claude. */
function writerProjectsPath(configDir: string | null | undefined): string {
  return path.join(configDir?.trim() || path.join(os.homedir(), '.claude'), 'projects');
}

/** realpath of the writer projects dir, created (one level, 0700) only now (R5: after every check). */
function ensureWriterProjectsRoot(projects: string): string | null {
  try {
    fs.mkdirSync(projects, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') return null;
  }
  return realOrNull(projects);
}

/**
 * The writer's encoded dir (under the realpath of its projects root) now: the recorded
 * dir itself (same tree), absent, a real dir of its own, else a conflict — a link
 * included (M-d: no dir link is ever made or followed).
 */
function inspectWriterDir(target: string, recorded: Recorded): BridgeMode | 'absent' {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'absent';
    throw new SharedResumeRefusal('shared_write_transcript_unavailable');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SharedResumeRefusal('shared_write_transcript_conflict');
  return realOrNull(target) === recorded.dir ? 'same_tree' : 'file_link';
}

/** Creates `link` → `expected`, or accepts an existing link with exactly that text; else a conflict. */
function ensureLink(link: string, expected: string): number {
  try {
    fs.symlinkSync(expected, link);
    return 1;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  if (fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === expected) return 0;
  throw new SharedResumeRefusal('shared_write_transcript_conflict');
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The writer's `<sid>/` (R4): nothing is ever created in the creator tree, and the CLI
 * must never create it through a link. Linked only when the recorded sidecar already is
 * a real dir; a real `<sid>/` the writer's CLI made itself is kept as it is (subagent
 * files of those turns stay in the writer's tree). Anything else is a conflict.
 */
function ensureSidecarLink(link: string, sidecar: string): number {
  const own = lstatOrNull(link);
  if (own?.isDirectory()) return 0;
  if (own && !own.isSymbolicLink()) throw new SharedResumeRefusal('shared_write_transcript_conflict');
  if (!own && !lstatOrNull(sidecar)?.isDirectory()) return 0;
  return ensureLink(link, sidecar);
}

/** A real writer dir created by the bridge, marked so permanent delete may remove it (R6). */
function createBridgeDir(target: string): void {
  fs.mkdirSync(target, { mode: 0o700 });
  fs.writeFileSync(path.join(target, BRIDGE_DIR_MARKER), '', { flag: 'wx', mode: 0o600 });
}

/** The synchronous link section: re-inspects, links, re-verifies. Returns links created. */
function applyBridge(root: string, recorded: Recorded, mode: BridgeMode, sessionId: string): number {
  const target = path.join(root, recorded.encDir);
  const now = inspectWriterDir(target, recorded);
  if (now !== 'absent' && now !== mode) throw new SharedResumeRefusal('shared_write_transcript_conflict');
  let created = 0;
  if (mode === 'file_link') {
    if (now === 'absent') createBridgeDir(target);
    created += ensureLink(path.join(target, `${sessionId}.jsonl`), recorded.file);
    created += ensureSidecarLink(path.join(target, sessionId), recorded.sidecar);
  }
  if (realOrNull(path.join(target, `${sessionId}.jsonl`)) !== recorded.file) {
    throw new SharedResumeRefusal('shared_write_transcript_conflict');
  }
  return created;
}

function linkSection(root: string, recorded: Recorded, mode: BridgeMode, sessionId: string): number {
  try {
    return applyBridge(root, recorded, mode, sessionId);
  } catch (error) {
    if (error instanceof SharedResumeRefusal) throw error;
    throw new SharedResumeRefusal(errorCode(error) === 'EEXIST'
      ? 'shared_write_transcript_conflict' : 'shared_write_transcript_unavailable');
  }
}

/** True when `link` is a symlink whose (unfollowed) target lies outside `root`. */
function isLinkOutside(link: string, root: string): boolean {
  let stat: fs.Stats | null;
  try {
    stat = lstatOrNull(link);
  } catch {
    return false;
  }
  if (!stat?.isSymbolicLink()) return false;
  const rel = path.relative(root, path.resolve(path.dirname(link), fs.readlinkSync(link)));
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel);
}

/**
 * CRIT-1: a resume that is not an authorized shared-writer resume (not a shared writer
 * now, or the kill switch is off) must never reach another tree through a bridge link
 * left by an earlier shared turn. lstat only: `<writer projects>/<enc>` or its
 * `<sid>.jsonl` linking outside the writer's own projects tree is refused, never followed.
 */
function refuseStaleBridgeLink(input: ResumeBridgeInput): void {
  if (!SESSION_ID.test(input.sessionId) || !input.runCwd) return;
  const root = realOrNull(writerProjectsPath(input.configDir));
  if (!root) return;
  const encDir = path.join(root, encodeClaudeProjectDir(input.runCwd));
  try {
    if (isLinkOutside(encDir, root) || isLinkOutside(path.join(encDir, `${input.sessionId}.jsonl`), root)) {
      throw new SharedResumeRefusal('shared_writing_forbidden');
    }
  } catch (error) {
    if (error instanceof SharedResumeRefusal) throw error;
    throw new SharedResumeRefusal('shared_write_transcript_unavailable');
  }
}

/**
 * Makes the resume of `sessionId` replay its one recorded transcript (ADR-173 rev.3 §3).
 * Not a shared-writer resume (or the kill switch is off): today's behaviour, except that
 * a stale bridge link in the writer tree is refused (CRIT-1).
 * A shared-writer resume is re-authorized here, then reaches the recorded file through
 * the same tree or bridge links, or is refused with a {@link SharedResumeRefusal}.
 * Never throws anything else.
 */
export async function ensureClaudeResumeReachable(
  input: ResumeBridgeInput,
  overrides: Partial<ResumeBridgeDeps> = {},
): Promise<ResumeBridgeResult> {
  const deps: ResumeBridgeDeps = { ...DEFAULT_DEPS, ...overrides };
  if (input.sharedResume !== true || !deps.sharedWritingEnabled()) {
    refuseStaleBridgeLink(input);
    return { state: 'not_bridged', transcriptHome: input.configDir ?? null };
  }
  const recorded = readRecordedTranscript(input);
  if (!recorded) throw new SharedResumeRefusal('shared_write_transcript_unavailable');
  if (!(await deps.isSharedWriter(input.sessionId, input.userId))) throw new SharedResumeRefusal('shared_writing_forbidden');
  const projects = writerProjectsPath(input.configDir);
  const existingRoot = realOrNull(projects);
  const found = existingRoot ? inspectWriterDir(path.join(existingRoot, recorded.encDir), recorded) : 'absent';
  const mode: BridgeMode = found === 'same_tree' ? 'same_tree' : 'file_link';
  if (mode !== 'same_tree' && !deps.isModeProven(await deps.cliVersion(), mode)) {
    throw new SharedResumeRefusal('shared_writing_cli_unproven');
  }
  const root = existingRoot ?? ensureWriterProjectsRoot(projects);
  if (!root) throw new SharedResumeRefusal('shared_write_transcript_unavailable');
  const linksCreated = linkSection(root, recorded, mode, input.sessionId);
  deps.audit('shared_write_turn', { userId: input.userId, sessionId: input.sessionId, mode, linksCreated });
  return { state: linksCreated > 0 ? 'linked' : 'reachable', mode, transcriptHome: recorded.home };
}

/** Removes `link` only when it IS a symlink whose target is `expected` (lstat, never followed). */
function unlinkIfLinkTo(link: string, expected: string): number {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return 0;
    if (path.resolve(path.dirname(link), fs.readlinkSync(link)) !== expected) return 0;
    fs.unlinkSync(link);
    return 1;
  } catch {
    return 0;
  }
}

function isRealDirectory(target: string): boolean {
  try {
    return fs.lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** R6: removes a bridge-created writer dir holding nothing but its marker (lstat only). */
function removeEmptyBridgeDir(target: string): void {
  try {
    const entries = fs.readdirSync(target);
    if (entries.length !== 1 || entries[0] !== BRIDGE_DIR_MARKER) return;
    if (!fs.lstatSync(path.join(target, BRIDGE_DIR_MARKER)).isFile()) return;
    fs.unlinkSync(path.join(target, BRIDGE_DIR_MARKER));
    fs.rmdirSync(target);
  } catch {
    /* a dir that changed under us is simply kept */
  }
}

/**
 * Permanent delete (qa condition 6, L3): removes the bridge links any config tree holds
 * for this session's recorded transcript — the `<sid>.jsonl` / `<sid>/` links in a real
 * writer dir, then that dir itself when the bridge created it and it is now empty (R6). `configDirs`: every Claude home on the host
 * (listClaudeConfigDirsReadOnly). Never recursive, never through a followed link, never
 * touches anything else. Returns the number of links removed. Never throws.
 */
export function removeClaudeResumeBridgeLinks({
  sessionId, recordedJsonlPath, configDirs,
}: { sessionId: string; recordedJsonlPath: string | null | undefined; configDirs: string[] }): number {
  const file = SESSION_ID.test(sessionId) && recordedJsonlPath ? canonicalFileSync(recordedJsonlPath) : null;
  if (!file) return 0;
  const dir = path.dirname(file);
  let removed = 0;
  for (const configDir of configDirs) {
    const root = realOrNull(path.join(configDir, 'projects'));
    const target = root ? path.join(root, path.basename(dir)) : null;
    if (!target || target === dir || !isRealDirectory(target)) continue;
    removed += unlinkIfLinkTo(path.join(target, `${sessionId}.jsonl`), file);
    removed += unlinkIfLinkTo(path.join(target, sessionId), path.join(dir, sessionId));
    removeEmptyBridgeDir(target);
  }
  return removed;
}

/** The session's recorded `jsonl_path`, or null. Never throws. */
export function recordedClaudeTranscriptPath(sessionId: string): string | null {
  try {
    return database.sessionsDb.getSessionById(sessionId)?.jsonl_path ?? null;
  } catch {
    return null;
  }
}

function auditSharedWriteTurn(_event: 'shared_write_turn', payload: Parameters<ResumeBridgeDeps['audit']>[1]): void {
  const { userId, ...metadata } = payload;
  try {
    database.auditLogDb.record('shared_write_turn', { userId: typeof userId === 'number' ? userId : Number(userId) || null, metadata });
  } catch (error) {
    console.warn('[ADR-173] shared_write_turn audit not recorded', { sessionId: payload.sessionId, error: errorCode(error) ?? 'error' });
  }
}

// The ADR-173 authority lives at the chat boundary; the composition root wires it in, so
// this module never imports the websocket graph. Unconfigured = nobody is a shared writer.
let sharedWriterCheck: ResumeBridgeDeps['isSharedWriter'] = () => false;

/** Composition root: the bridge's own re-check of the writer (qa condition 1). */
export function configureClaudeResumeBridge({ isSharedWriter }: Pick<ResumeBridgeDeps, 'isSharedWriter'>): void {
  sharedWriterCheck = isSharedWriter;
}

const DEFAULT_DEPS: ResumeBridgeDeps = {
  sharedWritingEnabled: () => isSharedSessionWritingEnabled(),
  isSharedWriter: (sessionId, userId) => sharedWriterCheck(sessionId, userId),
  cliVersion: async () => (
    await import('@/modules/providers/harness-update/version-status.service.js')
  ).readInstalledHarnessVersion('claude'),
  isModeProven: (version, mode) => isSharedResumeModeProven(version, mode),
  audit: auditSharedWriteTurn,
};
