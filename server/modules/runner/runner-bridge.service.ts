/**
 * RUNNER BRIDGE — read runner state, write runner control files
 * ==============================================================
 *
 * Architectural contract: ADR-RUNNER-BRIDGE-001 (alkindy/decisions/).
 *
 * Three-layer separation, files as the ONLY contract, zero direct coupling:
 *
 *  - The runner (repo nassaj-ops, scripts/runner) owns the state machine,
 *    the flock, quota gates, PID reconciliation. It NEVER imports or is called
 *    by nassaj-dev. Its only contact surface is JSON files under
 *    state/<project>/ and projects/registry.json.
 *  - This bridge is the ONLY process allowed to touch the runner's control
 *    files on behalf of the browser. It READS state files and WRITES control
 *    files — one direction only.
 *
 * The join key between the two repos is the filesystem PATH, never a shared
 * database: nassaj-dev resolves projectId -> absolute dir via
 * projectsDb.getProjectPathById(projectId); the bridge matches that dir against
 * the `dir` field of each runner projects/<name>.json to discover the runner
 * project name. No id is shared, no schema is shared, no socket is opened.
 *
 * Resilience contract (mirrors the project-board route): a missing or corrupt
 * runner file NEVER 500s — the read endpoint degrades to { registered: false }
 * or surfaces a per-file error flag.
 */

import path from 'path';
import os from 'os';
import { promises as fsPromises } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

import { projectsDb } from '@/modules/database/index.js';

/**
 * Root of the runner install. Overridable for tests / relocated checkouts via
 * the NASSAJ_RUNNER_ROOT env var; defaults to the canonical nassaj-ops path.
 */
const RUNNER_ROOT =
  process.env.NASSAJ_RUNNER_ROOT ||
  path.join(os.homedir(), 'Project', 'nassaj-ops', 'scripts', 'runner');

const PROJECTS_DIR = () => path.join(RUNNER_ROOT, 'projects');
const STATE_DIR = () => path.join(RUNNER_ROOT, 'state');
const REGISTRY_FILE = () => path.join(PROJECTS_DIR(), 'registry.json');

// ---- file shapes (READ-ONLY mirrors of the runner's own schema v2) ----

/**
 * state/<project>/checkpoint.json — v2 contract (§4 of minwal-v2-design.md).
 * Written atomically by the coordinator (tmp → rename). The bridge reads this
 * ONLY, never writes it.
 */
type CheckpointV2 = {
  schema_version?: string;
  project?: string;
  pointer?: {
    phase?: string;
    cycle?: number;
    active_task_id?: string;
    stage?: string | number;
  };
  progress?: {
    done?: string[];
    remaining?: string[];
    partial?: Record<
      string,
      {
        step?: number;
        step_name?: string;
        agents_done?: string[];
        agents_pending?: string[];
      }
    >;
  };
  open_questions?: string[];
  blocked?: Record<string, string>;
  last_commit?: string;
  last_updated?: string;
};

/**
 * state/<project>/supervisor.json — v2 contract (§4 of minwal-v2-design.md).
 * Written by the supervisor script and the coordinator. The bridge reads this
 * ONLY, never writes it.
 */
type SupervisorV2 = {
  schema_version?: string;
  project?: string;
  session?: {
    pid?: number;
    unit?: string;
    started?: string;
    heartbeat?: string;
    exit_reason?: string | null;
  };
  cycle_stats?: {
    total_cycles?: number;
    last_cycle_duration_s?: number | null;
    tokens_this_session?: number;
    hung_recoveries?: number;
  };
};

/**
 * cycle-history.json — the runner's append-only "journey" log (read-only here).
 * Unchanged from v1: RunnerJourney.tsx reads this file directly.
 * Schema mirror of minwal-journey-brief.md §2.2. The runner accumulates in-flight
 * stage results under a private "_wip" root key which is intentionally NOT part of
 * this type: the bridge surfaces only the public contract (current + cycles), so
 * any internal scratch field is silently ignored.
 */
type CycleStageResult = {
  status?: string;
  model?: string;
  duration_s?: number;
  approved_at?: string;
  approved_by?: string;
};

type CycleRecord = {
  cycle?: number;
  phase_id?: string | null;
  task_id?: string | null;
  task_title?: string;
  status?: 'succeeded' | 'failed' | 'interrupted' | string;
  started_at?: string | null;
  ended_at?: string | null;
  fix_loops?: number;
  stages?: {
    build?: CycleStageResult;
    verify?: CycleStageResult;
    verdict?: CycleStageResult;
    gate?: CycleStageResult;
  };
};

type CycleHistory = {
  $version?: number;
  project?: string;
  updated?: string;
  total_cycles?: number;
  current?: {
    cycle?: number;
    phase_id?: string | null;
    task_id?: string | null;
    stage?: string;
    status?: string;
    started_at?: string | null;
    heartbeat_at?: string | null;
  } | null;
  cycles?: CycleRecord[];
};

/**
 * pending-approvals/<task_id>__<kind>.json — a non-blocking approval request the
 * runner's auto mode drops when it hits a sensitive operation (ADR-RUNNER-AUTO-001).
 * The runner WRITES these cards and keeps going; the owner approves/rejects them
 * later out of band. The bridge READS the cards here and, on approve/reject, writes
 * the corresponding control file under unblock-queue/ (the bridge is the only
 * writer of control files — ADR-RUNNER-BRIDGE-001). Read-only mirror of the
 * runner's own schema; the `id` is the filename without `.json` (= task_id__kind),
 * doubling as the idempotency key.
 */
export type PendingApproval = {
  id: string; // = task_id__kind (idempotency key and file name without .json)
  task_id: string;
  phase_id: string;
  kind: string; // prod-migration | secret | restart | push | sensitive | ...
  reason: string;
  commit?: string | null;
  cycle?: number;
  created_at?: string;
  log_file?: string | null;
};

type RunnerProjectConfig = {
  name?: string;
  dir?: string;
  model?: string;
  threshold?: number;
  config_dir?: string;
  timeouts?: Record<string, number>;
  models?: Record<string, string>;
};

type RegistryEntry = { name: string; enabled: boolean; priority: number };
type Registry = { projects: RegistryEntry[] };

/** Canonicalize a path for stable comparison (trailing slash, dot segments). */
function canonical(p: string): string {
  return path.resolve(p).replace(/\/+$/, '');
}

async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover the runner project NAME whose projects/<name>.json `dir` matches the
 * given absolute project path. Returns null when no runner project targets it
 * (board then degrades to "runner not configured"). Read-only.
 */
export async function findRunnerProjectName(projectPath: string): Promise<string | null> {
  const target = canonical(projectPath);
  let entries: string[];
  try {
    entries = await fsPromises.readdir(PROJECTS_DIR());
  } catch {
    return null; // runner not installed / no projects dir
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry === 'registry.json') {
      continue;
    }
    const cfg = await readJsonOrNull<RunnerProjectConfig>(path.join(PROJECTS_DIR(), entry));
    if (cfg?.dir && canonical(cfg.dir) === target) {
      return cfg.name || entry.replace(/\.json$/, '');
    }
  }
  return null;
}

export type RunnerStatus = {
  registered: boolean;
  /** runner project name (= join key for the WS watcher), null when unregistered */
  name: string | null;
  /** absolute project dir resolved from projectId */
  dir: string | null;
  enabled: boolean | null;
  priority: number | null;
  paused: boolean;
  /**
   * v2: pointer + progress + blocked + last_commit extracted from checkpoint.json.
   * null when the file is absent (coordinator has not written a checkpoint yet).
   */
  checkpoint: CheckpointV2 | null;
  /**
   * v2: session liveness + cycle_stats extracted from supervisor.json.
   * null when the file is absent (supervisor has not started yet).
   */
  supervisor: SupervisorV2 | null;
  /**
   * cycle journey log (cycle-history.json) — current position + completed cycles.
   * null when the file is absent (project that has not run a cycle yet) or
   * unparseable, so the overlay degrades to the cycles-less PhaseTimeline.
   */
  history: CycleHistory | null;
  /** per-stage model map + timeouts surfaced from <name>.json (read-only) */
  config: { model: string | null; models: Record<string, string> | null; threshold: number | null } | null;
  /**
   * non-blocking approval queue (pending-approvals/*.json) the runner's auto mode
   * drops on sensitive operations. Empty array when the dir is absent or every
   * card is corrupt — never 500s, same resilience contract as every other file.
   */
  pendingApprovals: PendingApproval[];
  /**
   * true when checkpoint.json is present but could not be parsed (corrupt write).
   * stateError is intentionally NOT set for a missing supervisor.json, since the
   * supervisor may not have started yet — that is a normal initial state.
   */
  stateError: boolean;
};

/** Path to the per-project state directory for a runner project name. */
function projectStateDir(name: string): string {
  return path.join(STATE_DIR(), name);
}

/** Control / state file paths for a runner project name. */
export function runnerPaths(name: string) {
  const dir = projectStateDir(name);
  return {
    stateDir: dir,
    // v2 primary state files (checkpoint + supervisor — coordinator writes these)
    checkpoint: path.join(dir, 'checkpoint.json'),
    supervisor: path.join(dir, 'supervisor.json'),
    // unchanged: RunnerJourney reads this
    cycleHistory: path.join(dir, 'cycle-history.json'),
    // control files — bridge writes, runner reads (unchanged from v1)
    pause: path.join(dir, 'pause'),
    approveNextPhase: path.join(dir, 'approve-next-phase'),
    pendingApprovalsDir: path.join(dir, 'pending-approvals'),
    unblockQueueDir: path.join(dir, 'unblock-queue'),
  };
}

/** Path to a single pending-approval card by its id (= task_id__kind). */
function pendingApprovalCardPath(name: string, id: string): string {
  return path.join(runnerPaths(name).pendingApprovalsDir, `${id}.json`);
}

/** Path to the unblock-queue control file the bridge writes on approve/reject. */
function unblockQueuePath(name: string, taskId: string): string {
  return path.join(runnerPaths(name).unblockQueueDir, `${taskId}.json`);
}

/**
 * Resolve projectId -> runner project name, returning null when the project is
 * not registered with the runner. Shared by every route below.
 */
export async function resolveRunnerProject(
  projectId: string,
): Promise<{ projectPath: string; name: string } | null> {
  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    return null; // surfaced as 404 by the route
  }
  const name = await findRunnerProjectName(projectPath);
  if (!name) {
    return null; // registered:false — handled by the caller
  }
  return { projectPath, name };
}

/**
 * Build the single merged, resilience-wrapped status object the overlay renders.
 * Reads v2 contract: checkpoint.json + supervisor.json (+ cycle-history.json
 * which is unchanged). Never throws on a missing/corrupt runner file.
 */
export async function readRunnerStatus(projectId: string): Promise<RunnerStatus> {
  const empty: RunnerStatus = {
    registered: false,
    name: null,
    dir: null,
    enabled: null,
    priority: null,
    paused: false,
    checkpoint: null,
    supervisor: null,
    history: null,
    config: null,
    pendingApprovals: [],
    stateError: false,
  };

  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    return empty;
  }

  const name = await findRunnerProjectName(projectPath);
  if (!name) {
    return { ...empty, dir: canonical(projectPath) };
  }

  const paths = runnerPaths(name);
  const registry = await readJsonOrNull<Registry>(REGISTRY_FILE());
  const registryEntry = registry?.projects?.find((p) => p.name === name) ?? null;
  const config = await readJsonOrNull<RunnerProjectConfig>(
    path.join(PROJECTS_DIR(), `${name}.json`),
  );

  // v2: primary state files
  const checkpoint = await readJsonOrNull<CheckpointV2>(paths.checkpoint);
  // supervisor is treated as optional metadata — no stateError for its absence.
  const supervisor = await readJsonOrNull<SupervisorV2>(paths.supervisor);
  // cycle-history.json: unchanged — RunnerJourney reads it.
  // Degrades to null on missing or corrupt (never 500s).
  const history = await readJsonOrNull<CycleHistory>(paths.cycleHistory);
  const pendingApprovals = await readPendingApprovals(name);
  const paused = await fileExists(paths.pause);

  // stateError: checkpoint.json is present but corrupt (coordinator mid-write
  // crash). A missing checkpoint.json is normal (coordinator not yet run).
  const checkpointFilePresent = await fileExists(paths.checkpoint);
  const stateError = checkpointFilePresent && checkpoint === null;

  return {
    registered: true,
    name,
    dir: canonical(projectPath),
    enabled: registryEntry?.enabled ?? null,
    priority: registryEntry?.priority ?? null,
    paused,
    checkpoint,
    supervisor,
    history,
    config: config
      ? {
          model: config.model ?? null,
          models: config.models ?? null,
          threshold: config.threshold ?? null,
        }
      : null,
    pendingApprovals,
    stateError,
  };
}

/**
 * Read the non-blocking approval queue for a runner project. Lists
 * pending-approvals/*.json, parses each card, and skips any that is corrupt or
 * missing its required fields (task_id / kind). A missing dir -> [] (the runner
 * has not dropped any card yet). Never throws — same resilience contract as the
 * rest of the read surface. The `id` is normalized to the filename stem so it
 * always matches the route's :id param even if the card omitted/mismatched it.
 */
export async function readPendingApprovals(name: string): Promise<PendingApproval[]> {
  const dir = runnerPaths(name).pendingApprovalsDir;
  let entries: string[];
  try {
    entries = await fsPromises.readdir(dir);
  } catch {
    return []; // dir absent -> no pending approvals
  }

  const out: PendingApproval[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const card = await readJsonOrNull<Partial<PendingApproval>>(path.join(dir, entry));
    // Skip corrupt cards or cards missing the fields the control write needs.
    if (!card || typeof card.task_id !== 'string' || typeof card.kind !== 'string') {
      continue;
    }
    out.push({
      id: entry.replace(/\.json$/, ''),
      task_id: card.task_id,
      phase_id: typeof card.phase_id === 'string' ? card.phase_id : '',
      kind: card.kind,
      reason: typeof card.reason === 'string' ? card.reason : '',
      commit: card.commit ?? null,
      cycle: typeof card.cycle === 'number' ? card.cycle : undefined,
      created_at: typeof card.created_at === 'string' ? card.created_at : undefined,
      log_file: card.log_file ?? null,
    });
  }
  // Stable order: oldest created_at first so the queue reads top-to-bottom.
  out.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  return out;
}

// ---- CONTROL writes (atomic; one direction: bridge writes, runner reads) ----

/**
 * Atomically merge the `enabled` field of the matched registry entry only.
 *
 * Concurrency (finding B-runner-RMW): the runner also rewrites registry.json
 * (registry_disable / fail_project) atomically under its global flock. Both
 * writes are atomic (temp + rename) but neither side locks the read-modify-write
 * window, so a stale read here could clobber a concurrent runner write to a
 * DIFFERENT entry. We shrink that window to the minimum by re-reading the
 * registry IMMEDIATELY before serializing the write and merging only the single
 * `enabled` field onto the freshest snapshot — never the stale one. The window
 * is now just (re-read -> JSON.stringify -> rename), microseconds wide, and the
 * runner only writes registry on the rare fail path. ADR-RUNNER-BRIDGE-001
 * accepts atomic-merge-on-fresh-read as sufficient here.
 */
async function setRegistryEnabled(name: string, enabled: boolean): Promise<boolean> {
  const probe = await readJsonOrNull<Registry>(REGISTRY_FILE());
  if (!probe?.projects) {
    return false;
  }
  const probeEntry = probe.projects.find((p) => p.name === name);
  if (!probeEntry) {
    return false;
  }
  if (probeEntry.enabled === enabled) {
    return true; // idempotent no-op
  }

  // Re-read the freshest registry right before writing so a runner write that
  // landed during our resolution above is preserved; mutate only our one field.
  const fresh = (await readJsonOrNull<Registry>(REGISTRY_FILE())) ?? probe;
  const freshEntry = fresh.projects?.find((p) => p.name === name);
  if (!freshEntry) {
    return false; // entry vanished between reads (runner removed it) — abort.
  }
  if (freshEntry.enabled === enabled) {
    return true; // someone already set our target value — no-op.
  }
  freshEntry.enabled = enabled;
  await atomicWrite(REGISTRY_FILE(), `${JSON.stringify(fresh, null, 2)}\n`);
  return true;
}

/** Write a file atomically via a temp file + rename (os.replace semantics). */
async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsPromises.writeFile(tmp, contents, 'utf8');
  await fsPromises.rename(tmp, filePath);
}

/** touch: create an empty control file if absent (idempotent). */
async function touch(filePath: string, body?: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWrite(filePath, body ?? '');
}

/** start: enable runner for this project. Returns false when no registry entry. */
export async function startRunner(name: string): Promise<boolean> {
  return setRegistryEnabled(name, true);
}

/** stop: hard-disable the project in the registry. */
export async function stopRunner(name: string): Promise<boolean> {
  return setRegistryEnabled(name, false);
}

/**
 * pause: create the pause control file (runner skips next launch).
 *
 * Pause contract (unified, see prompt): the file's presence == "paused by owner".
 * Its body is optional JSON { reason, by, at }. The supervisor checks this file
 * before any launch (Guard B) and the in-cycle phase loop checks it at each phase
 * boundary, so writing it stops the next cycle without disabling the registry
 * entry. resume (rm) is the single re-arm path. `reason` lets the caller mark how
 * the pause was requested ('ui' for the overlay Stop button, 'force-stop' when it
 * accompanies an immediate scope kill).
 */
export async function pauseRunner(name: string, by?: string, reason?: string): Promise<void> {
  const body = JSON.stringify({
    reason: reason ?? 'ui',
    by: by ?? 'owner',
    at: new Date().toISOString(),
  });
  await touch(runnerPaths(name).pause, body);
}

/** resume: remove the pause control file the bridge created. */
export async function resumeRunner(name: string): Promise<void> {
  await fsPromises.rm(runnerPaths(name).pause, { force: true });
}

/**
 * force-stop: immediate kill of the live runner session + a durable soft pause.
 *
 * Two steps, in this order so the runner cannot respawn a cycle after the kill:
 *   1. Write the pause file (reason: 'force-stop') so the supervisor's NEXT launch
 *      is blocked by Guard B even though the scope is being torn down. Without
 *      this, killing the scope only ends the current cycle; the supervisor could
 *      relaunch on its next tick.
 *   2. systemctl --user stop <unit>, where <unit> is the live systemd scope from
 *      supervisor.json session.unit when present (e.g. 'minwal-<name>.scope'),
 *      else the conventional `minwal-${name}.scope`.
 *
 * The server is a plain node process (NOT the Claude client), so the client-side
 * pm2/systemctl guard does not apply here — execFile is permitted. We use execFile
 * with a parameterized argv (never a shell string) so the unit name cannot inject
 * a command, and never leak systemctl stderr to the caller (generic boolean ok).
 *
 * Returns true when the scope stop succeeded (or the unit was already inactive),
 * false on any error. The pause file is written regardless so re-arm always goes
 * through resume (rm pause) — the single re-arm path for both stop and force-stop.
 */
export async function forceStopRunner(name: string, by?: string): Promise<boolean> {
  // 1. Durable soft pause FIRST, so a relaunch is blocked even if the kill races.
  await pauseRunner(name, by, 'force-stop');

  // 2. Resolve the live scope unit from supervisor.json, else the conventional name.
  const supervisor = await readJsonOrNull<SupervisorV2>(runnerPaths(name).supervisor);
  const liveUnit = supervisor?.session?.unit;
  const unit =
    typeof liveUnit === 'string' && liveUnit.trim() ? liveUnit.trim() : `minwal-${name}.scope`;

  try {
    await execFileAsync('systemctl', ['--user', 'stop', unit]);
    return true;
  } catch (error) {
    // systemctl exits non-zero when the unit is already inactive/not-loaded; that
    // is a benign "already stopped" for our purposes. Treat "not loaded" / "not
    // active" as success, surface everything else as a generic failure (we never
    // leak stderr to the user — the route maps false to a generic 5xx).
    const stderr =
      typeof (error as { stderr?: unknown })?.stderr === 'string'
        ? ((error as { stderr: string }).stderr as string)
        : '';
    const alreadyStopped =
      /not loaded|not[- ]?active|no such unit|not running/i.test(stderr);
    if (alreadyStopped) {
      return true;
    }
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'forceStopRunner: systemctl --user stop failed',
        runner: name,
        unit,
      }),
    );
    return false;
  }
}

/**
 * approve: create approve-next-phase. Caller MUST verify the current stage is
 * awaiting_approval first (409 otherwise) so a stale approval is not consumed
 * by a future awaiting_approval boundary.
 */
export async function approveNextPhase(name: string): Promise<void> {
  await touch(runnerPaths(name).approveNextPhase);
}

// ---- NON-BLOCKING APPROVAL QUEUE control writes (ADR-RUNNER-AUTO-001) ----

/**
 * Read a single pending-approval card by its id. Returns null when the card is
 * absent or corrupt — the route turns that into a 404 so a double-click or a
 * stale browser cannot resolve a card the runner already cleared.
 */
export async function readPendingApproval(
  name: string,
  id: string,
): Promise<PendingApproval | null> {
  const all = await readPendingApprovals(name);
  return all.find((a) => a.id === id) ?? null;
}

/**
 * approve: write the unblock-queue control file the runner consumes, then remove
 * the queue card. The bridge is the ONLY writer of control files (BRIDGE-001).
 * We write the control file FIRST and delete the card SECOND so a crash between
 * the two leaves the approval signalled (safe to re-issue) rather than lost. The
 * control file is keyed by task_id (the runner's unblock contract), atomic via
 * temp+rename. Writes stay strictly under state/ — never docs/project-state.json.
 */
export async function approveApproval(name: string, id: string): Promise<void> {
  const card = await readPendingApproval(name, id);
  if (!card) {
    return; // route already 404'd; defensive no-op.
  }
  const body = JSON.stringify(
    { action: 'approve', task_id: card.task_id, approved_at: new Date().toISOString() },
    null,
    2,
  );
  await touch(unblockQueuePath(name, card.task_id), `${body}\n`);
  await fsPromises.rm(pendingApprovalCardPath(name, id), { force: true });
}

/**
 * reject: write the unblock-queue control file with action "reject" (so the
 * runner records the decision / unblocks on a rejected boundary), then remove
 * the queue card. Same crash-safe order as approve. An optional owner note is
 * passed through for the audit trail. Writes stay strictly under state/.
 */
export async function rejectApproval(name: string, id: string, note?: string): Promise<void> {
  const card = await readPendingApproval(name, id);
  if (!card) {
    return; // route already 404'd; defensive no-op.
  }
  const body = JSON.stringify(
    {
      action: 'reject',
      task_id: card.task_id,
      rejected_at: new Date().toISOString(),
      ...(note ? { note } : {}),
    },
    null,
    2,
  );
  await touch(unblockQueuePath(name, card.task_id), `${body}\n`);
  await fsPromises.rm(pendingApprovalCardPath(name, id), { force: true });
}

export { RUNNER_ROOT, STATE_DIR, PROJECTS_DIR, REGISTRY_FILE };
