#!/usr/bin/env node
/**
 * ADR-172 initial membership seeding + pre-activation gain/loss report.
 *
 * Seed = project creator (projects.created_by) + every user who LAUNCHED a
 * session in the project. "Launched" is read from session_participants rows
 * with attribution = 'spawn' joined to sessions.project_path — the same source
 * the pre-ADR-172 write gate trusted. Caveat (stated in the report): that table
 * records SUCCESSFUL launches only; a user whose launches all failed, or whose
 * sessions predate participant tracking, is not seeded.
 *
 * Usage:
 *   node scripts/project-membership-seed.mjs [--db <path>] [--out <dir>]      # dry run (default)
 *   node scripts/project-membership-seed.mjs --apply --expect-hash <planHash> [--db <path>] [--out <dir>]
 *
 * The dry run opens the database READ-ONLY and writes report.json + report.md
 * under --out (default /var/tmp/nassaj-adr172-seed-<timestamp>), including
 * `planHash`. --apply REQUIRES --expect-hash: it recomputes the plan and refuses
 * unless the hash equals the one the owner reviewed, then inserts with INSERT OR
 * IGNORE (never duplicates or downgrades) and writes apply-report.json.
 *
 * RUNBOOK (qa #9a): nothing adds memberships automatically between seeding and
 * activation. Re-run the dry run, have it approved, run --apply with its hash,
 * and flip PROJECT_MEMBERSHIP_ENFORCE IMMEDIATELY after — any session launched
 * in between is not seeded.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const ALL_PROJECTS_ROLES = new Set(['owner', 'admin']);
const SEED_SOURCE = "session_participants (attribution='spawn') JOIN sessions ON project_path";

/** Parses argv into { apply, db, out }. */
export function parseArgs(argv) {
  const options = { apply: false, db: null, out: null, expectHash: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--db') options.db = argv[++i] ?? null;
    else if (arg === '--out') options.out = argv[++i] ?? null;
    else if (arg === '--expect-hash') options.expectHash = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/** DATABASE_PATH from the environment, else from ./.env (only that key is read). */
export function resolveDatabasePath(explicit, env = process.env, cwd = process.cwd()) {
  if (explicit) return explicit;
  if (env.DATABASE_PATH) return env.DATABASE_PATH;
  const envFile = path.join(cwd, '.env');
  if (!fs.existsSync(envFile)) return null;
  const line = fs.readFileSync(envFile, 'utf8').split('\n').find((l) => /^\s*DATABASE_PATH\s*=/.test(l));
  return line ? line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '') : null;
}

function readState(db) {
  const users = db.prepare(
    "SELECT id, username, role FROM users WHERE is_active = 1 AND status = 'active' ORDER BY id",
  ).all();
  const projects = db.prepare(
    'SELECT project_id, project_path, created_by, isArchived FROM projects ORDER BY project_path',
  ).all();
  const members = db.prepare('SELECT project_id, user_id FROM project_members').all();
  // Joined in JS on the NORMALIZED path (qa #9c): a trailing slash or `.`
  // segment in either column must not silently drop a launcher.
  const idByPath = new Map(projects.map((p) => [normalizeProjectPath(p.project_path), p.project_id]));
  const launchRows = db.prepare(`
    SELECT DISTINCT s.project_path AS project_path, sp.user_id AS user_id
    FROM session_participants sp
    JOIN sessions s ON s.session_id = sp.session_id
    WHERE sp.attribution = 'spawn' AND s.project_path IS NOT NULL
  `).all();
  const launchers = launchRows
    .map((row) => ({ project_id: idByPath.get(normalizeProjectPath(row.project_path)), user_id: row.user_id }))
    .filter((row) => row.project_id !== undefined);
  return { users, projects, members, launchers };
}

/** Same rules as server/shared/utils.ts normalizeProjectPath (POSIX hosts). */
export function normalizeProjectPath(input) {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (!trimmed) return '';
  const normalized = path.posix.normalize(trimmed);
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

/** Stable hash of everything the plan decides (generatedAt excluded). */
export function hashSeedPlan(plan) {
  const { generatedAt: _ignored, planHash: _self, ...decided } = plan;
  return createHash('sha256').update(JSON.stringify(decided)).digest('hex');
}

function groupByProject(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.project_id)) map.set(row.project_id, new Set());
    map.get(row.project_id).add(row.user_id);
  }
  return map;
}

function describeUsers(ids, usersById) {
  return [...ids].sort((a, b) => a - b).map((id) => ({ id, username: usersById.get(id)?.username ?? null }));
}

/**
 * Pure plan: for every project, who is seeded and how access changes when
 * PROJECT_MEMBERSHIP_ENFORCE is turned on after seeding.
 *  - today (ADR-089): every active user can READ every project; WRITE =
 *    creator | member | spawn participant.
 *  - enforced: owner/admin | creator | member (existing + seeded).
 */
export function computeSeedPlan(db) {
  const { users, projects, members, launchers } = readState(db);
  const usersById = new Map(users.map((u) => [u.id, u]));
  const activeIds = new Set(usersById.keys());
  const membersByProject = groupByProject(members);
  const launchersByProject = groupByProject(launchers);

  const perProject = projects.map((project) => {
    const existing = membersByProject.get(project.project_id) ?? new Set();
    const launched = launchersByProject.get(project.project_id) ?? new Set();
    const seed = new Set([...launched].filter((id) => activeIds.has(id)));
    if (Number.isInteger(project.created_by) && activeIds.has(project.created_by)) seed.add(project.created_by);
    const toInsert = [...seed].filter((id) => !existing.has(id));

    const enforced = new Set();
    const currentWrite = new Set();
    for (const user of users) {
      const isCreator = project.created_by === user.id;
      const isMember = existing.has(user.id) || seed.has(user.id);
      if (ALL_PROJECTS_ROLES.has(user.role) || isCreator || isMember) enforced.add(user.id);
      if (isCreator || existing.has(user.id) || launched.has(user.id)) currentWrite.add(user.id);
    }
    const loseRead = [...activeIds].filter((id) => !enforced.has(id));
    const gainWrite = [...enforced].filter((id) => !currentWrite.has(id));
    const loseWrite = [...currentWrite].filter((id) => !enforced.has(id));

    return {
      projectId: project.project_id,
      projectPath: project.project_path,
      archived: project.isArchived === 1,
      createdBy: project.created_by ?? null,
      seedInserts: describeUsers(toInsert, usersById),
      accessAfterEnforce: describeUsers(enforced, usersById),
      loseReadAccess: describeUsers(loseRead, usersById),
      gainWriteAccess: describeUsers(gainWrite, usersById),
      loseWriteAccess: describeUsers(loseWrite, usersById),
    };
  });

  const count = (key) => perProject.reduce((sum, p) => sum + p[key].length, 0);
  const plan = {
    generatedAt: new Date().toISOString(),
    seedSource: SEED_SOURCE,
    seedSourceCaveat: 'session_participants records SUCCESSFUL launches only; failed launches and '
      + 'sessions predating participant tracking are not seeded.',
    activeUsers: users.length,
    projects: perProject.length,
    totals: {
      seedInserts: count('seedInserts'),
      loseReadAccess: count('loseReadAccess'),
      gainWriteAccess: count('gainWriteAccess'),
      loseWriteAccess: count('loseWriteAccess'),
      projectsWithoutCreator: perProject.filter((p) => p.createdBy === null).length,
    },
    perProject,
  };
  return { ...plan, planHash: hashSeedPlan(plan) };
}

/** Idempotent seeding (INSERT OR IGNORE) in one transaction. Returns rows inserted. */
export function applySeedPlan(db, plan) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO project_members (project_id, user_id, role, added_by) VALUES (?, ?, ?, NULL)",
  );
  const audit = db.prepare(
    "INSERT INTO audit_log (user_id, action, metadata) VALUES (NULL, 'project.member.add', ?)",
  );
  let inserted = 0;
  db.transaction(() => {
    for (const project of plan.perProject) {
      for (const user of project.seedInserts) {
        const role = user.id === project.createdBy ? 'owner' : 'member';
        const result = insert.run(project.projectId, user.id, role);
        if (result.changes > 0) {
          inserted += 1;
          audit.run(JSON.stringify({ projectId: project.projectId, targetUserId: user.id, role, source: 'adr172-seed' }));
        }
      }
    }
  })();
  return inserted;
}

/** Refuses --apply unless the recomputed plan is exactly the reviewed one. */
export function assertExpectedHash(plan, expectHash) {
  if (typeof expectHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectHash)) {
    throw new Error('--apply requires --expect-hash <planHash> from the approved dry run');
  }
  if (expectHash !== plan.planHash) {
    throw new Error(`plan changed since the dry run (expected ${expectHash}, now ${plan.planHash}); re-run the dry run`);
  }
}

/** Short owner-facing markdown summary (usernames only, no other PII). */
export function renderMarkdown(plan) {
  const names = (list) => (list.length ? list.map((u) => u.username ?? `#${u.id}`).join(', ') : '-');
  const lines = [
    '# ADR-172 membership seeding report (dry run)',
    '',
    `Generated: ${plan.generatedAt}`,
    `Plan hash (pass to --apply --expect-hash): ${plan.planHash}`,
    `Seed source: ${plan.seedSource}`,
    `Caveat: ${plan.seedSourceCaveat}`,
    '',
    `Active users: ${plan.activeUsers} | Projects: ${plan.projects}`,
    `Seed inserts: ${plan.totals.seedInserts} | Lose read: ${plan.totals.loseReadAccess}`
      + ` | Gain write: ${plan.totals.gainWriteAccess} | Lose write: ${plan.totals.loseWriteAccess}`
      + ` | Projects without creator: ${plan.totals.projectsWithoutCreator}`,
    '',
    '| Project | Seeded | Loses read | Gains write | Loses write |',
    '|---|---|---|---|---|',
  ];
  for (const p of plan.perProject) {
    lines.push(`| ${path.basename(p.projectPath)}${p.archived ? ' (archived)' : ''} | ${names(p.seedInserts)} | `
      + `${names(p.loseReadAccess)} | ${names(p.gainWriteAccess)} | ${names(p.loseWriteAccess)} |`);
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = resolveDatabasePath(options.db);
  if (!dbPath) throw new Error('database path not found: pass --db or set DATABASE_PATH');
  const db = new Database(dbPath, { readonly: !options.apply, fileMustExist: true });
  try {
    const plan = computeSeedPlan(db);
    const outDir = options.out ?? `/var/tmp/nassaj-adr172-seed-${Date.now()}`;
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    if (options.apply) {
      assertExpectedHash(plan, options.expectHash);
      const inserted = applySeedPlan(db, plan);
      const report = { appliedAt: new Date().toISOString(), planHash: plan.planHash, inserted,
        expectedInserts: plan.totals.seedInserts, dbPath };
      fs.writeFileSync(path.join(outDir, 'apply-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      process.stdout.write(`${JSON.stringify({ applied: true, inserted, outDir })}\n`);
      return;
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(outDir, 'report.md'), renderMarkdown(plan), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ applied: false, outDir, projects: plan.projects, totals: plan.totals })}\n`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`project-membership-seed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
