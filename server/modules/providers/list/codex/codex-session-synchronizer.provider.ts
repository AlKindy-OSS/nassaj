import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
  readUtf8Tail,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

import { isCodexRolloutNameOf } from '../../shared/session-transcript-specs.js';

import { codexHomeForSessionFile, resolveCodexHomes } from './codex-home.js';

const warnedMismatchedNames = new Set<string>();
const MAX_WARNED_NAMES = 2048;

/** Logs once per content id that a rollout under another name was not recorded (no path logged). */
function warnMismatchedName(sessionId: string): void {
  if (warnedMismatchedNames.has(sessionId)) return;
  if (warnedMismatchedNames.size >= MAX_WARNED_NAMES) warnedMismatchedNames.clear();
  warnedMismatchedNames.add(sessionId);
  console.warn('Skipped a Codex rollout whose name is not its session_meta id (ADR-201 L7)', {
    event: 'codex_rollout_name_mismatch', sessionId,
  });
}

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  /**
   * True when this rollout is a CHILD thread — a Codex subagent spawn or a fork —
   * rather than a top-level user conversation. Child threads are folded under
   * their parent conversation and never registered as their own session row
   * (B-CODEX-DEDUP): they carry the same cwd + a near-identical auto-title, so
   * indexing each one produced the "same conversation repeated 27×" sidebar bug.
   */
  isDerivative?: boolean;
  /** Root/parent conversation id a derivative folds under (bumps its freshness). */
  parentThreadId?: string | null;
};

/**
 * Extracted session_meta fields needed to tell a top-level user conversation
 * apart from a Codex subagent/fork thread. Codex writes, on the first line:
 *   - id               → THIS thread's own id (unique per rollout file)
 *   - session_id       → the ROOT conversation id (== id for a real root)
 *   - thread_source    → 'user' for a root, 'subagent' for a delegate spawn
 *   - source           → a string ("exec"/"cli") for a root, but an OBJECT keyed
 *                        by "subagent" for a collaboration spawn thread
 *   - forked_from_id / parent_thread_id → set (== root) only on a child thread
 */
type CodexSessionMeta = {
  sessionId: string;
  projectPath: string;
  threadSource?: string;
  /** True when payload.source is an object keyed by "subagent" (definitive subagent marker). */
  sourceIsSubagent?: boolean;
  forkedFromId?: string;
  parentThreadId?: string;
  rootSessionId?: string;
};

/**
 * Classifies a rollout as a top-level conversation or a folded child thread from
 * its session_meta.
 *
 * NARROW-BY-DESIGN (qa-critic 2026-07-16): the ONLY thing we fold is a Codex
 * SUBAGENT thread. The AUTHORITATIVE signal is the reliable session_meta
 * metadata Codex stamps on the thread itself — `thread_source` (present and
 * !== 'user') and/or a `source` object keyed by "subagent" (upstream 283b5586).
 * Either metadata field, once present, DECIDES alone.
 *
 * A back-reference (forked_from_id / parent_thread_id / a root session_id that
 * differs from the thread's own id) is a weaker child marker: it cannot tell a
 * silent subagent apart from a MANUAL user fork — a real, resumable conversation
 * the user chose to branch, which MUST surface as its own root row (swallowing
 * it would silently hide a conversation). The back-ref signals are therefore a
 * FALLBACK consulted ONLY when NO metadata signal is present at all (an older
 * rollout format that predates the fields).
 *
 * The parent id a folded child bumps prefers the explicit parent/fork pointer,
 * then the root session_id.
 */
function classifyCodexThread(meta: CodexSessionMeta): { isDerivative: boolean; parentThreadId: string | null } {
  const rootDiffers = Boolean(meta.rootSessionId && meta.rootSessionId !== meta.sessionId);
  const hasThreadSource = typeof meta.threadSource === 'string' && meta.threadSource !== '';
  const sourceIsSubagent = meta.sourceIsSubagent === true;
  const hasMetaSignal = hasThreadSource || sourceIsSubagent;

  const isDerivative = hasMetaSignal
    // Metadata is authoritative: fold explicit subagent threads — thread_source
    // present and !== 'user', OR a source object keyed by "subagent". A user fork
    // (thread_source 'user', no subagent source) is NOT folded.
    ? (hasThreadSource && meta.threadSource !== 'user') || sourceIsSubagent
    // Legacy fallback (no metadata signal at all): infer a child from back-references.
    : Boolean(meta.forkedFromId) || Boolean(meta.parentThreadId) || rootDiffers;

  const parentThreadId =
    meta.parentThreadId ||
    meta.forkedFromId ||
    (rootDiffers ? meta.rootSessionId ?? null : null) ||
    null;

  return { isDerivative, parentThreadId };
}

/**
 * Session indexer for Codex transcript artifacts.
 */
export class CodexSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'codex' as const;

  /**
   * Scans EVERY relevant Codex home (the operator ~/.codex plus each isolated
   * user's per-user CODEX_HOME — B-152) and upserts discovered sessions into DB.
   * The set collapses to just ~/.codex when codex is shared, so shared/single-user
   * installs keep the original single-tree scan.
   */
  async synchronize(since?: Date): Promise<number> {
    let processed = 0;
    for (const codexHome of resolveCodexHomes()) {
      processed += await this.synchronizeHome(codexHome, since);
    }
    return processed;
  }

  /**
   * Scans one Codex home's `sessions/` tree, resolving session names from that
   * SAME home's `session_index.jsonl` so an isolated user's names are not looked
   * up against the operator index.
   */
  private async synchronizeHome(codexHome: string, since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(codexHome, 'session_index.jsonl'), 'id', 'thread_name');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(codexHome, 'sessions'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      // Child thread (subagent/fork): fold under the parent — never its own row.
      // Best-effort bump keeps the parent conversation surfacing recent activity.
      if (parsed.isDerivative) {
        await this.bumpParent(parsed, filePath);
        continue;
      }

      // The name rides on the refresh (custom_name), so a file refused by the
      // ADR-201 source rules cannot rename the row either.
      if (await this.recordSession(parsed, filePath)) processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Codex session JSONL file. The owning Codex home is
   * derived from the file path itself (B-152), so a watcher event fired inside an
   * isolated user's tree resolves its names from that user's index — not ~/.codex.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const codexHome = codexHomeForSessionFile(filePath);
    const nameMap = await buildLookupMap(path.join(codexHome, 'session_index.jsonl'), 'id', 'thread_name');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    // Child thread (subagent/fork): fold under the parent — never its own row.
    // The watcher fires this per newly-written rollout, so this is the hot path
    // that used to spawn a fresh sidebar row per delegate spawn.
    if (parsed.isDerivative) {
      await this.bumpParent(parsed, filePath);
      return null;
    }

    return this.recordSession(parsed, filePath);
  }

  /**
   * Best-effort parent freshness bump for a folded child thread, applied only
   * when the child file sits in the parent row's source tree (ADR-201 A2).
   */
  private async bumpParent(parsed: ParsedSession, filePath: string): Promise<void> {
    if (!parsed.parentThreadId) return;
    const childTimestamps = await readFileTimestamps(filePath);
    sessionsDb.bumpSessionUpdatedAtFromChild(parsed.parentThreadId, childTimestamps.updatedAt, filePath);
  }

  /**
   * Records one root rollout through the ADR-201 discovery writers. A rollout
   * not named `rollout-…-<session_meta id>.jsonl` (a copy or a forgery, A3)
   * neither refreshes nor inserts a row (R4, the Claude L7 rule): it is logged
   * once and null is returned. The name rule is the reader's own
   * ({@link isCodexRolloutNameOf}), so a recorded row is always readable.
   */
  private async recordSession(parsed: ParsedSession, filePath: string): Promise<string | null> {
    if (!isCodexRolloutNameOf(path.basename(filePath), parsed.sessionId)) {
      warnMismatchedName(parsed.sessionId);
      return null;
    }
    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.recordDiscoveredSession({
      sessionId: parsed.sessionId,
      provider: this.provider,
      projectPath: parsed.projectPath,
      customName: parsed.sessionName,
      createdAt: timestamps.createdAt,
      updatedAt: timestamps.updatedAt,
      jsonlPath: filePath,
    });
  }

  /**
   * Extracts session metadata from one Codex JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    // B-1616: identity is the FIRST record only. A 0.160 child rollout carries its
    // parent's session_meta (thread_source "user") as line 1; scanning past an
    // unusable line 0 would re-identify the child as its parent. The first record
    // therefore always ends the scan: usable → its meta, anything else → no row.
    const first = await extractFirstValidJsonlData<{ meta: CodexSessionMeta | null }>(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      // Anchor on the session_meta record specifically (robustness): a future
      // rollout format could emit an earlier line that happens to carry id+cwd,
      // and classifying it off the wrong record would mis-fold a real root. Only
      // the session_meta line carries the authoritative thread identity.
      if (data?.type !== 'session_meta') {
        return { meta: null };
      }
      const payload = data.payload as Record<string, unknown> | undefined;
      const sessionId = typeof payload?.id === 'string' ? payload.id : undefined;
      const projectPath = typeof payload?.cwd === 'string' ? payload.cwd : undefined;

      if (!sessionId || !projectPath) {
        return { meta: null };
      }

      // Top-level sessions carry a string source ("exec"/"cli"); a subagent
      // collaboration spawn carries an OBJECT keyed by "subagent" (283b5586).
      const source = payload?.source;
      const sourceIsSubagent =
        typeof source === 'object' && source !== null && 'subagent' in source;

      return { meta: {
        sessionId,
        projectPath,
        threadSource: typeof payload?.thread_source === 'string' ? payload.thread_source : undefined,
        sourceIsSubagent,
        forkedFromId: typeof payload?.forked_from_id === 'string' ? payload.forked_from_id : undefined,
        parentThreadId: typeof payload?.parent_thread_id === 'string' ? payload.parent_thread_id : undefined,
        rootSessionId: typeof payload?.session_id === 'string' ? payload.session_id : undefined,
      } };
    });
    const parsed = first?.meta ?? null;

    if (!parsed) {
      return null;
    }

    // Fold subagent/fork threads under the parent conversation: they are NOT
    // registered as standalone rows (B-CODEX-DEDUP). Returned early with the
    // parent pointer so the caller can bump the parent's freshness; no name
    // resolution is done since a folded thread never surfaces its own title.
    const { isDerivative, parentThreadId } = classifyCodexThread(parsed);
    if (isDerivative) {
      return {
        sessionId: parsed.sessionId,
        projectPath: parsed.projectPath,
        isDerivative: true,
        parentThreadId,
      };
    }

    const existingSession = sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Codex Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Codex Session'),
      };
    }

    let sessionName = nameMap.get(parsed.sessionId);
    if (!sessionName) {
      sessionName = await this.extractLastAgentMessageFromEnd(filePath);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Codex Session'),
    };
  }

  private async extractLastAgentMessageFromEnd(filePath: string): Promise<string | undefined> {
    try {
      // Tail only: the latest entry is what we want, and whole-file reads OOM'd (B-954).
      const content = await readUtf8Tail(filePath);
      const lines = content.split(/\r?\n/);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const payload = data.payload as Record<string, unknown> | undefined;
        const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
        const lastAgentMessage = typeof payload?.last_agent_message === 'string'
          ? payload.last_agent_message
          : undefined;

        if (eventType === 'event_msg' && payloadType === 'task_complete' && lastAgentMessage?.trim()) {
          return lastAgentMessage;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}
