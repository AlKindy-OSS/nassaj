import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { spawn } from 'cross-spawn';
import { rgPath } from '@vscode/ripgrep';

import {
  canAccessProject,
  findOwningProject,
  isProjectMembershipEnforced,
  parseStoredTimestampMs,
  participantsDb,
  projectsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import {
  isTranscriptHandle,
  openRecordedTranscript,
  pinnedReadStream,
  type SessionTranscriptHandle,
} from '@/modules/providers/shared/session-transcript.js';
// eslint-disable-next-line boundaries/no-unknown -- ADR-210: display masking is a leaf service shared by every viewer egress.
import { displayLiteralsForSession, isDisplayMaskingEnabled, maskText } from '@/services/display-secret-mask.js';
// eslint-disable-next-line boundaries/no-unknown -- B-1668: one title/snippet text pipeline for every viewer egress.
import { displaySearchText, displaySessionTitle } from '@/services/session-title-text.js';

import { isInternalCodexContent, isInternalContent } from '../shared/internal-content.js';

type AnyRecord = Record<string, any>;
type SearchableProvider = 'claude' | 'codex';

type SearchSnippetHighlight = {
  start: number;
  end: number;
};

type SessionConversationMatch = {
  role: string;
  snippet: string;
  highlights: SearchSnippetHighlight[];
  timestamp: string | null;
  provider: SearchableProvider;
  messageUuid?: string | null;
};

type SessionConversationResult = {
  sessionId: string;
  provider: SearchableProvider;
  sessionSummary: string;
  matches: SessionConversationMatch[];
};

type ProjectConversationResult = {
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: SessionConversationResult[];
};

export type SessionConversationSearchProgressUpdate = {
  projectResult: ProjectConversationResult | null;
  totalMatches: number;
  scannedProjects: number;
  totalProjects: number;
};

type SearchSessionConversationsInput = {
  query: string;
  limit: number;
  // Authenticated caller resolved by the route from req.user (B-106). The search
  // only ever scans / streams sessions this user owns or participates in. `null`
  // is the explicit "no authenticated identity" value and yields zero results —
  // it never widens access.
  requesterUserId: number | null;
  signal?: AbortSignal;
  onProgress?: (update: SessionConversationSearchProgressUpdate) => void;
  authorizeSession?: (sessionId: string, projectPath: string | null) => boolean;
};

type SessionRepositoryRow = ReturnType<typeof sessionsDb.getAllSessions>[number];
type SearchableSessionRow = SessionRepositoryRow & {
  provider: SearchableProvider;
  jsonl_path: string;
};

type SearchRuntime = {
  matchesQuery: (text: string) => boolean;
  buildSnippet: (text: string) => { snippet: string; highlights: SearchSnippetHighlight[] };
  limit: number;
  totalMatches: number;
  isAborted: () => boolean;
};

/** A candidate session with its transcript pinned for one read (ADR-201 A1). */
type PinnedSearchSession = { session: SearchableSessionRow; transcript: SessionTranscriptHandle };

type ProjectBucket = {
  key: string;
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: SearchableSessionRow[];
};

const SUPPORTED_PROVIDERS = new Set<SearchableProvider>(['claude', 'codex']);
const MAX_MATCHES_PER_SESSION = 2;
const RIPGREP_FILE_CHUNK_SIZE = 40;
const RIPGREP_CHUNK_CONCURRENCY = 6;
const UNKNOWN_PROJECT_KEY = '__unknown_project__';

function chunkArray<TItem>(items: TItem[], size: number): TItem[][] {
  if (size <= 0) {
    return [items];
  }

  const chunks: TItem[][] = [];
  for (let idx = 0; idx < items.length; idx += size) {
    chunks.push(items.slice(idx, idx + size));
  }
  return chunks;
}

function getSessionKey(session: Pick<SessionRepositoryRow, 'provider' | 'session_id'>): string {
  return `${session.provider}:${session.session_id}`;
}

function makeProjectKey(projectPath: string | null): string {
  const normalized = typeof projectPath === 'string' ? projectPath.trim() : '';
  return normalized.length > 0 ? normalized : UNKNOWN_PROJECT_KEY;
}

/** Longest fallback summary, in code points. */
const SUMMARY_FALLBACK_MAX = 50;

/**
 * The result's conversation title: the same display title the sidebar shows
 * (B-1668), else the cleaned fallback message text. ADR-210: masked before
 * truncating, so a cut can never leave half a secret unmatched; the cut is on
 * code points, so it never splits an emoji into a lone surrogate.
 */
function toSummaryText(customName: string | null, fallback: string | null | undefined, emptyLabel: string): string {
  const title = displaySessionTitle(customName);
  if (title) {
    return title;
  }

  const fallbackText = displaySessionTitle(fallback);
  if (!fallbackText) {
    return emptyLabel;
  }

  const codePoints = Array.from(fallbackText);
  return codePoints.length > SUMMARY_FALLBACK_MAX
    ? `${codePoints.slice(0, SUMMARY_FALLBACK_MAX).join('')}...`
    : fallbackText;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type SnippetMatcher = Pick<SearchRuntime, 'matchesQuery' | 'buildSnippet'>;
type SnippetSpan = { start: number; length: number };

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Moves a slice boundary off the middle of a surrogate pair (B-1668 item 9).
 * A UTF-16 cut between the halves of an emoji leaves a lone surrogate, which
 * the browser renders as "�". Stepping back keeps a start's pair whole and
 * drops an end's half pair.
 */
export function alignToCodePoint(text: string, index: number): number {
  return index > 0
    && index < text.length
    && isLowSurrogate(text.charCodeAt(index))
    && isHighSurrogate(text.charCodeAt(index - 1))
    ? index - 1
    : index;
}

/** Merges overlapping highlight ranges after sorting them. */
function mergeHighlights(highlights: SearchSnippetHighlight[]): SearchSnippetHighlight[] {
  const merged: SearchSnippetHighlight[] = [];
  for (const highlight of [...highlights].sort((left, right) => left.start - right.start)) {
    const previous = merged[merged.length - 1];
    if (previous && highlight.start <= previous.end) previous.end = Math.max(previous.end, highlight.end);
    else merged.push({ ...highlight });
  }
  return merged;
}

/**
 * Query matcher and snippet builder. Every position is computed on the text
 * itself with case-insensitive regexps — never on a lower-cased copy, whose
 * length can differ (`İ` lowers to two code units) and shift every highlight.
 */
function createWordMatcher(rawQuery: string, words: string[]): SnippetMatcher {
  const requireExactPhrase = words.length > 1 && rawQuery.trim().length > 0;
  const wordSource = (word: string) => `(?<!\\p{L})${escapeRegex(word)}(?!\\p{L})`;
  const wordPatterns = words.map((word) => new RegExp(wordSource(word), 'iu'));
  const phraseRegex = new RegExp(words.map((word) => escapeRegex(word)).join('\\s+'), 'iu');

  const matchesQuery = (text: string): boolean => {
    if (typeof text !== 'string' || text.length === 0) return false;
    if (phraseRegex.test(text)) return true;
    return !requireExactPhrase && wordPatterns.every((pattern) => pattern.test(text));
  };

  const firstMatch = (text: string): SnippetSpan | null => {
    const phrase = phraseRegex.exec(text);
    if (phrase) return { start: phrase.index, length: phrase[0].length };
    let first: SnippetSpan | null = null;
    for (const pattern of wordPatterns) {
      const match = pattern.exec(text);
      if (match && (!first || match.index < first.start)) first = { start: match.index, length: match[0].length };
    }
    return first;
  };

  const highlightsIn = (snippet: string): SearchSnippetHighlight[] => {
    const patterns = requireExactPhrase ? [phraseRegex.source] : [phraseRegex.source, ...words.map(wordSource)];
    return patterns.flatMap((source) =>
      [...snippet.matchAll(new RegExp(source, 'giu'))].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
      })));
  };

  const buildSnippet = (text: string, snippetLen = 150): { snippet: string; highlights: SearchSnippetHighlight[] } => {
    const match = firstMatch(text) ?? { start: 0, length: 0 };
    const halfLen = Math.floor(snippetLen / 2);
    const start = alignToCodePoint(text, Math.max(0, match.start - halfLen));
    const end = alignToCodePoint(text, Math.min(text.length, match.start + halfLen + match.length));
    const prefix = start > 0 ? '...' : '';
    const suffix = end < text.length ? '...' : '';
    const snippet = `${prefix}${text.slice(start, end).replace(/\n/g, ' ')}${suffix}`;
    return { snippet, highlights: mergeHighlights(highlightsIn(snippet)) };
  };

  return { matchesQuery, buildSnippet };
}

/**
 * The text a search hit is scored and quoted on (ADR-210, T-2036, B-1668):
 * injected blocks removed, then display-masked, then markdown removed — the
 * same pipeline as the conversation title. The raw match is only a cheap
 * prefilter; the query must also match the displayed text, and the snippet
 * and highlights are built from it, so searching a prefix of a stored secret
 * finds nothing and can never be used as an oracle. One-entry memo: the
 * snippet call always follows the match call for the same text.
 */
function withDisplayText(matcher: SnippetMatcher): SnippetMatcher {
  const literals = isDisplayMaskingEnabled() ? displayLiteralsForSession(null) : null;
  const mask = literals ? (text: string) => maskText(text, { literals }) : (text: string) => text;
  let memo: { raw: string; shown: string } | null = null;
  const shown = (text: string): string => {
    if (memo?.raw !== text) memo = { raw: text, shown: displaySearchText(text, mask) };
    return memo.shown;
  };
  return {
    matchesQuery: (text) => matcher.matchesQuery(text) && matcher.matchesQuery(shown(text)),
    buildSnippet: (text) => matcher.buildSnippet(shown(text)),
  };
}

function extractClaudeText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((part: AnyRecord) => part?.type === 'text' && typeof part?.text === 'string')
    .map((part: AnyRecord) => String(part.text))
    .join(' ');
}

function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

function parseClaudeLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

function buildClaudeLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

function stripAnsiFormatting(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

type ClaudeSearchableMessage = {
  text: string;
  role: 'user' | 'assistant';
};

/**
 * Claude mixes visible chat, compact summaries, and local command wrappers into
 * the same transcript stream. Search should operate on the user-visible meaning
 * of those rows rather than the raw wrapper syntax.
 */
function extractClaudeSearchableMessage(entry: AnyRecord): ClaudeSearchableMessage | null {
  if (!entry.message?.content || entry.isApiErrorMessage) {
    return null;
  }

  const rawRole = entry.message.role;
  if (rawRole !== 'user' && rawRole !== 'assistant') {
    return null;
  }

  if (typeof entry.message.content === 'string') {
    const content = String(entry.message.content);

    if (entry.isCompactSummary === true && content.trim()) {
      return {
        text: content,
        role: 'assistant',
      };
    }

    const localCommand = parseClaudeLocalCommandPayload(content);
    if (localCommand) {
      const displayText = buildClaudeLocalCommandDisplayText(localCommand);
      return displayText
        ? {
            text: displayText,
            role: 'user',
          }
        : null;
    }

    const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
    if (localCommandStdout !== null) {
      const stdoutText = stripAnsiFormatting(localCommandStdout).trim();
      return stdoutText
        ? {
            text: stdoutText,
            role: 'assistant',
          }
        : null;
    }

    if (!content || isInternalContent(content)) {
      return null;
    }

    return {
      text: content,
      role: rawRole,
    };
  }

  const text = extractClaudeText(entry.message.content);
  if (!text) {
    return null;
  }

  if (entry.isCompactSummary === true) {
    return {
      text,
      role: 'assistant',
    };
  }

  if (isInternalContent(text)) {
    return null;
  }

  return {
    text,
    role: rawRole,
  };
}

function extractCodexText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const record = item as AnyRecord;
      if (
        (record.type === 'input_text' || record.type === 'output_text' || record.type === 'text')
        && typeof record.text === 'string'
      ) {
        return record.text;
      }

      return '';
    })
    .filter(Boolean)
    .join(' ');
}

function normalizeSearchableSessions(rows: SessionRepositoryRow[]): SearchableSessionRow[] {
  const normalizedRows: SearchableSessionRow[] = [];
  const projectArchiveStateByPath = new Map<string, boolean>();

  for (const row of rows) {
    const provider = row.provider as SearchableProvider;
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      continue;
    }

    // Only rows with a recorded transcript are candidates; whether that file is
    // admissible (tree, name, header id) is decided by the pinned reader when it
    // is opened — nothing is touched on disk here (ADR-201 A1).
    const recordedPath = typeof row.jsonl_path === 'string' ? row.jsonl_path.trim() : '';
    if (!recordedPath || !path.isAbsolute(recordedPath)) {
      continue;
    }

    /**
     * Active session rows can still belong to an archived project because
     * project archiving intentionally preserves the underlying session data.
     * Global conversation search should follow the visible workspace model,
     * which means excluding any session whose owning project is archived.
     *
     * Cache the archive lookup per normalized project path so one search pass
     * does not re-query the same project row for every session in that folder.
     */
    const normalizedProjectPath = typeof row.project_path === 'string' ? row.project_path.trim() : '';
    if (normalizedProjectPath) {
      if (!projectArchiveStateByPath.has(normalizedProjectPath)) {
        const projectRow = projectsDb.getProjectPath(normalizedProjectPath);
        projectArchiveStateByPath.set(normalizedProjectPath, Boolean(projectRow?.isArchived));
      }

      if (projectArchiveStateByPath.get(normalizedProjectPath) === true) {
        continue;
      }
    }

    normalizedRows.push({
      ...row,
      provider,
      jsonl_path: recordedPath,
    });
  }

  return normalizedRows;
}

/**
 * Per-session authorization gate for conversation search (B-106 — sibling of the
 * B-105 REST IDOR fix, extended by B-111). The search used to scan every
 * transcript on disk across all projects with no notion of who was asking, so any
 * authenticated user could read other users' conversation content (and live SSE
 * snippets). This filter keeps ONLY the sessions the requester is authorized for:
 * either a participant / message author of the session
 * (`participantsDb.isParticipant`, the same predicate that gates
 * GET /sessions/:id/messages), OR a viewer of the project the session lives in
 * (`projectsDb.isProjectPathVisibleToUser`, the same predicate the sidebar list
 * layer uses via getVisibleProjectPaths). Aligning the search gate with the list
 * gate is the B-111 fix: a session listed because its project is public/shared
 * must also be searchable, while a session in a private project the user is not a
 * member of is still excluded (the B-106 isolation guarantee is preserved).
 *
 * Applied to the candidate set BEFORE ripgrep runs and before any project bucket
 * is built or streamed, so an unauthorized session's content is never read off
 * disk and never emitted over SSE — not even transiently.
 *
 * Fail-closed by construction: a `null` requester (anonymous / unresolved) is
 * not an integer user id; both predicates return false for it, so the result is
 * empty. Batched (ADR-201 A1): participation/authorship is ONE query
 * (`getSessionIdsForUser`, the same spawn-or-author union as `isParticipant`),
 * and project-visibility decisions are memoized per project_path, so a page
 * costs one query per distinct project, never one per session. Uses prepared
 * statements only (inside the repositories).
 */
function filterSessionsByOwnership(
  searchableSessions: SearchableSessionRow[],
  requesterUserId: number | null,
): SearchableSessionRow[] {
  if (requesterUserId === null) {
    return [];
  }

  const projectVisibilityByPath = new Map<string, boolean>();
  const isProjectPathVisible = (projectPath: string | null): boolean => {
    const key = typeof projectPath === 'string' ? projectPath : '';
    if (!projectVisibilityByPath.has(key)) {
      projectVisibilityByPath.set(
        key,
        projectsDb.isProjectPathVisibleToUser(projectPath, requesterUserId),
      );
    }
    return projectVisibilityByPath.get(key) as boolean;
  };

  // ADR-172 (qa ن2): under enforcement, participation alone no longer admits a
  // session whose registered project the requester lost access to.
  const enforced = isProjectMembershipEnforced();
  const consented = new Set(participantsDb.getSessionIdsForUser(requesterUserId));
  const participantAdmits = (session: SearchableSessionRow): boolean => {
    if (!consented.has(session.session_id)) {
      return false;
    }
    if (!enforced) {
      return true;
    }
    const owner = findOwningProject(session.project_path ?? '');
    return owner === null || canAccessProject(owner.project_id, requesterUserId);
  };

  return searchableSessions.filter(
    (session) => {
      if (participantAdmits(session)) return true;
      if (enforced && findOwningProject(session.project_path ?? '') === null) return false;
      return isProjectPathVisible(session.project_path);
    },
  );
}

/**
 * Recency of a session in epoch milliseconds, for ordering search results.
 *
 * Uses the timezone-aware parser rather than `new Date(value)`: `sessions`
 * stores two timestamp formats side by side (ISO-8601 UTC and SQLite's
 * timezone-less `2026-06-27 09:34:00`), and the bare `Date` constructor reads
 * the second as LOCAL time — a three-hour backwards shift on this server, which
 * silently reorders results whenever both formats appear in the same bucket.
 * A row with no usable timestamp sorts last (never in front of a dated one).
 */
function sessionRecencyMs(session: SearchableSessionRow): number {
  return (
    parseStoredTimestampMs(session.updated_at) ??
    parseStoredTimestampMs(session.created_at) ??
    Number.NEGATIVE_INFINITY
  );
}

function buildProjectBuckets(searchableSessions: SearchableSessionRow[]): ProjectBucket[] {
  const projectBuckets = new Map<string, ProjectBucket>();
  const projectMetadataCache = new Map<string, { projectId: string | null; projectDisplayName: string }>();

  for (const session of searchableSessions) {
    const key = makeProjectKey(session.project_path);
    if (!projectBuckets.has(key)) {
      if (!projectMetadataCache.has(key)) {
        if (key === UNKNOWN_PROJECT_KEY) {
          projectMetadataCache.set(key, {
            projectId: null,
            projectDisplayName: 'Unknown Project',
          });
        } else {
          const projectRow = projectsDb.getProjectPath(key);
          const customProjectName = typeof projectRow?.custom_project_name === 'string'
            ? projectRow.custom_project_name.trim()
            : '';
          const displayName = customProjectName || path.basename(key) || key;

          projectMetadataCache.set(key, {
            projectId: projectRow?.project_id ?? null,
            projectDisplayName: displayName,
          });
        }
      }

      const metadata = projectMetadataCache.get(key) as { projectId: string | null; projectDisplayName: string };
      projectBuckets.set(key, {
        key,
        projectId: metadata.projectId,
        projectName: key,
        projectDisplayName: metadata.projectDisplayName,
        sessions: [],
      });
    }

    const bucket = projectBuckets.get(key) as ProjectBucket;
    bucket.sessions.push(session);
  }

  const buckets = Array.from(projectBuckets.values());
  for (const bucket of buckets) {
    bucket.sessions.sort((left, right) => sessionRecencyMs(right) - sessionRecencyMs(left));
  }

  return buckets;
}

/** First descriptor number of the transcripts handed to ripgrep (after stdin/stdout/stderr). */
const RIPGREP_FIRST_FD = 3;
const RIPGREP_FD_PREFIX = '/proc/self/fd/';

/** Index of the candidate ripgrep reported, from its `/proc/self/fd/<n>` argument; -1 otherwise. */
function ripgrepMatchIndex(line: string, count: number): number {
  const trimmed = line.trim();
  if (!trimmed.startsWith(RIPGREP_FD_PREFIX)) return -1;
  const index = Number(trimmed.slice(RIPGREP_FD_PREFIX.length)) - RIPGREP_FIRST_FD;
  return Number.isInteger(index) && index >= 0 && index < count ? index : -1;
}

/**
 * Runs ripgrep over pinned transcripts (ADR-201 A1). The descriptors are
 * inherited by the child as fds 3.. and named `/proc/self/fd/<n>`, so ripgrep
 * reads exactly the files the reader admitted — never a stored path. Resolves
 * to the indexes (into `descriptors`) of the files that match.
 */
async function runRipgrepFilesWithMatches(
  pattern: string,
  descriptors: number[],
  signal?: AbortSignal,
): Promise<Set<number>> {
  if (!pattern || descriptors.length === 0 || signal?.aborted) {
    return new Set();
  }

  return new Promise((resolve, reject) => {
    const args = [
      '--files-with-matches',
      '--no-messages',
      '--ignore-case',
      '--fixed-strings',
      '--',
      pattern,
      ...descriptors.map((_fd, index) => `${RIPGREP_FD_PREFIX}${RIPGREP_FIRST_FD + index}`),
    ];
    const rg = spawn(rgPath, args, {
      stdio: ['ignore', 'pipe', 'pipe', ...descriptors],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let aborted = false;

    const abortListener = () => {
      aborted = true;
      rg.kill();
    };

    if (signal) {
      signal.addEventListener('abort', abortListener, { once: true });
    }

    rg.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    rg.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    rg.on('error', (error) => {
      if (signal) {
        signal.removeEventListener('abort', abortListener);
      }

      if (aborted || signal?.aborted) {
        resolve(new Set());
        return;
      }

      reject(error);
    });

    rg.on('close', (code) => {
      if (signal) {
        signal.removeEventListener('abort', abortListener);
      }

      if (aborted || signal?.aborted) {
        resolve(new Set());
        return;
      }

      if (code !== 0 && code !== 1) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(`ripgrep failed with code ${String(code)}: ${stderr}`));
        return;
      }

      const matched = new Set<number>();
      for (const line of Buffer.concat(stdoutChunks).toString('utf8').split(/\r?\n/)) {
        const index = ripgrepMatchIndex(line, descriptors.length);
        if (index >= 0) matched.add(index);
      }
      resolve(matched);
    });
  });
}

/** Pinned transcripts of `sessions` (refused ones are skipped); the caller closes them. */
async function openSearchTranscripts(sessions: SearchableSessionRow[]): Promise<PinnedSearchSession[]> {
  const opened = await Promise.all(sessions.map(async (session) => ({
    session, result: await openRecordedTranscript(session, 'search'),
  })));
  return opened.flatMap(({ session, result }) => (isTranscriptHandle(result) ? [{ session, transcript: result }] : []));
}

async function closeSearchTranscripts(pinned: PinnedSearchSession[]): Promise<void> {
  await Promise.all(pinned.map(({ transcript }) => transcript.fd.close().catch(() => undefined)));
}

/** Keys of the sessions in one chunk whose pinned transcript contains `word`. */
async function ripgrepChunk(word: string, sessions: SearchableSessionRow[], signal?: AbortSignal): Promise<string[]> {
  const pinned = await openSearchTranscripts(sessions);
  try {
    const matched = await runRipgrepFilesWithMatches(word, pinned.map(({ transcript }) => transcript.fd.fd), signal);
    return [...matched].map((index) => getSessionKey(pinned[index].session));
  } finally {
    await closeSearchTranscripts(pinned);
  }
}

/** Keys of `sessions` whose transcript contains `word` (chunked, bounded concurrency). */
async function sessionsMatchingWord(
  word: string,
  sessions: SearchableSessionRow[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  const matched = new Set<string>();
  const chunks = chunkArray(sessions, RIPGREP_FILE_CHUNK_SIZE);
  let nextChunkIndex = 0;
  const workers = Array.from({ length: Math.min(RIPGREP_CHUNK_CONCURRENCY, chunks.length) }, async () => {
    while (nextChunkIndex < chunks.length && !signal?.aborted) {
      const currentIndex = nextChunkIndex;
      nextChunkIndex += 1;
      for (const key of await ripgrepChunk(word, chunks[currentIndex], signal)) {
        matched.add(key);
      }
    }
  });
  await Promise.all(workers);
  return matched;
}

/**
 * Keys of the candidate sessions whose transcripts contain every query word.
 * ripgrep is an over-approximation (each word somewhere in the file); exact
 * phrase and word-boundary matching is left to the in-memory matcher.
 */
async function findMatchedSessionKeys(
  sessions: SearchableSessionRow[],
  words: string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  let remaining = sessions;
  for (const word of words) {
    if (signal?.aborted || remaining.length === 0) {
      return new Set();
    }
    const matched = await sessionsMatchingWord(word, remaining, signal);
    if (signal?.aborted) {
      return new Set();
    }
    remaining = remaining.filter((session) => matched.has(getSessionKey(session)));
  }
  return new Set(remaining.map(getSessionKey));
}

function addSessionMatch(
  runtime: SearchRuntime,
  matches: SessionConversationMatch[],
  match: SessionConversationMatch,
): void {
  if (runtime.totalMatches >= runtime.limit || matches.length >= MAX_MATCHES_PER_SESSION) {
    return;
  }

  matches.push(match);
  runtime.totalMatches += 1;
}

type ClaudeSessionSearchState = {
  matches: SessionConversationMatch[];
  pendingSummaries: Map<string, string>;
  fallbackUserText: string | null;
  fallbackAssistantText: string | null;
  resolvedSummary: string | null;
};

/** Parsed JSONL lines of a pinned transcript, read through its descriptor until `stop()`. */
async function* pinnedJsonlEntries(fd: FileHandle, stop: () => boolean): AsyncGenerator<AnyRecord> {
  const rl = readline.createInterface({ input: pinnedReadStream(fd), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (stop()) return;
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as AnyRecord;
      } catch {
        // Skip malformed JSONL lines that can happen during concurrent writes.
      }
    }
  } finally {
    rl.close();
  }
}

/** Summary bookkeeping of one Claude entry (summary rows, leaf summaries, compact summaries). */
function trackClaudeSummary(state: ClaudeSessionSearchState, entry: AnyRecord): void {
  if (entry.type === 'summary' && entry.summary) {
    const summaryValue = String(entry.summary);
    if (entry.sessionId) {
      state.resolvedSummary = summaryValue;
    } else if (entry.leafUuid) {
      state.pendingSummaries.set(String(entry.leafUuid), summaryValue);
    }
  }
  if (!state.resolvedSummary && entry.parentUuid) {
    const pendingSummary = state.pendingSummaries.get(String(entry.parentUuid));
    if (pendingSummary) {
      state.resolvedSummary = pendingSummary;
    }
  }
}

/** Folds one Claude entry of the target session into its search state. */
function foldClaudeEntry(state: ClaudeSessionSearchState, entry: AnyRecord, runtime: SearchRuntime): void {
  trackClaudeSummary(state, entry);
  const searchableMessage = extractClaudeSearchableMessage(entry);
  if (!searchableMessage) {
    return;
  }
  const { text, role } = searchableMessage;
  /**
   * Claude compact summaries are the most faithful session-summary source
   * after a `/compact` because they describe the post-compaction state that
   * the resumed session actually continues from. Prefer them over generic
   * fallback user text when present.
   */
  if (entry.isCompactSummary === true) {
    state.resolvedSummary = text;
  }
  if (role === 'user') {
    state.fallbackUserText = text;
  } else {
    state.fallbackAssistantText = text;
  }
  if (!runtime.matchesQuery(text)) {
    return;
  }
  const { snippet, highlights } = runtime.buildSnippet(text);
  addSessionMatch(runtime, state.matches, {
    role,
    snippet,
    highlights,
    timestamp: entry.timestamp ? String(entry.timestamp) : null,
    provider: 'claude',
    messageUuid: entry.uuid ? String(entry.uuid) : null,
  });
}

/**
 * Matches of one Claude session, read from its pinned transcript. The reader
 * bound the file to this session (name `<id>.jsonl` + header id), so only
 * entries of this session id (or id-less entries following them) are folded.
 */
async function parseClaudeSessionMatches(
  session: SearchableSessionRow,
  runtime: SearchRuntime,
  fd: FileHandle,
): Promise<SessionConversationResult | null> {
  const state: ClaudeSessionSearchState = {
    matches: [], pendingSummaries: new Map(), fallbackUserText: null, fallbackAssistantText: null, resolvedSummary: null,
  };
  let currentSessionId: string | null = null;
  const stop = () => runtime.totalMatches >= runtime.limit || runtime.isAborted();
  for await (const entry of pinnedJsonlEntries(fd, stop)) {
    if (entry.sessionId) {
      currentSessionId = String(entry.sessionId);
    }
    if (currentSessionId !== session.session_id) {
      continue;
    }
    foldClaudeEntry(state, entry, runtime);
  }
  if (state.matches.length === 0) {
    return null;
  }
  return {
    sessionId: session.session_id,
    provider: 'claude',
    sessionSummary: toSummaryText(
      session.custom_name ?? null,
      state.resolvedSummary || state.fallbackUserText || state.fallbackAssistantText,
      'New Session',
    ),
    matches: state.matches,
  };
}

function isVisibleCodexUserMessage(payload: AnyRecord | null | undefined): boolean {
  if (!payload || payload.type !== 'user_message') {
    return false;
  }

  if (payload.kind && payload.kind !== 'plain') {
    return false;
  }

  return typeof payload.message === 'string' && payload.message.trim().length > 0;
}

async function parseCodexSessionMatches(
  session: SearchableSessionRow,
  runtime: SearchRuntime,
  fd: FileHandle,
): Promise<SessionConversationResult | null> {
  const matches: SessionConversationMatch[] = [];
  let latestUserMessageText: string | null = null;
  const seenMessageFingerprints = new Set<string>();
  const stop = () => runtime.totalMatches >= runtime.limit || runtime.isAborted();

  try {
    for await (const entry of pinnedJsonlEntries(fd, stop)) {
      let text: string | null = null;
      let role: 'user' | 'assistant' | null = null;

      if (entry.type === 'event_msg' && isVisibleCodexUserMessage(entry.payload as AnyRecord)) {
        text = String(entry.payload.message);
        role = 'user';
      } else if (
        entry.type === 'event_msg'
        && entry.payload?.type === 'agent_reasoning'
        && typeof entry.payload?.text === 'string'
      ) {
        text = String(entry.payload.text);
        role = 'assistant';
      } else if (entry.type === 'response_item' && entry.payload?.type === 'message') {
        const payload = entry.payload as AnyRecord;
        if (payload.role === 'user') {
          text = extractCodexText(payload.content);
          role = 'user';
        } else if (payload.role === 'assistant') {
          text = extractCodexText(payload.content);
          role = 'assistant';
        }
      } else if (entry.type === 'response_item' && entry.payload?.type === 'reasoning') {
        const summaryText = Array.isArray(entry.payload.summary)
          ? entry.payload.summary
            .map((item: AnyRecord) => (typeof item?.text === 'string' ? item.text : ''))
            .filter(Boolean)
            .join('\n')
          : '';

        if (summaryText.trim()) {
          text = summaryText;
          role = 'assistant';
        }
      }

      if (!text || !role) {
        continue;
      }
      if (isInternalCodexContent(text)) {
        continue;
      }
      if (role === 'user') {
        latestUserMessageText = text;
      }

      const fingerprint = `${role}:${text.trim().toLowerCase()}`;
      if (seenMessageFingerprints.has(fingerprint)) {
        continue;
      }
      seenMessageFingerprints.add(fingerprint);

      if (!runtime.matchesQuery(text)) {
        continue;
      }

      const { snippet, highlights } = runtime.buildSnippet(text);
      addSessionMatch(runtime, matches, {
        role,
        snippet,
        highlights,
        timestamp: entry.timestamp ? String(entry.timestamp) : null,
        provider: 'codex',
      });
    }
  } catch {
    return null;
  }

  if (matches.length === 0) {
    return null;
  }

  return {
    sessionId: session.session_id,
    provider: 'codex',
    sessionSummary: toSummaryText(session.custom_name, latestUserMessageText, 'Codex Session'),
    matches,
  };
}

/** Matches of one session, read only from its pinned transcript (ADR-201 A1); null when refused. */
async function parseSessionMatches(
  session: SearchableSessionRow,
  runtime: SearchRuntime,
): Promise<SessionConversationResult | null> {
  const opened = await openRecordedTranscript(session, 'search');
  if (!isTranscriptHandle(opened)) {
    return null;
  }
  try {
    return session.provider === 'claude'
      ? await parseClaudeSessionMatches(session, runtime, opened.fd)
      : await parseCodexSessionMatches(session, runtime, opened.fd);
  } catch {
    return null;
  } finally {
    await opened.fd.close().catch(() => undefined);
  }
}

export async function searchConversations(
  query: string,
  requesterUserId: number | null,
  limit = 50,
  onProjectResult: ((update: SessionConversationSearchProgressUpdate) => void) | null = null,
  signal: AbortSignal | null = null,
  authorizeSession: ((sessionId: string, projectPath: string | null) => boolean) | null = null,
): Promise<{ results: ProjectConversationResult[]; totalMatches: number; query: string }> {
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 50, 200));
  const words = safeQuery.toLowerCase().split(/\s+/).filter((word) => word.length > 0);

  if (words.length === 0) {
    return { results: [], totalMatches: 0, query: safeQuery };
  }

  // Fail-closed ownership gate (B-106): a null / unresolved caller owns nothing,
  // so refuse before touching the database, ripgrep, or the SSE stream.
  if (requesterUserId === null) {
    return { results: [], totalMatches: 0, query: safeQuery };
  }

  const isAborted = () => signal?.aborted === true;
  if (isAborted()) {
    return { results: [], totalMatches: 0, query: safeQuery };
  }

  // Restrict the candidate set to sessions this user owns / participates in
  // BEFORE any file is scanned or any project bucket is built/streamed, so no
  // other user's transcript content is ever read off disk or emitted over SSE.
  const searchableSessions = filterSessionsByOwnership(
    normalizeSearchableSessions(sessionsDb.getAllSessions()),
    requesterUserId,
  ).filter((session) => authorizeSession?.(session.session_id, session.project_path) !== false);
  if (searchableSessions.length === 0) {
    return { results: [], totalMatches: 0, query: safeQuery };
  }

  const matchedSessionKeys = await findMatchedSessionKeys(searchableSessions, words, signal ?? undefined);
  if (isAborted() || matchedSessionKeys.size === 0) {
    return { results: [], totalMatches: 0, query: safeQuery };
  }

  const projectBuckets = buildProjectBuckets(searchableSessions);
  const totalProjects = projectBuckets.length;
  const results: ProjectConversationResult[] = [];
  let scannedProjects = 0;

  const runtime: SearchRuntime = {
    ...withDisplayText(createWordMatcher(safeQuery, words)),
    limit: safeLimit,
    totalMatches: 0,
    isAborted,
  };

  for (const bucket of projectBuckets) {
    if (runtime.totalMatches >= runtime.limit || runtime.isAborted()) {
      break;
    }

    const projectResult: ProjectConversationResult = {
      projectId: bucket.projectId,
      projectName: bucket.projectName,
      projectDisplayName: bucket.projectDisplayName,
      sessions: [],
    };

    for (const session of bucket.sessions) {
      if (runtime.totalMatches >= runtime.limit || runtime.isAborted()) {
        break;
      }
      if (!matchedSessionKeys.has(getSessionKey(session))) {
        continue;
      }
      if (authorizeSession?.(session.session_id, session.project_path) === false) {
        continue;
      }

      const sessionResult = await parseSessionMatches(session, runtime);
      if (authorizeSession?.(session.session_id, session.project_path) === false) {
        continue;
      }
      if (sessionResult) {
        projectResult.sessions.push(sessionResult);
      }
    }

    scannedProjects += 1;
    if (authorizeSession) {
      const pathsBySession = new Map(bucket.sessions.map(
        (session) => [session.session_id, session.project_path] as const,
      ));
      projectResult.sessions = projectResult.sessions.filter((session) =>
        authorizeSession(session.sessionId, pathsBySession.get(session.sessionId) ?? null));
    }
    if (projectResult.sessions.length > 0) {
      results.push(projectResult);
      onProjectResult?.({
        projectResult,
        totalMatches: runtime.totalMatches,
        scannedProjects,
        totalProjects,
      });
    } else if (onProjectResult && scannedProjects % 10 === 0) {
      onProjectResult({
        projectResult: null,
        totalMatches: runtime.totalMatches,
        scannedProjects,
        totalProjects,
      });
    }
  }

  return {
    results,
    totalMatches: runtime.totalMatches,
    query: safeQuery,
  };
}

/**
 * Application service for session-conversation search.
 *
 * Provider routes call this service so route handlers stay focused on
 * request parsing/response formatting, while search execution remains
 * centralized in one place.
 */
export const sessionConversationsSearchService = {
  /**
   * Streams progress updates while the search scans provider session logs.
   */
  async search(input: SearchSessionConversationsInput): Promise<void> {
    await searchConversations(
      input.query,
      input.requesterUserId,
      input.limit,
      input.onProgress ?? null,
      input.signal ?? null,
      input.authorizeSession ?? null,
    );
  },
};
