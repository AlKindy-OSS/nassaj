/**
 * Project cost & stats routes (mounted at /api/projects by index.js).
 *
 *   GET  /api/projects/:projectId/cost   → what a project's conversations are worth
 *   GET  /api/projects/:projectId/stats  → the same, plus the curve and the groupings
 *   POST /api/projects/cost-ledger/scan  → rebuild the ledger (owner/admin only)
 *
 * WHY A SEPARATE ROUTER FROM projects.routes.ts: that file is the project
 * lifecycle (create / rename / visibility / members / delete). This one reads a
 * different subsystem — the cost ledger — and answers a different envelope. It
 * mounts at the same prefix, after the lifecycle router; Express falls through
 * to it because none of these paths exist there.
 *
 * ── AUTHORIZATION ────────────────────────────────────────────────────────────
 * A project's cost is a property OF the project, so the read gate is the project
 * read gate — `assertProjectVisible`, the same predicate the projects list and
 * the session read path use. No second, home-grown check: a cost surface with
 * its own notion of "may see" is a cost surface that drifts out of agreement
 * with the surface it prices.
 *
 * It refuses with 404 PROJECT_NOT_FOUND, never 403 — identical to the answer for
 * an id that does not exist — so this endpoint cannot be turned into an oracle
 * for which private projects exist (the B-PRIV non-disclosure guarantee). The
 * gate runs BEFORE the ledger is touched, so a caller who may not see a project
 * never causes its ledger rows to be read.
 *
 * ── SCANNING IS NOT ON A GET PATH ───────────────────────────────────────────
 * Building the ledger walks thousands of transcript files. Every GET here reads
 * only what the ledger already holds; a stale ledger answers a stale (and
 * flagged) number rather than blocking a request for minutes. The rebuild is an
 * explicit POST, restricted to owner/admin, because it is expensive I/O that any
 * authenticated member could otherwise trigger in a loop. An explicit endpoint
 * was chosen over a boot/interval trigger: a boot scan re-runs on every
 * `safe-restart` and delays readiness, and an unattended interval burns disk I/O
 * on a machine that is also running agent sessions. (A scheduled trigger can be
 * layered on later — it would call the same service method.)
 *
 * ── ENVELOPE ────────────────────────────────────────────────────────────────
 * Flat (`{ success, cost }` / `{ success, stats }`) rather than the usual
 * `{ success, data }` wrapper, matching the sibling cost surface in
 * `modules/providers/cost.routes.ts`. The rest of the route conventions
 * (Router, asyncHandler, AppError) are unchanged.
 *
 * ── HONESTY (ADR-078) ───────────────────────────────────────────────────────
 * Nothing here invents a number. When the ledger holds no priced rows for a
 * project, `totalUsd` is `null` — "unknown" — and never `0`, which would read as
 * "measured, and it was free". `complete:false` + `unpricedModels` mark a total
 * that is a floor. `agents: null` marks a roster that was never parsed, as
 * distinct from `[]` ("parsed, there were none").
 */

import express, { type Request, type Response } from 'express';

import { sessionAgentsDb, sessionsDb } from '@/modules/database/index.js';
import { assertProjectVisible, coerceUserId } from '@/modules/projects/services/project-visibility-guard.service.js';
// Through the providers BARREL, not its internals: `boundaries/dependencies`
// forbids a cross-module deep import, and the barrel is the contract that keeps
// the pricing engine's file walkers and caches private to that module.
import { costLedgerService, PRICES_AS_OF, vendorDisplayName, type VendorKey } from '@/modules/providers/index.js';
import type {
  ProjectCostScanResponse,
  ProjectCostSummary,
  ProjectStatsAgentRow,
  ProjectStatsDailyPoint,
  ProjectStatsModelRow,
  ProjectStatsSummary,
  ProjectStatsVendorRow,
} from '@/shared/types.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

const router = express.Router();

// Project ids in this repo are opaque slugs derived from the workspace path.
// Syntax only — WHETHER the id names a visible project is the visibility gate's
// judgement, so the two layers cannot drift apart.
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

/** `YYYY-MM-DD`, the ledger's day grain. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type AuthenticatedUser = { id?: number | string; role?: string };

/**
 * Numeric id of the authenticated caller, read from req.user only (populated by
 * authenticateToken at the mount point) — never from request input. A module
 * route must not import server/middleware/**, so the role/id are read in-handler,
 * the same idiom as provider.routes.ts and cost.routes.ts.
 *
 * Fail-closed: an unresolved identity is refused before any project is resolved.
 */
function readAuthenticatedUserId(req: Request): number {
  const userId = coerceUserId((req as Request & { user?: AuthenticatedUser }).user?.id);
  if (userId === null) {
    throw new AppError('Authentication required.', {
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

function readAuthenticatedUserRole(req: Request): string | null {
  return (req as Request & { user?: AuthenticatedUser }).user?.role ?? null;
}

function parseProjectId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!PROJECT_ID_PATTERN.test(raw)) {
    // 400, not 404: a syntactically impossible id discloses nothing, and telling
    // the client its input was malformed is not an existence signal.
    throw new AppError('Invalid projectId.', {
      code: 'INVALID_PROJECT_ID',
      statusCode: 400,
    });
  }
  return raw;
}

/**
 * Optional epoch-ms bound for the daily curve (`?since=` / `?until=`). Absent →
 * undefined (the ledger decides its own default range). Present-but-garbage is
 * rejected rather than silently ignored: a window the caller believes is applied
 * but is not would mislabel the numbers it frames.
 */
function parseEpochMsQuery(value: unknown, name: string): number | undefined {
  const raw = typeof value === 'string' ? value.trim() : Array.isArray(value) ? String(value[0] ?? '').trim() : '';
  if (raw === '') {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AppError(`${name} must be an epoch-milliseconds integer.`, {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }
  return Math.trunc(parsed);
}

// ---------------------------------------------------------------------------
// Ledger readers
//
// The ledger service is a sibling module owned elsewhere. Its answers are read
// through these narrow accessors rather than being spread into the response, for
// one reason that is a correctness rule and not style: an absent or unreadable
// field must become `null` ("unknown"), never `0`. Reading `?? 0` anywhere in
// this file would be the ADR-078 violation — a gap in the data rendered as a
// measurement. So: numbers survive only when they really are finite numbers.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A finite number, or `null` for anything else. Never substitutes 0. */
function readNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A count: a non-negative integer, defaulting to 0. Only for COUNTS, never money. */
function readCount(value: unknown): number {
  const parsed = readNullableNumber(value);
  return parsed !== null && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A `YYYY-MM-DD` day, or null. Anything else is not a day and is not guessed at. */
function readDay(value: unknown): string | null {
  const raw = readNonEmptyString(value);
  return raw !== null && DAY_PATTERN.test(raw) ? raw : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => readNonEmptyString(entry)).filter((entry): entry is string => entry !== null);
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * `complete` defaults to FALSE when the ledger does not say. Unknown
 * completeness is reported as incomplete, so the UI errs toward "partial" and
 * never toward an unearned claim of a whole figure.
 */
function readComplete(value: unknown): boolean {
  return value === true;
}

function readDailyPoints(value: unknown): ProjectStatsDailyPoint[] {
  const points: ProjectStatsDailyPoint[] = [];
  for (const entry of toArray(value)) {
    const row = asRecord(entry);
    const day = readDay(row.day);
    const costUsd = readNullableNumber(row.costUsd);
    // A point with no day cannot be plotted, and a point with no cost is not a
    // zero-cost day — both are dropped rather than rendered as a false flat line.
    if (day !== null && costUsd !== null) {
      points.push({ day, costUsd });
    }
  }
  return points;
}

function readVendorRows(value: unknown): ProjectStatsVendorRow[] {
  const rows: ProjectStatsVendorRow[] = [];
  for (const entry of toArray(value)) {
    const row = asRecord(entry);
    const vendor = readNonEmptyString(row.vendor);
    if (vendor === null) {
      continue;
    }
    rows.push({
      vendor,
      // The ledger may already carry a label; otherwise the shared vendor map
      // supplies it, so the UI never has to invent a display name. The cast is
      // safe by construction: vendorDisplayName falls back to the key itself for
      // any vendor the label map does not know.
      displayName: readNonEmptyString(row.displayName) ?? vendorDisplayName(vendor as VendorKey),
      totalUsd: readNullableNumber(row.totalUsd),
      requests: readCount(row.requests),
    });
  }
  return rows;
}

function readModelRows(value: unknown): ProjectStatsModelRow[] {
  const rows: ProjectStatsModelRow[] = [];
  for (const entry of toArray(value)) {
    const row = asRecord(entry);
    const model = readNonEmptyString(row.model);
    if (model === null) {
      continue;
    }
    rows.push({
      model,
      totalUsd: readNullableNumber(row.totalUsd),
      requests: readCount(row.requests),
    });
  }
  return rows;
}

/**
 * The project's non-human actors, read from the session-agents CACHE only —
 * `sessionAgentsDb.aggregateBySessionIds`, the same aggregate the participants
 * module already exposes for a project.
 *
 * Deliberately NOT `participantsService.getProjectParticipants`: that one parses
 * every transcript on demand before aggregating, which is exactly the file walk
 * this GET must not do. Cache-only is the right trade here — the roster is a
 * decoration on a cost page, not the cost itself.
 *
 * Returns `null` (unknown) when no session of this project has ever been parsed,
 * so an unparsed project is never shown an authoritative empty roster.
 */
function readProjectAgents(projectPath: string): ProjectStatsAgentRow[] | null {
  const sessions = sessionsDb.getSessionsByProjectPath(projectPath);
  const sessionIds = sessions.map((session) => session.session_id);
  if (sessionIds.length === 0) {
    return null;
  }

  const everParsed = sessionIds.some((sessionId) => sessionAgentsDb.getMeta(sessionId) !== null);
  if (!everParsed) {
    return null;
  }

  return sessionAgentsDb
    .aggregateBySessionIds(sessionIds)
    .map((agent) => ({ name: agent.agent_name, invocations: readCount(agent.invocation_count) }));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /api/projects/cost-ledger/scan
 *
 * Declared BEFORE the `/:projectId/…` routes so `cost-ledger` can never be
 * captured as a project id (the same ordering discipline provider.routes.ts uses
 * for `/costs`).
 *
 * Owner/admin only. The scan is install-wide, walks the transcript trees of
 * every provider, and is the one operation on this router that costs real
 * minutes of I/O — leaving it open to any member makes it a self-service way to
 * saturate the disk of a box that is concurrently running agent sessions.
 */
router.post(
  '/cost-ledger/scan',
  asyncHandler(async (req: Request, res: Response) => {
    readAuthenticatedUserId(req);
    const role = readAuthenticatedUserRole(req);
    if (role !== 'owner' && role !== 'admin') {
      // 403, not 404: this path is not a project and discloses no existence, so
      // there is nothing to hide — an honest refusal is more useful here.
      throw new AppError('Rebuilding the cost ledger requires an admin or owner.', {
        code: 'COST_SCAN_FORBIDDEN',
        statusCode: 403,
      });
    }

    const scan = await costLedgerService.scan();
    const body: ProjectCostScanResponse = { success: true, scan };
    res.json(body);
  }),
);

/**
 * GET /api/projects/:projectId/cost
 *
 * The single figure for a project. Reads the ledger only; never scans.
 */
router.get(
  '/:projectId/cost',
  asyncHandler(async (req: Request, res: Response) => {
    const projectId = parseProjectId(req.params.projectId);
    const userId = readAuthenticatedUserId(req);

    // Gate first: a caller who may not see the project must not reach the ledger.
    assertProjectVisible(projectId, userId);

    const total = asRecord(await costLedgerService.getProjectTotal(projectId));

    const cost: ProjectCostSummary = {
      projectId,
      totalUsd: readNullableNumber(total.totalUsd),
      complete: readComplete(total.complete),
      unpricedModels: readStringArray(total.unpricedModels),
      firstDay: readDay(total.firstDay),
      lastDay: readDay(total.lastDay),
      pricesAsOf: PRICES_AS_OF,
    };

    res.json({ success: true, cost });
  }),
);

/**
 * GET /api/projects/:projectId/stats
 *
 * The cost page's whole payload: the total, the daily curve, the vendor/model
 * groupings and the agent roster. One request, because the four are rendered
 * together and four round-trips would let them disagree on screen.
 *
 * Optional `?since=`/`?until=` (epoch ms) narrow the daily curve only; the total
 * and the groupings stay project-lifetime, which is what the header claims.
 */
router.get(
  '/:projectId/stats',
  asyncHandler(async (req: Request, res: Response) => {
    const projectId = parseProjectId(req.params.projectId);
    const userId = readAuthenticatedUserId(req);

    const projectPath = assertProjectVisible(projectId, userId);

    const since = parseEpochMsQuery(req.query.since, 'since');
    const until = parseEpochMsQuery(req.query.until, 'until');
    const window = since === undefined && until === undefined ? undefined : { since, until };

    const [rawTotal, rawDaily, rawStats] = await Promise.all([
      costLedgerService.getProjectTotal(projectId),
      costLedgerService.getProjectDaily(projectId, window),
      costLedgerService.getProjectStats(projectId),
    ]);

    const total = asRecord(rawTotal);
    const stats = asRecord(rawStats);
    const daily = readDailyPoints(rawDaily);

    // firstActivity/lastActivity come from the project TOTAL, not from `daily`:
    // a narrowed window must not make the project look younger than it is.
    const body: ProjectStatsSummary = {
      projectId,
      totalUsd: readNullableNumber(total.totalUsd),
      complete: readComplete(total.complete),
      unpricedModels: readStringArray(total.unpricedModels),
      daily,
      activeDays: daily.length,
      firstActivity: readDay(total.firstDay),
      lastActivity: readDay(total.lastDay),
      conversations: readCount(total.sessions),
      agents: readProjectAgents(projectPath),
      byVendor: readVendorRows(stats.byVendor),
      byModel: readModelRows(stats.byModel),
      pricesAsOf: PRICES_AS_OF,
    };

    res.json({ success: true, stats: body });
  }),
);

export default router;
