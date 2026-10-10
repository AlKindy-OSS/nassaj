#!/usr/bin/env node
/**
 * ADR-201 D4 / T-2001 P0 — read-only session transcript source audit.
 *
 * Opens the Nassaj DB with `file:<path>?mode=ro` (readOnly) and transcript
 * files O_RDONLY (header only, ≤64 KiB). Writes nothing except the optional
 * `--out` report (mode 600). The report holds counts, session ids and numeric
 * member ids only: no paths, no content, no prompts, no usernames.
 *
 * Usage:
 *   node scripts/diagnostics/session-source-audit.mjs \
 *     [--live-root <dir>] [--db <path>] [--home <dir>] \
 *     [--users-root <dir>] [--max-files 20000] [--time-budget-ms 60000] [--out <file>]
 *
 * Without `--db`, the DB path comes from DATABASE_PATH in `<live-root>/.env`;
 * the live root is `--live-root`, else $NASSAJ_LIVE_ROOT, else the cwd.
 * stdout carries aggregate counts only, never ids.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEADER_BYTES = 64 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CODEX_FILE_RE = new RegExp(`-(${UUID})\\.jsonl$`, 'i');
const AGY_RE = new RegExp(`/brain/(${UUID})/`, 'i');

/** Provider dirs under a home, and the provider each implies. */
const PROVIDER_DIRS = Object.freeze([
  { rel: '.claude/projects', provider: 'claude' },
  { rel: '.codex/sessions', provider: 'codex' },
  { rel: '.gemini/antigravity-cli/brain', provider: 'antigravity' },
  { rel: '.nassaj-vendor-sessions', provider: 'vendor' },
]);

function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Locates a path among the operator home and numbered member trees.
 * `/users/1` never matches `/users/10` (segment-exact).
 * @returns {{tree: 'operator'|'member'|'outside', memberId: number|null, provider: string|null}}
 */
export function classifyLocation(p, { home, usersRoot }) {
  let tree = 'outside';
  let memberId = null;
  let base = null;
  if (isUnder(p, usersRoot)) {
    const seg = path.relative(usersRoot, p).split(path.sep)[0];
    if (/^\d+$/.test(seg)) {
      tree = 'member';
      memberId = Number(seg);
      base = path.join(usersRoot, seg);
    }
  } else if (isUnder(p, home)) {
    tree = 'operator';
    base = home;
  }
  if (!base) return { tree: 'outside', memberId: null, provider: null };
  const hit = PROVIDER_DIRS.find((d) => isUnder(p, path.join(base, d.rel)));
  if (!hit) return { tree: 'outside', memberId, provider: null };
  let provider = hit.provider;
  if (provider === 'vendor') {
    provider = path.relative(path.join(base, hit.rel), p).split(path.sep)[0] || null;
  }
  return { tree, memberId, provider };
}

function ownerKey(loc) {
  return loc.tree === 'member' ? `m${loc.memberId}` : loc.tree;
}

/**
 * Realpath of every provider dir under the operator home and each numbered
 * member tree, with the trees that reach it. A root reached from ≥2 trees is a
 * physically shared tree (ADR-201 legit case b). Longest root first.
 * @returns {{real: string, provider: string, owners: string[]}[]}
 */
export function buildRealRoots(ctx) {
  const roots = new Map();
  for (const home of homesFor(ctx).homes) {
    for (const d of PROVIDER_DIRS) {
      let real;
      try {
        real = fs.realpathSync(path.join(home, d.rel));
      } catch {
        continue;
      }
      const owner = ownerKey(classifyLocation(path.join(home, d.rel, 'x'), ctx));
      if (!roots.has(real)) roots.set(real, { real, provider: d.provider, owners: new Set() });
      roots.get(real).owners.add(owner);
    }
  }
  return [...roots.values()]
    .map((r) => ({ ...r, owners: [...r.owners].sort() }))
    .sort((a, b) => b.real.length - a.real.length);
}

/** Which real provider root holds a resolved path (null = outside every root). */
export function classifyReal(real, roots) {
  const hit = roots.find((r) => isUnder(real, r.real));
  if (!hit) return null;
  const provider = hit.provider === 'vendor'
    ? path.relative(hit.real, real).split(path.sep)[0]
    : hit.provider;
  return { provider, owners: hit.owners, shared: hit.owners.length > 1 };
}

/** Filename/location id per provider (the id ADR-201 D2.1 treats as canonical). */
export function locationId(provider, p) {
  const name = path.basename(p);
  if (provider === 'codex') return CODEX_FILE_RE.exec(name)?.[1]?.toLowerCase() ?? null;
  if (provider === 'antigravity') return AGY_RE.exec(p)?.[1]?.toLowerCase() ?? null;
  return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : null;
}

function parseLines(text) {
  const complete = text.includes('\n') ? text.slice(0, text.lastIndexOf('\n')) : text;
  const out = [];
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push(null);
    }
  }
  return out;
}

/**
 * Claude header: first id-bearing line vs filename stem.
 * kind: match | nassaj_fork | resume_like | other | no_id
 * resume_like = header later carries the stem id, or the first id is a known
 * other session (CLI resume/fork copies earlier lines under the old id).
 */
export function classifyClaudeHeader(text, stem, knownIds = new Set()) {
  const entries = parseLines(text).filter((e) => e && typeof e === 'object');
  const ids = entries.map((e) => e.sessionId).filter((v) => typeof v === 'string');
  const looksClaude = ids.length > 0 && entries.some((e) => typeof e.type === 'string');
  if (ids.length === 0) return { kind: 'no_id', firstId: null, distinctIds: 0, looksClaude: false };
  const firstId = ids[0];
  const distinctIds = new Set(ids).size;
  let kind = 'other';
  if (firstId === stem) kind = 'match';
  else if (entries.some((e) => e.forkedFrom)) kind = 'nassaj_fork';
  else if (ids.includes(stem) || knownIds.has(firstId)) kind = 'resume_like';
  return { kind, firstId, distinctIds, looksClaude };
}

/**
 * Codex header: session_meta.payload.id vs filename UUID.
 * kind: match | fork | subagent | other | no_meta
 */
export function classifyCodexHeader(text, fileUuid) {
  const first = parseLines(text)[0];
  if (!first || first.type !== 'session_meta' || !first.payload) {
    return { kind: 'no_meta', headerId: null, looksCodex: false, sessionIdDiffers: false };
  }
  const pl = first.payload;
  const headerId = typeof pl.id === 'string' ? pl.id.toLowerCase() : null;
  const sessionIdDiffers = typeof pl.session_id === 'string' && pl.session_id.toLowerCase() !== headerId;
  let kind = 'other';
  if (headerId && headerId === fileUuid) kind = 'match';
  else if (pl.forked_from_id) kind = 'fork';
  else if (pl.parent_thread_id) kind = 'subagent';
  return { kind, headerId, looksCodex: true, sessionIdDiffers };
}

/** Format implied by header bytes: claude | codex | unknown. */
export function sniffFormat(text) {
  const first = parseLines(text).find((e) => e);
  if (!first) return 'unknown';
  if (first.type === 'session_meta' && first.payload) return 'codex';
  if (classifyClaudeHeader(text, '').looksClaude) return 'claude';
  return 'unknown';
}

/**
 * Members whose tree a session's spawns may legitimately use: each spawn
 * participant plus any owner who ever granted that participant this provider's
 * unit (declined or not — the grant may have been live at spawn time).
 */
export function expectedMembers(participants, grants, provider) {
  const unit = provider === 'antigravity' ? 'gemini' : provider;
  const out = new Set();
  for (const p of participants) {
    if (p.attribution !== 'spawn') continue;
    out.add(Number(p.user_id));
    for (const g of grants) {
      if (Number(g.grantee_user_id) === Number(p.user_id) && g.provider === unit) {
        out.add(Number(g.owner_user_id));
      }
    }
  }
  return out;
}

/** Tree verdict: ok | mismatch | no_spawn_participants | not_member_tree. */
export function classifyTree(loc, participants, grants, provider) {
  if (loc.tree !== 'member') return 'not_member_tree';
  const expected = expectedMembers(participants, grants, provider);
  if (expected.size === 0) return 'no_spawn_participants';
  return expected.has(loc.memberId) ? 'ok' : 'mismatch';
}

function readHeader(p) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Resolves DATABASE_PATH from the live root's .env (relative → live root). */
export function resolveDbPath(liveRoot) {
  const text = fs.readFileSync(path.join(liveRoot, '.env'), 'utf8');
  const line = text.split('\n').find((l) => /^\s*DATABASE_PATH\s*=/.test(l));
  if (!line) throw new Error('DATABASE_PATH not set in live root .env');
  const value = line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
  return path.resolve(liveRoot, value);
}

async function openDbReadOnly(dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
}

function loadDb(db) {
  const rows = db.prepare('SELECT session_id, provider, jsonl_path FROM sessions').all();
  const participants = new Map();
  for (const r of db.prepare('SELECT session_id, user_id, attribution FROM session_participants').all()) {
    if (!participants.has(r.session_id)) participants.set(r.session_id, []);
    participants.get(r.session_id).push(r);
  }
  const grants = db.prepare('SELECT owner_user_id, grantee_user_id, provider FROM provider_credential_grants').all();
  return { rows, participants, grants };
}

function bucket(report, pathKeys, id) {
  let node = report;
  for (const k of pathKeys.slice(0, -1)) node = node[k] ??= {};
  const leaf = pathKeys.at(-1);
  (node[leaf] ??= []).push(id);
}

function inspectFileStat(p) {
  try {
    const l = fs.lstatSync(p);
    const real = fs.realpathSync(p);
    return { exists: true, symlink: l.isSymbolicLink(), nlink: fs.statSync(p).nlink, real, isFile: fs.statSync(p).isFile() };
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { exists: false };
    return { exists: false, error: e.code ?? 'ERR' };
  }
}

function auditIdentity(report, row, loc, header, knownIds) {
  const id = row.session_id;
  const lid = locationId(row.provider, row.jsonl_path);
  if (lid !== null && lid !== id && !(row.provider === 'kimi' && lid === `kimi_${id}`)) {
    bucket(report, ['idMismatch', 'rowIdVsFilename', row.provider], id);
  }
  if (row.provider === 'claude') {
    const c = classifyClaudeHeader(header, lid, knownIds);
    bucket(report, ['idMismatch', 'claude', c.kind], id);
  } else if (row.provider === 'codex') {
    const c = classifyCodexHeader(header, lid);
    bucket(report, ['idMismatch', 'codex', c.kind], id);
  }
  const fmt = sniffFormat(header);
  const fmtProvider = { claude: 'claude', codex: 'codex' }[fmt];
  if (loc.provider && loc.provider !== row.provider) {
    bucket(report, ['providerMismatch', 'location'], id);
  } else if (fmtProvider && fmtProvider !== row.provider) {
    bucket(report, ['providerMismatch', 'format'], id);
  }
}

function auditRow(report, row, ctx) {
  const id = row.session_id;
  if (!row.jsonl_path) return bucket(report, ['coverage', 'nullPath'], id);
  const st = inspectFileStat(row.jsonl_path);
  if (!st.exists) return bucket(report, ['missingFile', st.error ?? 'ENOENT'], id);
  const loc = classifyLocation(path.resolve(row.jsonl_path), ctx);
  const real = classifyReal(st.real, ctx.roots);
  if (st.symlink) bucket(report, ['outsideRoots', 'symlinkFinal'], id);
  if (st.nlink > 1) bucket(report, ['outsideRoots', 'hardlink'], id);
  if (loc.tree === 'outside') bucket(report, ['outsideRoots', 'storedPathOutside'], id);
  if (!real) bucket(report, ['outsideRoots', 'realpathOutside'], id);
  else if (!real.owners.includes(ownerKey(loc))) bucket(report, ['outsideRoots', 'realpathNotClaimedTree'], id);
  if (real?.shared) bucket(report, ['outsideRoots', 'info_sharedPhysicalRoot'], id);
  const verdict = classifyTree(loc, ctx.participants.get(id) ?? [], ctx.grants, row.provider);
  bucket(report, ['treeMismatch', verdict], id);
  if (verdict === 'mismatch') {
    const members = [...expectedMembers(ctx.participants.get(id) ?? [], ctx.grants, row.provider)];
    (report.treeMismatchDetail ??= []).push({ sessionId: id, treeMember: loc.memberId, expectedMembers: members });
  }
  if (!st.isFile) return bucket(report, ['coverage', 'notRegularFile'], id);
  let header;
  try {
    header = readHeader(row.jsonl_path) ?? '';
  } catch {
    return bucket(report, ['coverage', 'unreadable'], id);
  }
  ctx.counters.filesRead += 1;
  auditIdentity(report, row, { provider: loc.provider ?? real?.provider ?? null }, header, ctx.knownIds);
}

function* listJsonl(dir, depth, maxDepth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < maxDepth) yield* listJsonl(p, depth + 1, maxDepth);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

/** Operator home + numbered member homes; counts non-numeric entries. */
export function homesFor(ctx) {
  const homes = [ctx.home];
  let nonNumeric = 0;
  try {
    for (const n of fs.readdirSync(ctx.usersRoot)) {
      if (/^\d+$/.test(n)) homes.push(path.join(ctx.usersRoot, n));
      else nonNumeric += 1;
    }
  } catch {
    /* no member trees */
  }
  return { homes, nonNumeric };
}

/**
 * Disk-wide measurement for D2.1: how often Claude/Codex files on disk carry a
 * header id ≠ filename id, plus ids present in ≥2 distinct real files. Bounded by
 * maxFiles and timeBudgetMs; dedupes by realpath (shared projects/ trees).
 */
export function scanDisk(ctx, { maxFiles, timeBudgetMs }) {
  const started = Date.now();
  const seenReal = new Set();
  const byId = new Map();
  const out = { claude: {}, codex: {}, filesSeen: 0, filesRead: 0, limitHit: false, sharedRealpaths: 0 };
  const specs = [
    { provider: 'claude', rel: '.claude/projects', maxDepth: 1 },
    { provider: 'codex', rel: '.codex/sessions', maxDepth: 3 },
  ];
  for (const home of homesFor(ctx).homes) {
    for (const spec of specs) {
      for (const p of listJsonl(path.join(home, spec.rel), 0, spec.maxDepth)) {
        if (out.filesSeen >= maxFiles || Date.now() - started > timeBudgetMs) {
          out.limitHit = true;
          return finishScan(out, byId);
        }
        out.filesSeen += 1;
        scanOne(out, byId, seenReal, ctx, spec.provider, p);
      }
    }
  }
  return finishScan(out, byId);
}

function scanOne(out, byId, seenReal, ctx, provider, p) {
  let real;
  try {
    real = fs.realpathSync(p);
  } catch {
    return;
  }
  if (seenReal.has(real)) {
    out.sharedRealpaths += 1;
    return;
  }
  seenReal.add(real);
  const lid = locationId(provider, p);
  if (!byId.has(lid)) byId.set(lid, new Set());
  byId.get(lid).add(real);
  let header;
  try {
    header = readHeader(p) ?? '';
  } catch {
    return;
  }
  out.filesRead += 1;
  const verdict = provider === 'claude'
    ? classifyClaudeHeader(header, lid, ctx.knownIds)
    : classifyCodexHeader(header, lid);
  const tally = out[provider];
  tally[verdict.kind] = (tally[verdict.kind] ?? 0) + 1;
  if (verdict.distinctIds > 1) tally.mixedIdsInHeader = (tally.mixedIdsInHeader ?? 0) + 1;
  if (verdict.sessionIdDiffers) tally.sessionIdNotEqualId = (tally.sessionIdNotEqualId ?? 0) + 1;
}

function finishScan(out, byId) {
  out.duplicateIds = [...byId].filter(([id, trees]) => id && trees.size > 1).map(([id]) => id);
  return out;
}

function countTree(node) {
  if (Array.isArray(node)) return node.length;
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, countTree(v)]));
  }
  return node;
}

/** Runs the audit; returns { report (with ids), summary (counts only) }. */
export async function runAudit(opts) {
  const db = await openDbReadOnly(opts.dbPath);
  let data;
  try {
    data = loadDb(db);
  } finally {
    db.close();
  }
  const ctx = {
    home: opts.home,
    usersRoot: opts.usersRoot,
    participants: data.participants,
    grants: data.grants,
    knownIds: new Set(data.rows.map((r) => r.session_id)),
    roots: [],
    counters: { filesRead: 0 },
  };
  ctx.roots = buildRealRoots(ctx);
  const report = { idMismatch: {}, outsideRoots: {}, treeMismatch: {}, providerMismatch: {}, missingFile: {}, coverage: {} };
  for (const row of data.rows) auditRow(report, row, ctx);
  const disk = scanDisk(ctx, { maxFiles: opts.maxFiles, timeBudgetMs: opts.timeBudgetMs });
  const meta = {
    generatedAt: new Date().toISOString(),
    rows: data.rows.length,
    rowsByProvider: data.rows.reduce((a, r) => ({ ...a, [r.provider]: (a[r.provider] ?? 0) + 1 }), {}),
    rowFilesRead: ctx.counters.filesRead,
    headerBytes: HEADER_BYTES,
    realRoots: ctx.roots.length,
    sharedRealRoots: ctx.roots.filter((r) => r.owners.length > 1).map((r) => ({ provider: r.provider, trees: r.owners.length })),
    nonNumericUserDirs: homesFor(ctx).nonNumeric,
  };
  const { duplicateIds, ...diskCounts } = disk;
  const { treeMismatchDetail, ...countable } = report;
  const summary = {
    meta,
    ...countTree(countable),
    treeMismatchDetail: treeMismatchDetail?.length ?? 0,
    diskScan: { ...diskCounts, duplicateIds: duplicateIds.length },
  };
  return { report: { meta, ...report, diskScan: { ...diskCounts, duplicateIds } }, summary };
}

/**
 * Parse CLI flags. The live root has no host-specific default: it is
 * `--live-root`, else `env.NASSAJ_LIVE_ROOT`, else `cwd`, and is read only
 * when `--db` is absent.
 */
export function parseArgs(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument: ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  const liveRoot = path.resolve(cwd, args['live-root'] ?? env.NASSAJ_LIVE_ROOT ?? cwd);
  return {
    dbPath: args.db ?? resolveDbPath(liveRoot),
    home: path.resolve(args.home ?? os.homedir()),
    usersRoot: path.resolve(args['users-root'] ?? path.join(os.homedir(), '.nassaj-users')),
    maxFiles: Number(args['max-files'] ?? 20000),
    timeBudgetMs: Number(args['time-budget-ms'] ?? 60000),
    out: args.out ?? null,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { report, summary } = await runAudit(opts);
  if (opts.out) {
    fs.writeFileSync(opts.out, `${JSON.stringify(report, null, 1)}\n`, { mode: 0o600, flag: 'wx' });
  }
  process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`session-source-audit failed: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
}
