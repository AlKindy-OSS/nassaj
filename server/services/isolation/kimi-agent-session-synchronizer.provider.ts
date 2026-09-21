import path from 'node:path';
import { readdir } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import {
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';

import { resolveKimiHomes } from './kimi-agent-home.js';

/**
 * kimi-agent-session-synchronizer — KM-2 (ADR-062 §4.2, wave W4-C): indexes the
 * native Kimi agent CLI (`@moonshot-ai/kimi-code`, KG-1) session transcripts into
 * sessionsDb, with NATURAL subagent folding by directory structure so a single
 * conversation NEVER surfaces N+1 near-identical sidebar rows (the B-172 / codex
 * B-CODEX-DEDUP class of bug).
 *
 * THE LAYOUT (KG-1 §1.1):
 *   <KIMI_CODE_HOME>/sessions/<id>/agents/<agentId>/wire.jsonl
 *
 * The CONVERSATION is the `sessions/<id>` directory; every `<agentId>` under it —
 * the MAIN agent plus each spawned subagent — writes its OWN wire.jsonl. The
 * dedup guarantee is therefore STRUCTURAL and value-agnostic: a session row is
 * keyed on `<id>` (the conversation dir), so however many agent folders a
 * conversation spawns, they all collapse to the ONE `<id>` row. Only the PRIMARY
 * agent's transcript creates/attributes that row; every sibling subagent
 * transcript is FOLDED — it bumps the parent's freshness and is never registered
 * as its own row.
 *
 * WHICH agent is primary (the parent, MAIN_AGENT_ID): resolved from the FILESYSTEM
 * (the set of `agents/<agentId>` dirs actually present), NOT from the filtered
 * scan batch — so an INCREMENTAL scan that only saw a freshly-written subagent
 * file still correctly identifies it as a subagent (the main folder is on disk)
 * and folds it, rather than mistaking it for the primary. The rule:
 *   primary = MAIN_AGENT_ID when that folder exists, else the lexicographically
 *             smallest agentId present (a DETERMINISTIC single-row guarantee that
 *             holds even before the exact MAIN_AGENT_ID value is field-CONFIRMED).
 *
 * FIELD-CONFIRMED AT G-KIMI-LIVE (§4.5): kimi is NOT installed on this node, so
 * (a) the MAIN agent folder's exact name and (b) the wire.jsonl meta field
 * spellings (cwd / title) are taken from KG-1 research + the codex/gemini
 * precedent. Both are read DEFENSIVELY here and are single-point corrections when
 * the live tree is captured — the row-key (`<id>`) and the fold semantics do not
 * change. MAIN_AGENT_ID is additionally overridable via the KIMI_MAIN_AGENT_ID
 * env var so a live correction needs no code change on a running fleet node.
 */

/** The transcript filename kimi writes per agent thread (KG-1 §1.1). */
const WIRE_FILENAME = 'wire.jsonl';

/** The path segment separating the conversation id from its per-agent subtrees. */
const AGENTS_SEGMENT = 'agents';

/** DB session-name fallback for a Kimi conversation with no resolvable title. */
const KIMI_SESSION_FALLBACK_NAME = 'Untitled Kimi Session';

/**
 * The MAIN (parent) agent folder name a conversation's root turn writes under. A
 * conservative default of 'main', overridable via KIMI_MAIN_AGENT_ID (field-
 * CONFIRMED at G-KIMI-LIVE). The dedup guarantee does NOT depend on this value
 * being exactly right — see resolvePrimaryAgentId — it only decides WHICH agent's
 * transcript names the single `<id>` row when several agents are present.
 */
export const KIMI_MAIN_AGENT_ID: string =
  (typeof process.env.KIMI_MAIN_AGENT_ID === 'string' && process.env.KIMI_MAIN_AGENT_ID.trim()) ||
  'main';

/** The `<id>` + `<agentId>` a transcript path belongs to, plus its owning home. */
type KimiAgentPathParts = {
  home: string;
  sessionId: string;
  agentId: string;
};

/**
 * Parses a Kimi agent transcript path into its owning home, conversation id and
 * agent id. Returns null for any path that is not a
 * `.../sessions/<id>/agents/<agentId>/wire.jsonl` file, so a stray/malformed file
 * can never be mis-indexed as a conversation.
 */
export function parseKimiAgentSessionPath(filePath: string): KimiAgentPathParts | null {
  if (path.basename(filePath) !== WIRE_FILENAME) {
    return null;
  }
  const marker = `${path.sep}${'sessions'}${path.sep}`;
  const markerIndex = filePath.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }
  const home = filePath.slice(0, markerIndex);
  const rest = filePath.slice(markerIndex + marker.length); // <id>/agents/<agentId>/wire.jsonl
  const parts = rest.split(path.sep);
  // Expect exactly [<id>, 'agents', <agentId>, 'wire.jsonl'].
  if (parts.length < 4) {
    return null;
  }
  const [sessionId, agentsSegment, agentId] = parts;
  if (agentsSegment !== AGENTS_SEGMENT || !sessionId || !agentId) {
    return null;
  }
  return { home, sessionId, agentId };
}

/**
 * Picks the PRIMARY (parent) agent id from the set present under a conversation's
 * `agents/` dir: MAIN_AGENT_ID when present, else the lexicographically smallest
 * id — a deterministic choice that GUARANTEES exactly one row per conversation
 * even before MAIN_AGENT_ID is field-confirmed. Returns null for an empty set.
 */
export function resolvePrimaryAgentId(agentIds: string[]): string | null {
  if (agentIds.length === 0) {
    return null;
  }
  if (agentIds.includes(KIMI_MAIN_AGENT_ID)) {
    return KIMI_MAIN_AGENT_ID;
  }
  return [...agentIds].sort()[0];
}

type KimiSessionMeta = {
  projectPath: string;
  sessionName: string;
};

/** First non-empty string among candidates, else undefined (defensive extractor). */
function firstNonEmptyString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Session indexer for Kimi native-agent transcript artifacts.
 */
export class KimiAgentSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'kimi' as const;

  /**
   * Scans EVERY relevant Kimi home (the operator ~/.kimi plus each isolated
   * user's per-user KIMI_CODE_HOME) and upserts discovered conversations. The set
   * collapses to just ~/.kimi when kimi is shared, so shared/single-user installs
   * keep a single-tree scan.
   */
  async synchronize(since?: Date): Promise<number> {
    let processed = 0;
    for (const kimiHome of resolveKimiHomes()) {
      processed += await this.synchronizeHome(kimiHome, since);
    }
    return processed;
  }

  /**
   * Scans one home's `sessions/` tree for wire.jsonl transcripts. A per-scan cache
   * keyed on each conversation's `agents/` dir avoids re-reading the same
   * directory once per agent file.
   */
  private async synchronizeHome(kimiHome: string, since?: Date): Promise<number> {
    const sessionsRoot = path.join(kimiHome, 'sessions');
    const files = await findFilesRecursivelyCreatedAfter(sessionsRoot, '.jsonl', since ?? null);

    const primaryCache = new Map<string, string | null>();
    let processed = 0;
    for (const filePath of files) {
      const indexed = await this.processFile(filePath, primaryCache);
      if (indexed) {
        processed += 1;
      }
    }
    return processed;
  }

  /**
   * Parses and upserts one Kimi transcript file without a full scan (the watcher
   * hot path fired per newly-written wire.jsonl — the exact place that would
   * otherwise spawn a fresh sidebar row per subagent spawn).
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (path.basename(filePath) !== WIRE_FILENAME) {
      return null;
    }
    return this.processFile(filePath);
  }

  /**
   * The shared per-file pipeline used by BOTH the full scan and the watcher, so
   * folding behaves identically on either path:
   *   1. parse the path → conversation `<id>` + `<agentId>` (skip non-transcripts);
   *   2. resolve the conversation's PRIMARY agent from the on-disk `agents/` set;
   *   3. a SUBAGENT (agentId !== primary) is FOLDED — bump the parent `<id>`'s
   *      freshness (a no-op when the parent row is absent, so an out-of-order or
   *      orphan subagent never conjures a row) and return null;
   *   4. the PRIMARY agent creates/updates the ONE `<id>` conversation row.
   */
  private async processFile(
    filePath: string,
    primaryCache?: Map<string, string | null>,
  ): Promise<string | null> {
    const parsed = parseKimiAgentSessionPath(filePath);
    if (!parsed) {
      return null;
    }

    const agentsDir = path.join(parsed.home, 'sessions', parsed.sessionId, AGENTS_SEGMENT);
    let primary = primaryCache?.get(agentsDir);
    if (primary === undefined) {
      const agentIds = await this.listAgentDirs(agentsDir);
      // Fall back to the file's own agentId if the dir read came back empty (a
      // race where the transcript exists but the dir listing missed it): the
      // conversation still surfaces rather than being silently dropped.
      primary = resolvePrimaryAgentId(agentIds.length > 0 ? agentIds : [parsed.agentId]);
      primaryCache?.set(agentsDir, primary);
    }

    // Fold a subagent thread under its parent conversation: never its own row.
    if (parsed.agentId !== primary) {
      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.bumpSessionUpdatedAt(parsed.sessionId, timestamps.updatedAt);
      return null;
    }

    // Primary agent: index the ONE conversation row keyed on `<id>`.
    const meta = await this.extractMeta(filePath);
    if (!meta) {
      // No usable projectPath (half-written / pre-field transcript): skip rather
      // than create a malformed row (codex/vendor synchronizer precedent).
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      meta.projectPath,
      meta.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath,
    );
  }

  /**
   * Lists the immediate `agents/<agentId>` subdirectory names. Missing/unreadable
   * dirs yield [] so indexing continues (first-run / partial trees are expected).
   */
  private async listAgentDirs(agentsDir: string): Promise<string[]> {
    try {
      const entries = await readdir(agentsDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  /**
   * Reads a conversation's project path + title from the FIRST valid wire.jsonl
   * line that carries them. DEFENSIVE (field-CONFIRMED at G-KIMI-LIVE): several
   * plausible field spellings are probed for cwd and for a human title, tolerating
   * a top-level object, a `payload`-nested one, or a `meta`-nested one. A
   * transcript with no resolvable projectPath yields null and is skipped.
   */
  private async extractMeta(filePath: string): Promise<KimiSessionMeta | null> {
    return extractFirstValidJsonlData<KimiSessionMeta>(filePath, (rawData) => {
      if (!rawData || typeof rawData !== 'object') {
        return null;
      }
      const data = rawData as Record<string, unknown>;
      const payload = (data.payload ?? data.meta ?? {}) as Record<string, unknown>;

      const projectPath = firstNonEmptyString(
        data.cwd,
        data.projectPath,
        data.project_path,
        data.workingDir,
        data.working_dir,
        payload.cwd,
        payload.projectPath,
        payload.project_path,
      );
      if (!projectPath) {
        return null;
      }

      const title = firstNonEmptyString(
        data.title,
        data.name,
        data.summary,
        data.sessionName,
        data.session_name,
        payload.title,
        payload.name,
        payload.summary,
      );

      return {
        projectPath,
        sessionName: normalizeSessionName(title, KIMI_SESSION_FALLBACK_NAME),
      };
    });
  }
}
