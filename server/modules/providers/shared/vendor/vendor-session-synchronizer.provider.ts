import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';
import {
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';

import { vendorProviderRoot } from './vendor-transcript.js';

type VendorParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

/**
 * Shared session indexer for the nassaj-owned vendor transcripts (kimi/deepseek/
 * glm). It scans `~/.nassaj-vendor-sessions/<provider>/**` for `.jsonl` files and
 * upserts each into sessionsDb. Project path and a human title are read from the
 * `meta` header line every transcript writes as its first record (see the run
 * seam); a transcript with no usable meta is skipped so a half-written file never
 * creates a malformed session row.
 */
export class VendorSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  async synchronize(since?: Date): Promise<number> {
    const root = vendorProviderRoot(this.provider);
    const files = await findFilesRecursivelyCreatedAfter(root, '.jsonl', since ?? null);

    let processed = 0;
    for (const filePath of files) {
      const upserted = await this.indexFile(filePath);
      if (upserted) {
        processed += 1;
      }
    }
    return processed;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    return this.indexFile(filePath);
  }

  private async indexFile(filePath: string): Promise<string | null> {
    const parsed = await this.parseSessionFile(filePath);
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
      filePath,
    );
  }

  /**
   * Reads the transcript's `meta` header for project path + title. The session id
   * is the transcript filename. Falls back to the first recorded user text for a
   * title when meta carries none.
   */
  private async parseSessionFile(filePath: string): Promise<VendorParsedSession | null> {
    const sessionId = path.basename(filePath, '.jsonl');

    return extractFirstValidJsonlData(filePath, (rawData) => {
      if (!rawData || typeof rawData !== 'object') {
        return null;
      }
      const data = rawData as Record<string, unknown>;
      if (data.type !== 'meta' || typeof data.projectPath !== 'string' || !data.projectPath.trim()) {
        return null;
      }
      const title = typeof data.sessionName === 'string' ? data.sessionName : '';
      return {
        sessionId,
        projectPath: data.projectPath,
        sessionName: normalizeSessionName(title, `Untitled ${this.provider} Session`),
      };
    });
  }
}
