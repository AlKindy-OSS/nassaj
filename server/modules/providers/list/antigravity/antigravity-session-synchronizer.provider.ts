import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { getAntigravityProjectPath } from '@/modules/providers/list/antigravity/antigravity-project-registry.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';
import { normalizeSessionName, readObjectRecord } from '@/shared/utils.js';

const ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH = '/__antigravity__';

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
 * synchronizer scans the brain root, derives session metadata from the first
 * transcript line, and upserts rows so the rest of the app can browse agy
 * conversations like any other provider.
 *
 * Note on `project_path`: agy does not record the workspace inside the transcript.
 * We use a stable placeholder so the FK to `projects` resolves; resolving the
 * real project root is deferred to a later phase.
 */
export class AntigravitySessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'antigravity' as const;
  private readonly brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');

  /**
   * Scans agy brain UUIDs and upserts each session that has a transcript file.
   *
   * The `since` filter compares against the transcript mtime so the watcher can
   * cheaply re-sync only conversations that changed after the previous scan.
   */
  async synchronize(since?: Date): Promise<number> {
    let uuids: string[];
    try {
      uuids = await readdir(this.brainDir);
    } catch {
      // The brain directory only appears after the first successful agy run.
      return 0;
    }

    let processed = 0;
    for (const uuid of uuids) {
      const parsed = await this.parseBrainSession(uuid, since);
      if (!parsed) {
        continue;
      }

      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        this.resolveProjectPath(parsed.sessionId),
        parsed.title,
        parsed.createdAt,
        parsed.updatedAt,
        parsed.transcriptPath,
      );
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
   * 1. An existing non-placeholder `project_path` already on the DB row. Because
   *    `createSession` upserts and overwrites `project_path`, re-syncing the same
   *    UUID with the placeholder would otherwise relocate the session into the
   *    phantom `/__antigravity__` workspace and hide it from the sidebar.
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

    const parsed = await this.parseBrainSession(uuid, null);
    if (!parsed) {
      return null;
    }

    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      this.resolveProjectPath(parsed.sessionId),
      parsed.title,
      parsed.createdAt,
      parsed.updatedAt,
      parsed.transcriptPath,
    );
  }

  /** How many leading transcript lines we scan for the first USER_INPUT title. */
  private readonly TITLE_SCAN_LINE_LIMIT = 10;

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
  private async parseBrainSession(uuid: string, since: Date | null | undefined): Promise<ParsedAgyMetadata | null> {
    if (!this.isValidUuid(uuid)) {
      return null;
    }

    const transcriptPath = path.join(
      this.brainDir,
      uuid,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );

    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(transcriptPath);
    } catch {
      return null;
    }

    if (!fileStat.isFile()) {
      return null;
    }

    if (since && fileStat.mtime <= since) {
      return null;
    }

    // Parse only the leading transcript lines. Transcripts can be huge, so we
    // slice off just the first TITLE_SCAN_LINE_LIMIT lines and stop there.
    const leadingRecords = await this.readLeadingRecords(transcriptPath);
    const firstLine = leadingRecords[0] ?? null;

    const title = this.extractTitleFromLeadingRecords(leadingRecords);
    const createdAtFromTranscript = typeof firstLine?.created_at === 'string'
      ? firstLine.created_at
      : undefined;
    const createdAt = this.toIsoString(createdAtFromTranscript)
      ?? fileStat.birthtime.toISOString();

    return {
      sessionId: uuid,
      title: normalizeSessionName(title, 'New Antigravity Chat'),
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
  private async readLeadingRecords(transcriptPath: string): Promise<AnyRecord[]> {
    let content: string;
    try {
      content = await readFile(transcriptPath, 'utf8');
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
   * Pulls the user prompt out of the first USER_INPUT record for use as the title.
   *
   * agy can emit system records (e.g. CONVERSATION_HISTORY) before the human's
   * first turn, so we scan the leading records for the first USER_INPUT instead
   * of assuming line 0. When no USER_INPUT is found within the scanned window we
   * return undefined so the caller falls back to the default title.
   *
   * `<instructions>...</instructions>` blocks are stripped first because agy
   * injects them as system-level directives (e.g. response-language rules), not
   * as text the human typed; letting them seed the title would surface machine
   * instructions as the conversation name. The match is global so every injected
   * block is removed. When nothing user-authored remains we return undefined so
   * the caller falls back to the default "New Antigravity Chat" title.
   */
  private extractTitleFromLeadingRecords(records: AnyRecord[]): string | undefined {
    const userInput = records.find((record) => record.type === 'USER_INPUT');
    if (!userInput) {
      return undefined;
    }

    const rawContent = typeof userInput.content === 'string' ? userInput.content : '';
    if (!rawContent) {
      return undefined;
    }

    let text = rawContent;
    const match = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
    if (match && typeof match[1] === 'string') {
      text = match[1];
    }

    text = text.replace(/<instructions>[\s\S]*?<\/instructions>/gi, '');

    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
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
