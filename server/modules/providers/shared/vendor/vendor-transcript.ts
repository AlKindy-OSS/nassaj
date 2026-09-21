import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { logicalProjectPathForWorkspace } from '@/modules/session-workspaces/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { normalizeSessionName, sanitizeLeafDirectoryName } from '@/shared/utils.js';

import { readResponseModel } from '../response-model.js';
import { vendorReceiptMetadata, type VendorReceiptInput } from './vendor-receipt-identity.js';

/**
 * On-disk transcript layout for providers whose transcript nassaj must own —
 * the hosted vendors (kimi/deepseek/glm) and hermes (B-599).
 *
 * Unlike the first-party CLIs, these providers write no local transcript nassaj
 * can read back. The hosted vendors are remote HTTP APIs; nassaj therefore owns their transcript: the run seam appends
 * each normalized turn as one JSONL line under a stable, content-addressed path,
 * the session synchronizer indexes those files into sessionsDb, and the sessions
 * facet reads them back for history. Keeping this in one shared module means all
 * three providers share an identical, auditable storage shape.
 *
 * Path: ~/.nassaj-vendor-sessions/<provider>/<projectHash>/<sessionId>.jsonl
 *   - <projectHash> = md5(LOGICAL projectPath || cwd), matching how Cursor keys
 *     its per-project chat store, so transcripts for different workspaces never
 *     mix. The path is mapped through `logicalProjectPathForWorkspace` first so a
 *     session launched inside a nassaj session overlay (cwd
 *     `<repo>/.git/nassaj-session-overlays/instances/<id>/workspace`) hashes to
 *     the SAME directory the session row records via `normalizeProjectPathForProvider`.
 *     Without this, writes landed under md5(overlayCwd) while the reader looked
 *     under md5(logicalPath), and every overlay-launched vendor session opened
 *     blank; resuming from a second overlay also forked the transcript. Non-overlay
 *     paths are returned unchanged by the mapper, so their hash is unaffected.
 *   - <sessionId> is sanitized before being used as a leaf filename.
 *
 * Because writes historically keyed on the physical overlay path, older files
 * live under a hash that no longer matches. `resolveVendorTranscriptForRead`
 * below bridges that: it accepts the stored jsonl_path, the newly-computed hash
 * path, and finally a scan of the provider's hash directories.
 */

/** Root of every vendor provider's nassaj-owned transcript tree. */
export function vendorSessionsRoot(): string {
  return path.join(os.homedir(), '.nassaj-vendor-sessions');
}

/** Per-provider transcript directory (used as the watcher root). */
export function vendorProviderRoot(provider: LLMProvider): string {
  return path.join(vendorSessionsRoot(), provider);
}

/**
 * md5 of the LOGICAL project path, matching Cursor's per-project keying and, more
 * importantly, the `project_path` the session row stores. Overlay cwds are mapped
 * back to their logical repository root first; a non-overlay path (including one
 * that does not resolve to an overlay workspace) is returned unchanged, so its
 * hash is identical to the previous `md5(path)` behaviour.
 */
export function vendorProjectHash(projectPath: string | undefined): string {
  const input = projectPath || process.cwd();
  const cached = projectHashCache.get(input);
  if (cached) {
    return cached;
  }
  const logicalPath = logicalProjectPathForWorkspace(input);
  const hash = crypto.createHash('md5').update(logicalPath).digest('hex');
  if (projectHashCache.size >= PROJECT_HASH_CACHE_MAX) {
    projectHashCache.clear();
  }
  projectHashCache.set(input, hash);
  return hash;
}

// The overlay mapper shells out to git synchronously; the hosted vendors append
// one transcript line PER STREAM EVENT, so the mapping is memoised per input
// path. Overlay → logical mapping is stable for the lifetime of a workspace.
const PROJECT_HASH_CACHE_MAX = 512;
const projectHashCache = new Map<string, string>();

/**
 * Resolves the absolute JSONL transcript path for one session, guarding against
 * path traversal via a crafted session id. Throws when the resolved path would
 * escape the provider's project directory.
 */
export function vendorTranscriptPath(
  provider: LLMProvider,
  sessionId: string,
  projectPath: string | undefined,
): string {
  const projectDir = path.join(vendorProviderRoot(provider), vendorProjectHash(projectPath));
  const safeSessionId = sanitizeLeafDirectoryName(sessionId, `${provider} session id`);
  const filePath = path.join(projectDir, `${safeSessionId}.jsonl`);

  const relative = path.relative(path.resolve(projectDir), path.resolve(filePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Invalid ${provider} session path for "${sessionId}".`);
  }
  return filePath;
}

/**
 * Resolves the transcript file to read back for one vendor session, tolerating
 * files written under a legacy (physical-overlay) project hash. Returns the first
 * candidate that exists on disk, or null when none does.
 *
 * Candidates, in order:
 *   (a) `storedJsonlPath` from the session row — only when its leaf name is
 *       `<safeSessionId>.jsonl` AND, after realpath, it is contained under this
 *       provider's root. Containment is checked on the RESOLVED path (mirroring
 *       claude-transcript-path.ts): `jsonl_path` is a DB column, so trusting it
 *       blindly would be an arbitrary-file-read primitive.
 *   (b) the freshly-computed logical-hash path (`vendorTranscriptPath`).
 *   (c) a scan of the provider's hash directories for `<safeSessionId>.jsonl`,
 *       which recovers files written under an older physical-overlay hash before
 *       any resume has re-indexed jsonl_path.
 *
 * NEVER throws: a resolution failure is "no readable transcript", i.e. null.
 */
export async function resolveVendorTranscriptForRead(
  provider: LLMProvider,
  sessionId: string,
  projectPath: string | undefined,
  storedJsonlPath?: string | null,
): Promise<string | null> {
  let safeSessionId: string;
  try {
    safeSessionId = sanitizeLeafDirectoryName(sessionId, `${provider} session id`);
  } catch {
    return null;
  }
  const fileName = `${safeSessionId}.jsonl`;
  const providerRoot = vendorProviderRoot(provider);

  let resolvedRoot: string | null = null;
  try {
    resolvedRoot = await fsp.realpath(providerRoot);
  } catch {
    // The provider has never written a transcript; only an explicit stored path
    // (checked against the unresolved root) could still exist.
    resolvedRoot = null;
  }

  const containmentRoot = resolvedRoot ?? path.resolve(providerRoot);
  const isContained = (target: string): boolean => {
    const relative = path.relative(containmentRoot, target);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };

  const realFileMatching = async (candidate: string): Promise<string | null> => {
    try {
      const resolved = await fsp.realpath(candidate);
      const stat = await fsp.stat(resolved);
      if (stat.isFile() && path.basename(resolved) === fileName && isContained(resolved)) {
        return resolved;
      }
    } catch {
      // Missing / unreadable / escaping candidate simply drops out.
    }
    return null;
  };

  // (a) stored jsonl_path, guarded by leaf-name and containment.
  const stored = (storedJsonlPath ?? '').trim();
  if (stored && path.basename(stored) === fileName) {
    const resolved = await realFileMatching(stored);
    if (resolved) {
      return resolved;
    }
  }

  // (b) the freshly-computed logical-hash path.
  try {
    const computed = await realFileMatching(vendorTranscriptPath(provider, sessionId, projectPath));
    if (computed) {
      return computed;
    }
  } catch {
    // vendorTranscriptPath throws only on an unsafe session id already rejected
    // above; keep the read best-effort regardless.
  }

  // (c) scan the provider's hash directories for a legacy-hash file.
  if (resolvedRoot) {
    let entries: string[];
    try {
      entries = (await fsp.readdir(resolvedRoot)).sort();
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const resolved = await realFileMatching(path.join(resolvedRoot, entry, fileName));
      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

/**
 * Appends one raw event object as a JSONL line, creating the directory on first
 * write. NEVER throws: a transcript is a recording of a conversation, not the
 * conversation — a failed write must not break the stream the user is watching.
 */
export async function appendVendorTranscript(
  provider: LLMProvider,
  sessionId: string,
  projectPath: string | undefined,
  event: unknown,
): Promise<void> {
  try {
    const filePath = vendorTranscriptPath(provider, sessionId, projectPath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.appendFile(filePath, `${JSON.stringify(withoutProviderReceipt(event))}\n`);
  } catch {
    // Best-effort by contract; see the doc comment above.
  }
}

/** Writes the transcript header (project path + title) for a fresh session. */
export async function writeVendorTranscriptMeta(
  provider: LLMProvider,
  sessionId: string,
  projectPath: string | undefined,
  command: string | undefined,
): Promise<void> {
  const sessionName = normalizeSessionName(
    (command || '').split('\n')[0],
    `Untitled ${provider} Session`,
  );
  await appendVendorTranscript(provider, sessionId, projectPath, {
    type: 'meta',
    projectPath: projectPath || process.cwd(),
    sessionName,
  });
}

/** Persist a conversational turn and return its exact message ID only after a successful append. */
export async function appendVendorTranscriptTurn(
  provider: LLMProvider,
  sessionId: string,
  projectPath: string | undefined,
  role: 'user' | 'assistant',
  content: string,
  metadata: { model?: string; finalAnswer?: boolean; receipt?: VendorReceiptInput } = {},
): Promise<string | null> {
  if (!content.trim()) return null;
  const id = crypto.randomUUID();
  try {
    await appendTrustedVendorEvent(provider, sessionId, projectPath, {
      type: 'message', timestamp: new Date().toISOString(),
      message: {
        id, role, content,
        ...vendorReceiptMetadata(provider, sessionId, role, metadata.receipt),
        ...(role === 'assistant' ? {
          model: readResponseModel(metadata.model), isFinalAnswer: metadata.finalAnswer === true,
        } : {}),
      },
    }, id);
    return id;
  } catch {
    // Recording failure must not discard visible provider output or invent a timing join.
    return null;
  }
}

const transcriptLocks = new Map<string, Promise<void>>();

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function acquireProcessLock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const handle = await fsp.open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      return async () => {
        await handle.close().catch(() => undefined);
        await fsp.unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const [raw, stat] = await Promise.all([fsp.readFile(lockPath, 'utf8'), fsp.stat(lockPath)]);
        const owner = JSON.parse(raw) as { pid?: unknown };
        stale = !pidAlive(Number(owner.pid)) && Date.now() - stat.mtimeMs > 1_000;
      } catch {
        const stat = await fsp.stat(lockPath).catch(() => null);
        stale = Boolean(stat && Date.now() - stat.mtimeMs > 30_000);
      }
      if (stale) {
        await fsp.unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error('vendor transcript lock timeout');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** Crash-retry-safe append. Readers may see at most one event for eventId. */
export async function appendVendorTranscriptTurnIdempotent(
  provider: LLMProvider,
  sessionId: string,
  projectPath: string | undefined,
  role: 'user' | 'assistant',
  content: string,
  eventId: string,
  receipt?: VendorReceiptInput,
): Promise<void> {
  if (!content.trim()) return;
  if (!eventId || Buffer.byteLength(eventId) > 256 || /[\x00-\x1f\x7f]/u.test(eventId)) throw new Error('Invalid vendor message identity');
  const filePath = vendorTranscriptPath(provider, sessionId, projectPath);
  const previous = transcriptLocks.get(filePath) ?? Promise.resolve();
  const next = previous.then(async () => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const release = await acquireProcessLock(filePath);
    try {
      let existing = '';
      try { existing = await fsp.readFile(filePath, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // A process can die midway through append. Remove only the unterminated
      // suffix; every earlier newline-delimited event is already committed.
      if (existing && !existing.endsWith('\n')) {
        const lastNewline = existing.lastIndexOf('\n');
        const validPrefix = lastNewline < 0 ? '' : existing.slice(0, lastNewline + 1);
        await fsp.truncate(filePath, Buffer.byteLength(validPrefix));
        existing = validPrefix;
      }
      const exists = existing.split(/\r?\n/).some((line) => {
        try { return (JSON.parse(line) as { eventId?: unknown }).eventId === eventId; }
        catch { return false; }
      });
      if (!exists) {
        await fsp.appendFile(filePath, `${JSON.stringify({
          type: 'message', eventId, message: { id: eventId, role, content,
            ...vendorReceiptMetadata(provider, sessionId, role, receipt) },
        })}\n`);
      }
    } finally {
      await release();
    }
  });
  transcriptLocks.set(filePath, next.catch(() => undefined));
  await next;
}

/** Provider events cannot mint invocation-owned receipt metadata. */
function withoutProviderReceipt(event: unknown): unknown {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
  const record = event as Record<string, unknown>;
  const message = record.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return event;
  const clone = { ...message } as Record<string, unknown>;
  delete clone.nassajReceipt;
  return { ...record, message: clone };
}

/** Strict native-event append: raw provider payloads never establish receipt ownership. */
export async function appendVendorTranscriptEventIdempotent(
  provider: LLMProvider, sessionId: string, projectPath: string | undefined,
  event: Record<string, unknown>, eventId: string,
): Promise<string> {
  return appendTrustedVendorEvent(provider, sessionId, projectPath,
    withoutProviderReceipt(event) as Record<string, unknown>, eventId);
}

/** Strict idempotent append for server-owned provider-native JSONL events. */
async function appendTrustedVendorEvent(
  provider: LLMProvider,
  sessionId: string,
  projectPath: string | undefined,
  event: Record<string, unknown>,
  eventId: string,
): Promise<string> {
  if (!eventId.trim()) throw new Error('eventId is required');
  const filePath = vendorTranscriptPath(provider, sessionId, projectPath);
  const previous = transcriptLocks.get(filePath) ?? Promise.resolve();
  const next = previous.then(async () => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const release = await acquireProcessLock(filePath);
    try {
      let existing = '';
      try { existing = await fsp.readFile(filePath, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (existing && !existing.endsWith('\n')) {
        const lastNewline = existing.lastIndexOf('\n');
        const validPrefix = lastNewline < 0 ? '' : existing.slice(0, lastNewline + 1);
        await fsp.truncate(filePath, Buffer.byteLength(validPrefix));
        existing = validPrefix;
      }
      const exists = existing.split(/\r?\n/u).some((line) => {
        try { return (JSON.parse(line) as { eventId?: unknown }).eventId === eventId; }
        catch { return false; }
      });
      if (!exists) await fsp.appendFile(filePath, `${JSON.stringify({ ...event, eventId })}\n`);
    } finally {
      await release();
    }
  });
  transcriptLocks.set(filePath, next.catch(() => undefined));
  await next;
  return filePath;
}
