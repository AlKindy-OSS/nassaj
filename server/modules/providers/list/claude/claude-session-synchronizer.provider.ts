import path from 'node:path';
import { access, realpath } from 'node:fs/promises';

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

import { claudeHomeForSessionFile, resolveClaudeHomes } from './claude-home.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;

  /**
   * Scans the operator Claude home and each isolated user's config home, then
   * upserts the transcripts found under their respective `projects/` trees.
   */
  async synchronize(since?: Date): Promise<number> {
    let processed = 0;
    const scannedProjectRoots = new Set<string>();
    for (const claudeHome of resolveClaudeHomes()) {
      const projectsRoot = path.join(claudeHome, 'projects');
      // Provisioning may intentionally point every isolated Claude home's
      // `projects/` at one shared/operator tree. Scan the physical tree once:
      // otherwise one JSONL is upserted once per user (and can overwrite its
      // stored path) while boot work grows with the user count. Missing roots
      // retain their logical path so separate homes created later are not
      // accidentally collapsed.
      const physicalProjectsRoot = await realpath(projectsRoot).catch(() => path.resolve(projectsRoot));
      if (scannedProjectRoots.has(physicalProjectsRoot)) {
        continue;
      }
      scannedProjectRoots.add(physicalProjectsRoot);
      processed += await this.synchronizeHome(claudeHome, since);
    }
    await this.pruneDeletedSessionFiles();
    return processed;
  }

  /** Scans one config home's transcript tree using its matching history index. */
  private async synchronizeHome(claudeHome: string, since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(path.join(claudeHome, 'projects'), '.jsonl', since ?? null);
    let processed = 0;

    for (const filePath of files) {
      if (filePath.includes('/subagents/')) continue;
      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) continue;

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId, this.provider, parsed.projectPath, parsed.sessionName,
        timestamps.createdAt, timestamps.updatedAt, filePath
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (filePath.includes('/subagents/')) {
      return null;
    }

    const claudeHome = claudeHomeForSessionFile(filePath);
    const nameMap = await buildLookupMap(path.join(claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );
  }

  /**
   * Removes "ghost" session rows whose transcript file no longer exists on disk.
   *
   * Claude's retention sweep deletes transcripts older than ~30 days from
   * ~/.claude/projects, leaving DB rows that can neither be opened nor resumed.
   * Scoped to provider "claude" rows with a stored jsonl_path so rows of other
   * providers (or rows that legitimately have no transcript file) are untouched.
   */
  private async pruneDeletedSessionFiles(): Promise<number> {
    const rows = sessionsDb.getSessionFilePathsByProvider(this.provider);
    let pruned = 0;

    for (const row of rows) {
      try {
        await access(row.jsonl_path);
      } catch (error) {
        const fileError = error as NodeJS.ErrnoException;
        if (fileError.code !== 'ENOENT') {
          // Transient/permission errors must not delete rows for files that may still exist.
          continue;
        }
        if (sessionsDb.deleteSessionById(row.session_id)) {
          pruned += 1;
        }
      }
    }

    if (pruned > 0) {
      console.log(`Pruned ghost sessions whose transcript files were deleted for provider "${this.provider}"`, {
        pruned,
      });
    }

    return pruned;
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    const existingSession = sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Claude Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Claude Session'),
      };
    }

    let sessionName = nameMap.get(parsed.sessionId);
    if (!sessionName) {
      sessionName = await this.extractSessionAiTitleFromEnd(filePath, parsed.sessionId);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Claude Session'),
    };
  }

  private async extractSessionAiTitleFromEnd(
    filePath: string,
    sessionId: string
  ): Promise<string | undefined> {
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
        const eventSessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
        const aiTitle = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
        const lastPrompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
        const claudeRenamedTitle = typeof data.customTitle === 'string' ? data.customTitle : undefined;

        if (
          (eventType === 'ai-title' && eventSessionId === sessionId && aiTitle?.trim()) ||
          (eventType === 'last-prompt' && eventSessionId === sessionId && lastPrompt?.trim()) ||
          (eventType === "custom-title" && eventSessionId === sessionId && claudeRenamedTitle?.trim())
        ) {
          return aiTitle || lastPrompt || claudeRenamedTitle;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}
