import { realpathSync, type Stats } from 'node:fs';
import { readdir, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb, userDb } from '@/modules/database/index.js';
import { getAntigravityProjectPath } from '@/modules/providers/list/antigravity/antigravity-project-registry.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';
import { normalizeSessionName, readObjectRecord } from '@/shared/utils.js';
import { userConfigDir } from '@/services/isolation/provision-user-dirs.js';
import { isProviderIsolated } from '@/services/provider-sharing.js';

import { isReplaceableStoredTitle, promptTitleText } from '../../shared/session-title-source.js';
import { isTranscriptHandle, openRunTranscript } from '../../shared/session-transcript-reader.js';

const ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH = '/__antigravity__';

/** Where agy files its brain store under one HOME. */
const BRAIN_RELATIVE_PATH = path.join('.gemini', 'antigravity-cli', 'brain');

/**
 * B-227 member-brain indexing, switched OFF for release 2.3.1.0 (owner option A).
 * Sessions from member brains land in the ownerless `/__antigravity__` placeholder
 * project, so any member could read them by id/search/archive/deep link/share.
 * Re-enable (flip to true) only with the follow-up ownership fix: a provenance
 * participant on each indexed row plus a placeholder-session access predicate.
 */
const INDEX_MEMBER_BRAINS = false;

/** Canonical form for de-duplication: the real path when it exists, else the resolved one. */
const canonicalDir = (dir: string): string => {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

type ParsedAgyMetadata = {
  sessionId: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  transcriptPath: string;
};

/**
 * Session indexer for the Antigravity (agy) CLI brain transcripts.
 *
 * agy stores one chat per UUID under `~/.gemini/antigravity-cli/brain/<UUID>/`
 * with the live transcript at `.system_generated/logs/transcript.jsonl`. This
 * synchronizer scans the operator's brain root (member brains: see INDEX_MEMBER_BRAINS), derives session metadata from the first
 * transcript line, and upserts rows so the rest of the app can browse agy
 * conversations like any other provider.
 *
 * Note on `project_path`: agy does not record the workspace inside the transcript.
 * We use a stable placeholder so the FK to `projects` resolves; resolving the
 * real project root is deferred to a later phase.
 */
export class AntigravitySessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'antigravity' as const;

  /** How long a brain-dir enumeration is reused for per-file (watcher) events. */
  static readonly BRAIN_DIRS_CACHE_MS = 30_000;

  /** Canonical path → brain dir, from the last enumeration, and when it was taken. */
  private brainDirsCache: { at: number; dirs: Map<string, string> } | null = null;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly indexMemberBrains: boolean = INDEX_MEMBER_BRAINS,
  ) {}

  /**
   * B-227: every brain directory whose sessions must be indexed — the operator's
   * plus, when member indexing is on (INDEX_MEMBER_BRAINS) and agy is isolated, each ACTIVE member's own brain under the HOME the
   * spawn gives them (`~/.nassaj-users/<id>`, the root resolveProviderEnv sets for
   * a member's own agy tree; grants are not followed, so a grantor's brain is
   * indexed once, as their own). This used to be the operator's brain only, so an
   * isolated member's agy chats were written to their tree and never indexed.
   *
   * Read-only: the path is computed, never provisioned, so a disabled member or
   * one who never ran agy gets no tree created by the indexer — a missing brain
   * dir simply scans as zero. Each member is resolved in its own try, so one bad
   * row never drops the others. De-duplicated on the real path, so shared mode
   * collapses to one directory.
   */
  private enumerateBrainDirs(): Map<string, string> {
    const dirs = new Map<string, string>();
    const add = (dir: string) => {
      const key = canonicalDir(dir);
      if (!dirs.has(key)) dirs.set(key, dir);
    };
    add(path.join(os.homedir(), BRAIN_RELATIVE_PATH));
    let members: Array<{ id: number; status?: string }> = [];
    try {
      members = this.indexMemberBrains && isProviderIsolated('agy') ? userDb.listUsers() : [];
    } catch (error) {
      console.error('Failed to enumerate members for agy brain indexing; operator brain only', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const member of members) {
      let userId: unknown = 'unknown';
      try {
        if (member.status !== 'active') continue;
        userId = member.id;
        add(path.join(userConfigDir(member.id, ''), BRAIN_RELATIVE_PATH));
      } catch (error) {
        console.error('Failed to resolve one member agy brain dir; skipping it', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.brainDirsCache = { at: this.now(), dirs };
    return dirs;
  }

  /** The brain-dir enumeration, reused for up to BRAIN_DIRS_CACHE_MS (per-file events). */
  private cachedBrainDirs(): Map<string, string> {
    const cache = this.brainDirsCache;
    if (cache && this.now() - cache.at < AntigravitySessionSynchronizer.BRAIN_DIRS_CACHE_MS) {
      return cache.dirs;
    }
    return this.enumerateBrainDirs();
  }

  /**
   * Scans agy brain UUIDs in every resolved brain directory and upserts each
   * session that has a transcript file.
   *
   * The `since` filter compares against the transcript mtime so the watcher can
   * cheaply re-sync only conversations that changed after the previous scan.
   */
  async synchronize(since?: Date): Promise<number> {
    let processed = 0;
    // A full scan always re-enumerates, so a new member is picked up at once.
    for (const brainDir of this.enumerateBrainDirs().values()) {
      processed += await this.synchronizeBrainDir(brainDir, since);
    }
    return processed;
  }

  /** Indexes one brain directory; a missing directory (agy never run there) counts zero. */
  private async synchronizeBrainDir(brainDir: string, since?: Date): Promise<number> {
    let uuids: string[];
    try {
      uuids = await readdir(brainDir);
    } catch {
      // The brain directory only appears after the first successful agy run.
      return 0;
    }

    let processed = 0;
    for (const uuid of uuids) {
      const parsed = await this.parseBrainSession(brainDir, uuid, since);
      if (!parsed) {
        continue;
      }

      sessionsDb.recordDiscoveredSession({
        sessionId: parsed.sessionId,
        provider: this.provider,
        projectPath: this.resolveProjectPath(parsed.sessionId),
        customName: this.customNameFor(parsed),
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        jsonlPath: parsed.transcriptPath,
        origin: 'watcher',
      });
      processed += 1;
    }

    return processed;
  }

  /**
   * Resolves the project path to persist for a brain UUID.
   *
   * agy-cli.js registers a freshly created session under its real workspace
   * `cwd` as soon as it discovers the brain UUID. Two sources can carry that
   * real path, checked in order:
   *
   * 1. An existing non-placeholder `project_path` already on the DB row. The
   *    ADR-201 refresh already refuses real → placeholder moves; reusing the
   *    stored path keeps that a no-op instead of a logged conflict.
   * 2. The in-process registry populated by the spawn adapter. This closes the
   *    race where a synchronize() (boot/refresh/watcher) reaches a brand-new
   *    brain UUID *before* the close handler has written the real path to the DB:
   *    without it the first sync would file the placeholder and nothing would
   *    ever correct it.
   *
   * Only when neither source knows the workspace do we fall back to the
   * placeholder — e.g. conversations created directly in the standalone agy app.
   */
  private resolveProjectPath(sessionId: string): string {
    const existing = sessionsDb.getSessionById(sessionId);
    const existingPath = existing?.project_path?.trim();
    if (existingPath && existingPath !== ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH) {
      return existingPath;
    }

    const registeredPath = getAntigravityProjectPath(sessionId);
    if (registeredPath) {
      return registeredPath;
    }

    return ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH;
  }

  /**
   * Indexes one agy transcript file. The caller passes the absolute transcript path.
   *
   * Returns the upserted session id, or null when the file is not an agy
   * transcript or its UUID cannot be derived.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('transcript.jsonl')) {
      return null;
    }

    const uuid = this.extractUuidFromTranscriptPath(filePath);
    if (!uuid) {
      return null;
    }

    // The transcript must live in one of the brain dirs this indexer owns; a
    // path anywhere else is not an agy session we index.
    const brainDir = this.brainDirOfTranscript(filePath);
    if (!brainDir) {
      return null;
    }

    const parsed = await this.parseBrainSession(brainDir, uuid, null);
    if (!parsed) {
      return null;
    }

    return sessionsDb.recordDiscoveredSession({
      sessionId: parsed.sessionId,
      provider: this.provider,
      projectPath: this.resolveProjectPath(parsed.sessionId),
      customName: this.customNameFor(parsed),
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      jsonlPath: parsed.transcriptPath,
      origin: 'watcher',
    });
  }

  /** How many leading transcript lines we scan for the first USER_INPUT title. */
  private readonly TITLE_SCAN_LINE_LIMIT = 10;

  /** Byte bound of that leading scan (the old whole-file read had none). */
  private readonly TITLE_SCAN_BYTE_LIMIT = 4 * 1024 * 1024;

  /**
   * Reads the transcript for one brain UUID and produces session metadata.
   *
   * - Title comes from the first USER_INPUT `<USER_REQUEST>` body. agy may emit
   *   system lines (e.g. CONVERSATION_HISTORY) before the human turn, so we scan
   *   the leading lines for the first USER_INPUT rather than assuming line 0.
   * - `created_at` is read from the first transcript line.
   * - `updated_at` is the transcript file mtime.
   * - When `since` is provided, sessions whose transcript mtime is older are skipped.
   */
  private async parseBrainSession(
    brainDir: string,
    uuid: string,
    since: Date | null | undefined,
  ): Promise<ParsedAgyMetadata | null> {
    if (!this.isValidUuid(uuid)) {
      return null;
    }

    const transcriptPath = path.join(
      brainDir,
      uuid,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );

    // ADR-201 A1, discovery read (no row may exist yet): confined to this brain
    // dir, pinned single-link, bound to `uuid` by its brain directory.
    const opened = await openRunTranscript({
      provider: 'antigravity', sessionId: uuid, candidate: transcriptPath, root: brainDir, purpose: 'sync-discovery',
    });
    if (!isTranscriptHandle(opened)) {
      return null;
    }

    let fileStat: Stats;
    let leadingRecords: AnyRecord[];
    try {
      fileStat = await opened.fd.stat();
      if (since && fileStat.mtime <= since) {
        return null;
      }
      // Parse only the leading transcript lines. Transcripts can be huge, so we
      // read a bounded prefix and stop at TITLE_SCAN_LINE_LIMIT lines.
      leadingRecords = await this.readLeadingRecords(opened.fd);
    } finally {
      await opened.fd.close().catch(() => undefined);
    }
    const firstLine = leadingRecords[0] ?? null;

    const title = this.extractTitleFromLeadingRecords(leadingRecords);
    const createdAtFromTranscript = typeof firstLine?.created_at === 'string'
      ? firstLine.created_at
      : undefined;
    const createdAt = this.toIsoString(createdAtFromTranscript)
      ?? fileStat.birthtime.toISOString();

    return {
      sessionId: uuid,
      title: title ? normalizeSessionName(title, '') : undefined,
      createdAt,
      updatedAt: fileStat.mtime.toISOString(),
      transcriptPath,
    };
  }

  /**
   * Reads at most TITLE_SCAN_LINE_LIMIT leading JSONL records from a transcript.
   *
   * Transcripts can be very large, so we cap the read at the byte span covering
   * the first N newlines instead of loading the whole file. Each line is parsed
   * independently; a malformed line is skipped rather than aborting the scan so
   * a single bad record never costs us the session metadata.
   */
  private async readLeadingRecords(handle: FileHandle): Promise<AnyRecord[]> {
    let content: string;
    try {
      const buffer = Buffer.alloc(this.TITLE_SCAN_BYTE_LIMIT);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      content = buffer.toString('utf8', 0, bytesRead);
    } catch {
      return [];
    }

    const records: AnyRecord[] = [];
    let cursor = 0;
    while (records.length < this.TITLE_SCAN_LINE_LIMIT && cursor <= content.length) {
      const newlineIndex = content.indexOf('\n', cursor);
      const end = newlineIndex >= 0 ? newlineIndex : content.length;
      const lineRaw = content.slice(cursor, end).trim();
      if (lineRaw) {
        try {
          const record = readObjectRecord(JSON.parse(lineRaw));
          if (record) {
            records.push(record);
          }
        } catch {
          // Skip an unparseable line; keep scanning the remaining lines.
        }
      }
      if (newlineIndex < 0) {
        break;
      }
      cursor = newlineIndex + 1;
    }

    return records;
  }

  /**
   * Pulls the user prompt out of the first USER_INPUT record with user text,
   * for use as the title.
   *
   * agy can emit system records (e.g. CONVERSATION_HISTORY) before the human's
   * first turn, so we scan the leading records for USER_INPUT instead of
   * assuming line 0. The `<USER_REQUEST>` body is cleaned of every injected
   * block (`<instructions>`, `<nassaj_document_sharing>`, image lists …) —
   * machine directives must not become the conversation name. When nothing
   * user-authored remains we return undefined and no title is written; the
   * client shows its own localized "new session" label (B-1668).
   */
  private extractTitleFromLeadingRecords(records: AnyRecord[]): string | undefined {
    for (const record of records) {
      if (record.type !== 'USER_INPUT' || typeof record.content !== 'string') continue;
      const request = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(record.content)?.[1];
      // B-1668: the shared title cleaning also removes `<nassaj_document_sharing>`
      // and every other injected block, not `<instructions>` alone.
      const title = promptTitleText(request ?? record.content);
      if (title) return title;
    }
    return undefined;
  }

  /**
   * The name to write for one parsed session. A stored name that is not
   * replaceable — a user rename included — is kept (undefined leaves the
   * column as it is), and a transcript with no user text writes no placeholder.
   */
  private customNameFor(parsed: ParsedAgyMetadata): string | undefined {
    const stored = sessionsDb.getSessionById(parsed.sessionId)?.custom_name;
    return stored && !isReplaceableStoredTitle(stored) ? undefined : parsed.title;
  }

  /**
   * Recovers a brain UUID from an absolute transcript path emitted by the watcher.
   */
  private extractUuidFromTranscriptPath(filePath: string): string | null {
    const segments = filePath.split(path.sep);
    const logsIndex = segments.lastIndexOf('logs');
    if (logsIndex < 3) {
      return null;
    }

    const candidate = segments[logsIndex - 2];
    if (!candidate || !this.isValidUuid(candidate)) {
      return null;
    }

    return candidate;
  }

  /**
   * The resolved brain dir that holds `<brainDir>/<uuid>/.system_generated/logs/transcript.jsonl`,
   * or null when the transcript's brain dir is not one this indexer owns.
   */
  private brainDirOfTranscript(filePath: string): string | null {
    const dirs = this.cachedBrainDirs();
    const candidate = path.resolve(filePath, '..', '..', '..', '..');
    for (const dir of dirs.values()) {
      if (path.resolve(dir) === candidate) return dir;
    }
    // Only a path written through a symlink needs the one realpath lookup.
    return dirs.get(canonicalDir(candidate)) ?? null;
  }

  /**
   * Conservative UUID v4-ish check so we never index hidden files or stray folders.
   */
  private isValidUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  /**
   * Normalizes a transcript timestamp to ISO 8601; returns undefined on bad input.
   */
  private toIsoString(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return undefined;
    }
    return parsed.toISOString();
  }
}
