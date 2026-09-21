import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { opendir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { participantsDb, sessionsDb } from '@/modules/database/index.js';
import { credentialPrincipalId } from '@/services/isolation/credential-principal.js';
import { userConfigDir } from '@/services/isolation/provision-user-dirs.js';
import { isProviderIsolated } from '@/services/provider-sharing.js';
import { AppError } from '@/shared/utils.js';
import { parseFrontMatter } from '@/shared/frontmatter.js';

import type { ProjectSkillProjection, SessionSkillProjection, SkillCoverage, SkillObservation } from '../../../../shared/skillObservations.js';

import { assertSessionAccessible } from './sessions.service.js';
import { record, safeNativeId, skillHash, summarizeSkills } from './skill-observation-parser.js';
import { canScan, newSkillSource, scanSkillSource, type ScanBudget, type SkillScanState } from './skill-observation-scan.js';

type Entry = { state: SkillScanState; flight?: Promise<void>; lastUsed: number; epoch: string };
const cache = new Map<string, Entry>();
const loading = new Map<string, Promise<Entry | null>>();
const principals = new Set<number>();
const cursors = new Map<string, { key: string; epoch: string; generation: number; offset: number; expires: number }>();
const noAccess = () => new AppError('Session was not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
const cacheKey = (user: number, provider: string, session: string) => skillHash('cache', user, provider, session);

/** Resolve ACL and canonical owner/provider before every cache/cursor access. */
function authorize(sessionId: string, provider: string, principal: number | null) {
  const row = assertSessionAccessible(sessionId, principal, 'read');
  if (row.provider !== provider || principal === null) throw noAccess();
  const owner = participantsDb.getOwnersBySessionIds([sessionId])[0]?.userId;
  const resolvedOwner = Number.isInteger(owner) ? owner : null;
  const home = resolvedOwner === null ? '' : readOnlyHome(resolvedOwner, provider);
  return { row, owner: resolvedOwner, principal, home,
    scope: JSON.stringify([resolvedOwner, row.provider, row.jsonl_path, row.project_path, home]) };
}

function readOnlyHome(owner: number, provider: string): string {
  if (provider !== 'claude' && provider !== 'codex') return '';
  // T-1675: a session owner running on a granted credential reads the grantor's tree.
  return isProviderIsolated(provider) ? userConfigDir(credentialPrincipalId(owner, provider), `.${provider}`)
    : (provider === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR) || path.join(os.homedir(), `.${provider}`);
}

function emptyCoverage(supported: boolean, reason: SkillCoverage['reasons'][number] = 'cold_cache'): SkillCoverage {
  return { state: supported ? 'unavailable' : 'unsupported', scannedSources: 0, discoveredSources: 0,
    discoveryComplete: false, detector: { state: supported ? 'limited' : 'unsupported',
      capabilities: supported ? ['native_invocation', 'structured_read', 'literal_shell_read'] : [],
      reasons: supported ? ['unobserved_execution_possible', 'unsupported_tool_shape'] : ['unsupported_provider'] },
    reasons: supported ? [reason] : [], asOf: null, nextCursor: null };
}
const emptyProjection = (supported: boolean, reason?: SkillCoverage['reasons'][number]): SessionSkillProjection =>
  ({ observations: [], summary: summarizeSkills([]), coverage: emptyCoverage(supported, reason) });

async function createState(principal: number, provider: 'claude' | 'codex', sessionId: string,
  owner: number, file: string | null, workspace: string | null, scope: string): Promise<SkillScanState | null> {
  if (!file) return null;
  // Do not call resolveProviderEnv: it provisions directories and applies policy on read.
  const home = readOnlyHome(owner, provider);
  try {
    const root = await realpath(path.join(home, provider === 'codex' ? 'sessions' : 'projects'));
    const target = await realpath(file);
    if (!target.startsWith(`${root}${path.sep}`)) return null;
    if (provider === 'claude' ? path.basename(target) !== `${sessionId}.jsonl`
      : !path.basename(target).endsWith(`-${sessionId}.jsonl`)) return null;
    const candidates = [{ directory: path.join(home, 'skills'), boundary: home },
      { directory: path.join(home, 'plugins', 'cache'), boundary: home }];
    if (workspace) candidates.push({ directory: path.join(workspace, `.${provider}`, 'skills'), boundary: workspace },
      { directory: path.join(workspace, '.agents', 'skills'), boundary: workspace });
    const skillRoots: string[] = [];
    const skillBoundaries = new Map<string, string>();
    for (const item of candidates) {
      try {
        const [directory, boundary] = await Promise.all([realpath(item.directory), realpath(item.boundary)]);
        if (directory.startsWith(`${boundary}${path.sep}`)) {
          skillRoots.push(item.directory); skillBoundaries.set(item.directory, boundary);
        }
      } catch { /* Absent catalog roots do not grant historical arbitrary-path identities. */ }
    }
    return { provider, principal, owner, sessionId, sourceRoot: root, skillRoots,
      sources: new Map([[target, newSkillSource(target, sessionId, 'root')]]), observations: new Map(),
      reasons: new Set(), generation: 1, updatedAt: 0, discoveryComplete: false,
      definitions: new Map(), invocationDefinitions: new Map(), catalogLoaded: false, registryScope: scope, skillBoundaries };
  } catch { return null; }
}

async function readCatalogDefinition(state: SkillScanState, file: string, root: string, budget: ScanBudget): Promise<void> {
  if (!canScan(budget)) return;
  budget.operations += 4;
  try {
    const target = await realpath(file);
    const realRoot = await realpath(root);
    const boundary = state.skillBoundaries.get(root);
    if (!canScan(budget) || !boundary || !realRoot.startsWith(`${boundary}${path.sep}`)
      || !target.startsWith(`${realRoot}${path.sep}`)) return;
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(8192);
      const result = await handle.read(buffer, 0, buffer.length, 0);
      budget.bytes += result.bytesRead;
      if (!canScan(budget)) return;
      const parsed = record(parseFrontMatter(buffer.toString('utf8', 0, result.bytesRead)).data);
      const fallback = path.basename(path.dirname(file));
      const name = typeof parsed.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(parsed.name)
        ? parsed.name : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(fallback) ? fallback : 'Unresolved skill';
      const relative = path.relative(root, file);
      const identity = { key: skillHash('definition', state.provider, state.owner, root, relative), name };
      const metadataBytes = JSON.stringify([...state.definitions]).length * 2;
      if (metadataBytes + (file.length + target.length) * 2 + 1024 > 48 * 1024) {
        state.reasons.add('lookup_limit'); return;
      }
      state.definitions.set(file, identity); state.definitions.set(target, identity);
      // Plugin names are not inferred from directory basenames: unresolved namespaces remain explicit.
      if (!root.endsWith(`${path.sep}cache`)) {
        const previous = state.invocationDefinitions.get(name);
        state.invocationDefinitions.set(name, previous === undefined ? identity
          : previous?.key === identity.key ? identity : null);
      }
    } finally { await handle.close(); }
  } catch { state.reasons.add('source_unavailable'); }
}

async function loadCatalog(state: SkillScanState, budget: ScanBudget): Promise<void> {
  if (state.catalogLoaded) return;
  const queue = state.skillRoots.map((root) => ({ root, directory: root, depth: 0 }));
  let count = 0;
  while (queue.length && count < 96 && canScan(budget)) {
    const item = queue.shift()!;
    budget.operations += 2;
    let directory;
    try {
      const resolved = await realpath(item.directory);
      if (!canScan(budget) || !resolved.startsWith(`${state.skillBoundaries.get(item.root)}${path.sep}`)) continue;
      directory = await opendir(resolved);
    } catch { continue; }
    try {
      for await (const entry of directory) {
        count++; budget.entries++; budget.operations++;
        if (!canScan(budget) || count > 96) break;
        const file = path.join(item.directory, entry.name);
        if (entry.isDirectory() && item.depth < 7 && queue.length < 96) {
          queue.push({ ...item, directory: file, depth: item.depth + 1 });
        } else if (entry.isFile() && entry.name === 'SKILL.md') {
          await readCatalogDefinition(state, file, item.root, budget);
        }
      }
    } finally { await directory.close().catch(() => undefined); }
  }
  if (queue.length || count >= 96) state.reasons.add('lookup_limit');
  state.catalogLoaded = true;
}

async function smallJson(file: string, root: string, budget: ScanBudget): Promise<Record<string, unknown>> {
  if (!canScan(budget)) return {};
  budget.operations += 4;
  try {
    const target = await realpath(file);
    if (!canScan(budget) || !target.startsWith(`${root}${path.sep}`)) return {};
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > 8192 || stats.size > 8 * 1024 * 1024 - budget.bytes || !canScan(budget)) return {};
      const buffer = Buffer.alloc(stats.size);
      const result = await handle.read(buffer, 0, buffer.length, 0);
      budget.bytes += result.bytesRead;
      return canScan(budget) ? record(JSON.parse(buffer.toString('utf8', 0, result.bytesRead))) : {};
    } finally { await handle.close(); }
  } catch { return {}; }
}

async function discoverClaude(state: SkillScanState, budget: ScanBudget): Promise<void> {
  const root = [...state.sources.values()][0];
  const directory = path.join(path.dirname(root.path), state.sessionId, 'subagents');
  budget.operations += 2;
  let iterator;
  try {
    const resolved = await realpath(directory);
    if (!canScan(budget) || !resolved.startsWith(`${state.sourceRoot}${path.sep}`)) {
      state.reasons.add('source_unavailable'); return;
    }
    iterator = await opendir(resolved);
  } catch (error) {
    state.discoveryComplete = (error as NodeJS.ErrnoException).code === 'ENOENT'; return;
  }
  let complete = true;
  try {
    for await (const entry of iterator) {
      budget.entries++; budget.operations++;
      if (!canScan(budget)) { complete = false; break; }
      if (!entry.isFile() || !/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      const existing = state.sources.get(file);
      if (!existing && state.sources.size >= 65) { state.reasons.add('source_limit'); complete = false; break; }
      const meta = await smallJson(file.replace(/\.jsonl$/, '.meta.json'), state.sourceRoot, budget);
      const parentId = meta.parentAgentId;
      const bridge = !parentId && safeNativeId(meta.toolUseId) && root.spawns.has(meta.toolUseId) ? meta.toolUseId : null;
      if (existing) existing.actorToolCallId = bridge;
      else state.sources.set(file, newSkillSource(file, entry.name.slice(6, -6), 'subagent', bridge));
      if (!bridge) state.reasons.add('unresolved_attribution');
    }
  } finally { await iterator.close().catch(() => undefined); }
  state.discoveryComplete = complete;
  const bridges = new Map<string, number>();
  for (const source of state.sources.values()) if (source.actorToolCallId) {
    bridges.set(source.actorToolCallId, (bridges.get(source.actorToolCallId) ?? 0) + 1);
  }
  for (const source of state.sources.values()) {
    if (source.actorToolCallId && bridges.get(source.actorToolCallId)! > 1) {
      source.actorToolCallId = null; state.reasons.add('unresolved_attribution');
    }
    const identity = skillHash('source', state.provider, state.owner, source.identity);
    for (const observation of state.observations.values()) if (observation.sourceSessionId === identity) {
      observation.actorToolCallId = source.actorToolCallId;
    }
  }
}

async function discoverCodex(state: SkillScanState, budget: ScanBudget): Promise<void> {
  let complete = true;
  for (const parent of [...state.sources.values()]) {
    for (const [callId, thread] of parent.spawns) {
      if (!thread || [...state.sources.values()].some((item) => item.identity === thread)) continue;
      if (!canScan(budget) || state.sources.size >= 65) { complete = false; break; }
      budget.operations++;
      let directory;
      try { directory = await opendir(path.dirname(parent.path)); } catch { complete = false; continue; }
      let found = false;
      try {
        for await (const item of directory) {
          budget.entries++; budget.operations++;
          if (!canScan(budget)) break;
          if (!item.isFile() || !item.name.endsWith(`-${thread}.jsonl`)) continue;
          const file = path.join(path.dirname(parent.path), item.name);
          const source = newSkillSource(file, thread, 'subagent', parent.actorKind === 'root' ? callId : null);
          source.expectedParent = parent.identity; state.sources.set(file, source); found = true; break;
        }
      } finally { await directory.close().catch(() => undefined); }
      if (!found) complete = false;
    }
  }
  state.discoveryComplete = complete;
  if (!complete) state.reasons.add('unresolved_attribution');
}

function retainedBytes(state: SkillScanState): number {
  let bytes = JSON.stringify([...state.observations.values()]).length * 2 + 4096
    + JSON.stringify([...state.definitions]).length * 2 + JSON.stringify([...state.invocationDefinitions]).length * 2;
  for (const source of state.sources.values()) bytes += source.tail.length + source.calls.size * 384
    + source.spawns.size * 512 + source.path.length * 2 + 2048;
  return bytes;
}
function trimCache(): void {
  let size = [...cache.values()].reduce((sum, entry) => sum + retainedBytes(entry.state), 0);
  for (const [key, entry] of [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
    // Reserve a full session budget for each admitted in-progress scan.
    if (cache.size <= 128 && size <= (32 - principals.size * 4) * 1024 * 1024) break;
    if (!entry.flight) { cache.delete(key); size -= retainedBytes(entry.state); }
  }
}

async function scan(entry: Entry, signal?: AbortSignal): Promise<void> {
  const state = entry.state;
  // Reserve preflight ownership/path-resolution work and descriptor-close overhead.
  const budget: ScanBudget = { deadline: Date.now() + 2000, bytes: 0, operations: 32, entries: 0, signal };
  state.generation++;
  state.reasons.delete('scan_budget'); state.reasons.delete('aborted');
  await loadCatalog(state, budget);
  for (const source of state.sources.values()) {
    if (!canScan(budget)) break;
    try { await scanSkillSource(state, source, budget); }
    catch { state.reasons.add(signal?.aborted ? 'aborted' : 'source_unavailable'); }
  }
  if (canScan(budget)) {
    if (state.provider === 'claude') await discoverClaude(state, budget);
    else await discoverCodex(state, budget);
  }
  // Newly discovered children get a bounded pass; unchanged children only stat.
  for (const source of state.sources.values()) {
    if (source.offset || !canScan(budget)) continue;
    try { await scanSkillSource(state, source, budget); } catch { state.reasons.add('source_unavailable'); }
  }
  if (!canScan(budget)) state.reasons.add(signal?.aborted ? 'aborted' : 'scan_budget');
  if (!state.discoveryComplete) state.reasons.add('discovery_limit');
  if (retainedBytes(state) > 4 * 1024 * 1024) {
    state.reasons.add('memory_limit');
    for (const source of state.sources.values()) { source.tail = Buffer.alloc(0); source.discarding = true; source.calls.clear(); }
  }
  state.updatedAt = Date.now(); trimCache();
}

function coverageFor(state: SkillScanState): SkillCoverage {
  const coverage = emptyCoverage(true);
  coverage.scannedSources = [...state.sources.values()].filter((source) => source.complete && source.valid).length;
  coverage.discoveredSources = state.sources.size; coverage.discoveryComplete = state.discoveryComplete;
  coverage.reasons = [...state.reasons]; coverage.asOf = new Date(state.updatedAt).toISOString();
  coverage.state = coverage.scannedSources === state.sources.size && state.discoveryComplete && !coverage.reasons.length
    ? 'complete' : 'partial';
  return coverage;
}

function page(key: string, entry: Entry, cursor?: string): SessionSkillProjection {
  let offset = 0;
  if (cursor) {
    const saved = cursors.get(cursor);
    if (!saved || saved.key !== key || saved.epoch !== entry.epoch
      || saved.generation !== entry.state.generation || saved.expires < Date.now()) {
      throw new AppError('Skill cursor expired. Reload the first page.', { code: 'SKILL_CURSOR_EXPIRED', statusCode: 409 });
    }
    offset = saved.offset;
  }
  const all = [...entry.state.observations.values()];
  const coverage = coverageFor(entry.state);
  const observations: SkillObservation[] = [];
  let bytes = 2048;
  while (offset < all.length && observations.length < 200) {
    const size = Buffer.byteLength(JSON.stringify(all[offset]));
    if (bytes + size > 120 * 1024) break;
    observations.push(all[offset++]); bytes += size;
  }
  if (offset < all.length) {
    const token = randomBytes(24).toString('hex');
    cursors.set(token, { key, epoch: entry.epoch, generation: entry.state.generation, offset, expires: Date.now() + 300_000 });
    while (cursors.size > 512) cursors.delete(cursors.keys().next().value!);
    coverage.nextCursor = token; coverage.reasons.push('response_limit'); coverage.state = 'partial';
  }
  return { observations, summary: summarizeSkills(all), coverage };
}

/** Authorized incremental session projection; cached results never bypass canonical registry checks. */
export async function readSessionSkills(sessionId: string, provider: string, userId: number | null,
  options: { cursor?: string; signal?: AbortSignal } = {}): Promise<SessionSkillProjection> {
  const auth = authorize(sessionId, provider, userId);
  if (provider !== 'claude' && provider !== 'codex') return emptyProjection(false);
  if (auth.owner === null) return emptyProjection(true, 'source_unavailable');
  const key = cacheKey(auth.principal, provider, sessionId);
  if (loading.has(key)) await loading.get(key);
  let entry = cache.get(key);
  if (entry && entry.state.registryScope !== auth.scope) { cache.delete(key); entry = undefined; }
  if (options.cursor && !entry) throw new AppError('Skill cursor expired. Reload the first page.', {
    code: 'SKILL_CURSOR_EXPIRED', statusCode: 409,
  });
  if (!entry) {
    if (principals.has(auth.principal) || principals.size >= 2) return emptyProjection(true, 'scan_budget');
    principals.add(auth.principal);
    const promise = (async (): Promise<Entry | null> => {
      try {
        const state = await createState(auth.principal, provider, sessionId, auth.owner!, auth.row.jsonl_path, auth.row.project_path, auth.scope);
        if (!state || options.signal?.aborted) return null;
        const created: Entry = { state, lastUsed: Date.now(), epoch: randomBytes(16).toString('hex') };
        created.flight = scan(created, options.signal);
        cache.set(key, created); trimCache();
        await created.flight;
        created.flight = undefined; trimCache();
        return created;
      } finally { principals.delete(auth.principal); loading.delete(key); }
    })();
    loading.set(key, promise);
    entry = await promise ?? undefined;
    if (!entry) return emptyProjection(true, 'source_unavailable');
  }
  entry.lastUsed = Date.now();
  if (!options.cursor && Date.now() - entry.state.updatedAt >= 2000 && !entry.flight) {
    // Refuse excess scans immediately: zero queued work is within the eight-job ceiling.
    if (principals.has(auth.principal) || principals.size >= 2) return emptyProjection(true, 'scan_budget');
    principals.add(auth.principal);
    entry.flight = scan(entry, options.signal).finally(() => {
      principals.delete(auth.principal); entry!.flight = undefined;
    });
  }
  if (entry.flight) await entry.flight;
  const recheck = authorize(sessionId, provider, userId);
  if (recheck.scope !== auth.scope || entry.state.registryScope !== recheck.scope) throw noAccess();
  if (options.signal?.aborted) return emptyProjection(true, 'aborted');
  return page(key, entry, options.cursor);
}

/** Cache-only authorized union: never walks transcripts from the project stats GET. */
export function readProjectSkills(projectPath: string, userId: number, window?: { since?: number; until?: number }): ProjectSkillProjection {
  const events = new Map<string, SkillObservation>();
  const result: ProjectSkillProjection = { summary: summarizeSkills([]), rows: [], coverage: emptyCoverage(true),
    eligibleSessions: 0, scannedSessions: 0, partialSessions: 0, unavailableSessions: 0 };
  const reasons = new Set<SkillCoverage['reasons'][number]>();
  for (const row of sessionsDb.getSessionsByProjectPath(projectPath)) {
    let auth;
    try { auth = authorize(row.session_id, row.provider, userId); } catch { continue; }
    result.eligibleSessions++;
    const entry = cache.get(cacheKey(userId, row.provider, row.session_id));
    if (!entry || entry.state.registryScope !== auth.scope || entry.flight) { result.unavailableSessions++; reasons.add('cold_cache'); continue; }
    const coverage = coverageFor(entry.state);
    if (coverage.state === 'complete') result.scannedSessions++; else result.partialSessions++;
    coverage.reasons.forEach((reason) => reasons.add(reason));
    result.coverage.scannedSources += coverage.scannedSources;
    result.coverage.discoveredSources += coverage.discoveredSources;
    if (!result.coverage.asOf || coverage.asOf! < result.coverage.asOf) result.coverage.asOf = coverage.asOf;
    for (const event of entry.state.observations.values()) {
      if (window) {
        if (!event.occurredAt) { reasons.add('unknown_timestamp'); continue; }
        const ms = Date.parse(event.occurredAt);
        if (window.since !== undefined && ms < window.since || window.until !== undefined && ms > window.until) continue;
      }
      events.set(event.id, event);
    }
  }
  result.summary = summarizeSkills(events.values());
  const groups = new Map<string, SkillObservation[]>();
  for (const event of events.values()) {
    const group = groups.get(event.skillKey);
    if (group) group.push(event); else groups.set(event.skillKey, [event]);
  }
  result.rows = [...groups].slice(0, 100).map(([skillKey, values]) => ({ skillKey, skillName: values[0].skillName, summary: summarizeSkills(values) }));
  if (groups.size > 100) reasons.add('response_limit');
  result.coverage.reasons = [...reasons];
  result.coverage.discoveryComplete = result.unavailableSessions === 0 && result.partialSessions === 0;
  result.coverage.state = result.unavailableSessions === result.eligibleSessions && result.eligibleSessions > 0
    ? 'unavailable' : reasons.size || result.partialSessions ? 'partial' : 'complete';
  return result;
}
