import type { TFunction } from 'i18next';

/**
 * Client reading of the transcript-removal outcomes the delete routes return
 * (B-1596 server, B-1610 UI). Pure helpers: they parse payloads and build the
 * user-facing text; the sidebar controller decides when to show it.
 */

/** Server code for a transient file failure: nothing changed, retrying may work. */
export const TRANSCRIPT_REMOVAL_RETRY = 'TRANSCRIPT_REMOVAL_RETRY';

/** Per-project counts of recorded transcript files after a permanent delete. */
export type TranscriptRemovalSummary = { removed: number; keptForSafety: number; failed: number };

type BulkResult = {
  id: string;
  success: boolean;
  error?: { code?: unknown };
  result?: unknown;
  transcripts?: unknown;
};

/** Aggregate of a bulk response, split by what the user can act on. */
export type BulkOutcome = {
  failedIds: string[];
  retryableCount: number;
  sessionsLeftOnDisk: number;
  transcripts: TranscriptRemovalSummary;
};

/** Narrows an unknown JSON value to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Parses a response body as JSON; null when it is empty or not JSON. */
export async function readJsonSafely(response: Response): Promise<unknown> {
  return Promise.resolve().then(() => response.json()).catch(() => null);
}

/** Reads `{ error: { code } }` from a parsed failure body; null when absent. */
export function readErrorCode(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  return typeof body.error.code === 'string' ? body.error.code : null;
}

/**
 * True when a permanent session delete removed the row but not a file
 * (`action: 'deleted'`, `deletedFromDisk: false`). Archiving never reports it.
 */
export function isSessionLeftOnDisk(result: unknown): boolean {
  return isRecord(result) && result.action === 'deleted' && result.deletedFromDisk === false;
}

/** Reads a transcript summary from a project delete body (`transcripts` or `data.transcripts`). */
export function readTranscriptSummary(body: unknown): TranscriptRemovalSummary | null {
  if (!isRecord(body)) return null;
  const raw = isRecord(body.transcripts)
    ? body.transcripts
    : isRecord(body.data) && isRecord(body.data.transcripts) ? body.data.transcripts : null;
  if (!raw) return null;
  return { removed: count(raw.removed), keptForSafety: count(raw.keptForSafety), failed: count(raw.failed) };
}

/** Folds a bulk `results` array into failures and transcript outcomes. */
export function summarizeBulkResults(results: unknown): BulkOutcome {
  const outcome: BulkOutcome = {
    failedIds: [],
    retryableCount: 0,
    sessionsLeftOnDisk: 0,
    transcripts: { removed: 0, keptForSafety: 0, failed: 0 },
  };
  if (!Array.isArray(results)) return outcome;
  for (const item of results as BulkResult[]) {
    if (!isRecord(item)) continue;
    if (!item.success) {
      outcome.failedIds.push(item.id);
      if (item.error?.code === TRANSCRIPT_REMOVAL_RETRY) outcome.retryableCount += 1;
      continue;
    }
    if (isSessionLeftOnDisk(item.result)) outcome.sessionsLeftOnDisk += 1;
    const summary = readTranscriptSummary(item);
    if (summary) {
      outcome.transcripts.removed += summary.removed;
      outcome.transcripts.keptForSafety += summary.keptForSafety;
      outcome.transcripts.failed += summary.failed;
    }
  }
  return outcome;
}

/** Notice for files a project delete left on the device; null when every file was handled. */
export function transcriptSummaryNotice(
  t: TFunction,
  summary: TranscriptRemovalSummary | null,
): string | null {
  if (!summary) return null;
  const lines: string[] = [];
  if (summary.failed > 0) {
    lines.push(t('messages.projectTranscriptsFailed',
      '{{count}} conversation file(s) could not be removed from this device. '
      + 'The project was deleted; those files remain and can be removed manually.',
      { count: summary.failed }));
  }
  if (summary.keptForSafety > 0) {
    lines.push(t('messages.projectTranscriptsKept',
      '{{count}} conversation file(s) were kept on this device for safety reasons.',
      { count: summary.keptForSafety }));
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/** Fallback copy (en) for the single-item messages; the locale files carry ar/en. */
// qa 3: derived files (subagents, child rollouts) may already be gone when the transcript is refused.
export const SESSION_RETRY_FALLBACK =
  'The conversation was not deleted; some of its auxiliary files may have been removed. Try again?';
export const PROJECT_RETRY_FALLBACK =
  'A conversation file in this project could not be checked right now. Nothing was deleted. Try again?';
export const SESSION_FILE_KEPT_FALLBACK =
  'The conversation was deleted. Its file was not removed from this device: '
  + 'either it no longer exists, or it was kept for safety reasons.';

/** User-facing lines for a bulk response, in order: failures, retryable, kept files. */
export function bulkOutcomeNotices(t: TFunction, outcome: BulkOutcome): string[] {
  const lines: string[] = [];
  // qa 4: a retryable item has its own line below; it is not counted as a failure too.
  const otherFailures = outcome.failedIds.length - outcome.retryableCount;
  if (otherFailures > 0) {
    lines.push(t('bulk.partialFailure', '{{count}} item(s) could not be updated.', { count: otherFailures }));
  }
  if (outcome.retryableCount > 0) {
    lines.push(t('messages.bulkTranscriptRetry',
      '{{count}} item(s) were not deleted because a conversation file could not be removed '
      + 'right now. They are still selected; try again.',
      { count: outcome.retryableCount }));
  }
  if (outcome.sessionsLeftOnDisk > 0) {
    lines.push(t('messages.bulkSessionFilesKept',
      'For {{count}} deleted conversation(s), no file was removed from this device '
      + '(it was missing or kept for safety reasons).',
      { count: outcome.sessionsLeftOnDisk }));
  }
  const projectNotice = transcriptSummaryNotice(t, outcome.transcripts);
  if (projectNotice) lines.push(projectNotice);
  return lines;
}
