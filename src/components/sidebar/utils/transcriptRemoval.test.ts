import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import {
  SESSION_RETRY_FALLBACK,
  TRANSCRIPT_REMOVAL_RETRY,
  bulkOutcomeNotices,
  isSessionLeftOnDisk,
  readErrorCode,
  readJsonSafely,
  readTranscriptSummary,
  summarizeBulkResults,
  transcriptSummaryNotice,
} from './transcriptRemoval';

const t = ((key: string, _fallback?: string, options?: { count?: number }) =>
  options?.count === undefined ? key : `${key}:${options.count}`) as unknown as TFunction;

describe('B-1610 transcript removal parsing', () => {
  it('reads the error code and tolerates bodies that are not JSON', async () => {
    expect(readErrorCode({ success: false, error: { code: TRANSCRIPT_REMOVAL_RETRY } }))
      .toBe(TRANSCRIPT_REMOVAL_RETRY);
    expect(readErrorCode({ error: 'plain text' })).toBeNull();
    expect(readErrorCode(null)).toBeNull();
    const broken = { json: async () => { throw new SyntaxError('bad'); } } as unknown as Response;
    await expect(readJsonSafely(broken)).resolves.toBeNull();
    await expect(readJsonSafely({} as Response)).resolves.toBeNull();
  });

  it('flags only a permanent delete that removed no file', () => {
    expect(isSessionLeftOnDisk({ action: 'deleted', deletedFromDisk: false })).toBe(true);
    expect(isSessionLeftOnDisk({ action: 'deleted', deletedFromDisk: true })).toBe(false);
    expect(isSessionLeftOnDisk({ action: 'archived', deletedFromDisk: false })).toBe(false);
    expect(isSessionLeftOnDisk(undefined)).toBe(false);
  });

  it('reads the summary from the bare and the envelope project routes', () => {
    const transcripts = { removed: 2, keptForSafety: 1, failed: 3 };
    expect(readTranscriptSummary({ success: true, transcripts })).toEqual(transcripts);
    expect(readTranscriptSummary({ success: true, data: { deleted: true, transcripts } }))
      .toEqual(transcripts);
    expect(readTranscriptSummary({ success: true })).toBeNull();
    expect(readTranscriptSummary({ transcripts: { removed: -1, failed: 'x' } }))
      .toEqual({ removed: 0, keptForSafety: 0, failed: 0 });
  });

  it('folds bulk results into failures, retryable items and kept files', () => {
    const outcome = summarizeBulkResults([
      { id: 'a', success: true, result: { action: 'deleted', deletedFromDisk: true } },
      { id: 'b', success: true, result: { action: 'deleted', deletedFromDisk: false } },
      { id: 'c', success: false, error: { code: TRANSCRIPT_REMOVAL_RETRY, message: 'x' } },
      { id: 'd', success: false, error: { code: 'SESSION_NOT_FOUND', message: 'x' } },
      { id: 'p', success: true, transcripts: { removed: 1, keptForSafety: 2, failed: 1 } },
    ]);
    expect(outcome).toEqual({
      failedIds: ['c', 'd'],
      retryableCount: 1,
      sessionsLeftOnDisk: 1,
      transcripts: { removed: 1, keptForSafety: 2, failed: 1 },
    });
    expect(summarizeBulkResults(undefined).failedIds).toEqual([]);
  });
});

describe('B-1610 transcript removal notices', () => {
  it('is silent when every project file was removed', () => {
    expect(transcriptSummaryNotice(t, { removed: 4, keptForSafety: 0, failed: 0 })).toBeNull();
    expect(transcriptSummaryNotice(t, null)).toBeNull();
  });

  it('names failed and kept counts on separate lines', () => {
    expect(transcriptSummaryNotice(t, { removed: 0, keptForSafety: 2, failed: 1 }))
      .toBe('messages.projectTranscriptsFailed:1\nmessages.projectTranscriptsKept:2');
  });

  it('orders bulk lines as failure, retry, kept sessions, project files', () => {
    const lines = bulkOutcomeNotices(t, {
      failedIds: ['b', 'c'],
      retryableCount: 1,
      sessionsLeftOnDisk: 2,
      transcripts: { removed: 0, keptForSafety: 0, failed: 3 },
    });
    expect(lines).toEqual([
      'bulk.partialFailure:1',
      'messages.bulkTranscriptRetry:1',
      'messages.bulkSessionFilesKept:2',
      'messages.projectTranscriptsFailed:3',
    ]);
    expect(bulkOutcomeNotices(t, summarizeBulkResults([]))).toEqual([]);
  });

  it('does not count a retryable item as a failure too (qa 4)', () => {
    expect(bulkOutcomeNotices(t, {
      failedIds: ['c'], retryableCount: 1, sessionsLeftOnDisk: 0, transcripts: { removed: 0, keptForSafety: 0, failed: 0 },
    })).toEqual(['messages.bulkTranscriptRetry:1']);
  });

  it('says the conversation stays but auxiliary files may be gone (qa 3)', () => {
    expect(SESSION_RETRY_FALLBACK).toBe(
      'The conversation was not deleted; some of its auxiliary files may have been removed. Try again?');
  });
});
