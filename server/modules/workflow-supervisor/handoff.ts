/**
 * handoff — the exactly-once Tier-A CARD DELIVERY (§أ-4 consumer protocol, §د),
 * ported from the proven T-819 consumer spike (`spikes/b103-t819/lib/handoff.mjs`)
 * onto server code (audit condition C2). The delivery contract, proven there on
 * REAL claude transcripts, is reproduced here verbatim in logic:
 *
 *   handoffId(taskId) = deterministic content hash (sha256, 128-bit).
 *   ledger            = handoffs/<conversationId>.done — the PRIMARY exactly-once
 *                       key (atomic, batch-level, §أ-2), written through the SAME
 *                       atomic primitive `seal` uses for DONE (writeFileAtomic).
 *   jsonl reconcile   = the SECONDARY key that closes the crash window BETWEEN an
 *                       append and its ledger write. Match ONLY on a fully
 *                       JSON.parse-able line carrying handoffId — a torn/half-
 *                       written line does NOT parse, so it is IGNORED and treated
 *                       "not delivered" (conservative, loss-free). This is the
 *                       whole point of the 6.5%-analog lesson: a text regex would
 *                       match the torn line and wrongly skip → LOSS; JSON.parse
 *                       does not.
 *
 * finalizeDelivery is idempotent: N repeats on one task ⇒ exactly one handoffId.
 *
 * DIVERGENCE FROM THE SPIKE (documented, deliberate): the T-819 spike injected a
 * jsonl line ONLY for SUCCEEDED (a Tier-B-shaped consumable turn) and did ledger-
 * only for PARTIAL/CRASHED. T-821 Tier-A delivers a NON-LLM notification CARD for
 * EVERY terminal outcome (§و/م3: "بطاقة عند كل حالة نهائية"), so the jsonl append
 * runs for all outcomes and the outcome only changes the card's copy/status. The
 * exactly-once protocol (ledger + JSON.parse scan) is otherwise identical.
 *
 * THE CARD SHAPE (§د, zero new client code): the appended line is BOTH
 *   (a) a persisted `task_reconcile` NormalizedMessage — so getSessionMessages'
 *       provider returns it VERBATIM (claude-sessions.provider.ts:355) and the
 *       EXISTING task-notification card renderer (useChatMessages 'task_reconcile')
 *       displays it from `summary`/`taskStatus`, attributed `task-notification`
 *       (never the user), and
 *   (b) a transcript-shaped `type:'user'` row whose `message.content` carries the
 *       sanitized, sized, UNTRUSTED-wrapped result — so a later `claude -p
 *       --resume` reads it as DATA, not instructions (§هـ-3). The web card renders
 *       `summary` and never shows `message.content`, so the two purposes do not
 *       collide.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// eslint-disable-next-line boundaries/dependencies -- ADR-201 A1.5: the pinned-open primitive (pure fs), without loading the providers barrel in the supervisor process.
import { canonicalFileSync, openPinnedSync, PinnedOpenError } from '../providers/shared/pinned-fd.js';
// eslint-disable-next-line boundaries/dependencies -- ADR-219 م-2: the pure wrapper-tag escape leaf (node:crypto only), shared by every stdin writer.
import { escapePeerWrapperTags } from '../peer-relay/peer-wire.js';

import { writeFileAtomic } from './result-capture-writer.js';
import { handoffsDir } from './config.js';
import {
  capTranscriptPermissionMode,
  lastTranscriptPermissionMode,
  type ClaudePermissionMode,
} from './permission-mode.js';
import type { Classification } from './result-capture.js';

/** Small chunks so a torn-write test can tear at a byte-precise offset. */
const CHUNK = 64;
/** Untrusted result excerpt byte budget (§هـ-3 sizing). */
const RESULT_EXCERPT_MAX = 32 * 1024;

/** Appended when an excerpt is clamped. Counted WITHIN RESULT_EXCERPT_MAX so the
 * whole excerpt (body + marker) never exceeds the byte budget — see B-157. */
const TRUNCATION_MARKER = '…[مقصوص؛ الكامل في tasks/<id>/result.json]';

/** Terminal outcome the card reports (RUNNING is never delivered). */
export type DeliverOutcome = Exclude<Classification, 'RUNNING'>;

export type HandoffTask = {
  taskId: string;
  conversationId: string;
  /** Optional parent uuid to chain the card into the transcript tree. */
  parentUuid?: string | null;
};

/** Deterministic, content-addressed handoff id. Same taskId ⇒ same id, always. */
export function handoffId(taskId: string): string {
  return crypto.createHash('sha256').update(String(taskId)).digest('hex').slice(0, 32);
}

export function ledgerPath(stateRoot: NodeJS.ProcessEnv | string, conversationId: string): string {
  const dir =
    typeof stateRoot === 'string'
      ? path.join(stateRoot, 'handoffs')
      : handoffsDir(stateRoot);
  return path.join(dir, `${conversationId}.done`);
}

/**
 * ADR-219 م-8: the ledger is shared by two delivery kinds. `handoff` entries
 * (Tier-B background results) predate the field, so an entry with no `kind`
 * is a handoff keyed by its taskId; `peer` entries are keyed by peerMessageId.
 */
export type DeliveryKind = 'handoff' | 'peer';

type LedgerEntry = {
  kind?: DeliveryKind; deliveryId?: string; taskId?: string; handoffId?: string; ref?: string; outcome?: string;
};

type Ledger = {
  entries?: LedgerEntry[];
  _unparsable?: true;
};

/** Stable key of an entry: (kind, deliveryId), legacy entries read as (handoff, taskId). */
function entryKey(entry: LedgerEntry): string | null {
  const kind = entry.kind ?? 'handoff';
  const id = entry.deliveryId ?? (kind === 'handoff' ? entry.taskId : undefined);
  return typeof id === 'string' && id ? `${kind}\0${id}` : null;
}

/** Read the per-conversation batch ledger. Missing → null; corrupt → {_unparsable}. */
export function readLedger(
  env: NodeJS.ProcessEnv,
  conversationId: string,
): Ledger | null {
  const p = ledgerPath(env, conversationId);
  if (!fs.existsSync(p)) {
    return null;
  }
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8')) as Ledger;
    if (!o || !Array.isArray(o.entries)) {
      return { _unparsable: true };
    }
    return o;
  } catch {
    return { _unparsable: true };
  }
}

export function ledgerHasTask(ledger: Ledger | null, taskId: string): boolean {
  return ledgerHasDelivery(ledger, 'handoff', taskId);
}

/** True when the ledger already committed the (kind, deliveryId) delivery. */
export function ledgerHasDelivery(ledger: Ledger | null, kind: DeliveryKind, deliveryId: string): boolean {
  const key = `${kind}\0${deliveryId}`;
  return !!(
    ledger &&
    !ledger._unparsable &&
    Array.isArray(ledger.entries) &&
    ledger.entries.some((e) => e && entryKey(e) === key)
  );
}

/**
 * ADR-201 A1.5 — the conversation transcript is never opened by name: the
 * directory part is realpath-resolved, the file is pinned single-link with
 * `O_NOFOLLOW` and its kernel path confirmed. Tree confinement and the id
 * binding are proven before delivery by the supervisor's target check
 * (verifyDeliveryTarget → the pinned reader), which hands down the realpath.
 */
function pinnedTranscriptSync(jsonlPath: string, flags: number = fs.constants.O_RDONLY) {
  const real = canonicalFileSync(jsonlPath);
  if (!real) throw new PinnedOpenError('missing');
  return openPinnedSync(real, flags);
}

/** Whole transcript text from a pinned descriptor; null when the file is absent. */
function readTranscriptSync(jsonlPath: string): string | null {
  let pinned;
  try {
    pinned = pinnedTranscriptSync(jsonlPath);
  } catch (error) {
    if (error instanceof PinnedOpenError && error.reason === 'missing') return null;
    throw error;
  }
  try {
    return fs.readFileSync(pinned.fd, 'utf8');
  } finally {
    fs.closeSync(pinned.fd);
  }
}

/** T-2071 (qa M4): only this much of a transcript's tail is read for its mode. */
export const PERMISSION_MODE_TAIL_BYTES = 256 * 1024;

/** The last `maxBytes` of a transcript from a pinned descriptor; null when absent. */
function readTranscriptTailSync(jsonlPath: string, maxBytes: number): string | null {
  let pinned;
  try {
    pinned = pinnedTranscriptSync(jsonlPath);
  } catch (error) {
    if (error instanceof PinnedOpenError && error.reason === 'missing') return null;
    throw error;
  }
  try {
    const size = fs.fstatSync(pinned.fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(pinned.fd, buffer, 0, length, size - length);
    // The first line may be cut mid-row; the parser skips what does not parse.
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(pinned.fd);
  }
}

/**
 * T-2071: the conversation's permission mode for a resumed turn, read from a
 * bounded tail of the transcript through the same pinned reader as delivery.
 * GUARD (qa M4): capped by capTranscriptPermissionMode — a transcript row alone
 * can never raise the turn above `default`. Absent or unreadable → the fallback.
 */
export function readSessionPermissionMode(jsonlPath: string): ClaudePermissionMode {
  try {
    return capTranscriptPermissionMode(
      lastTranscriptPermissionMode(readTranscriptTailSync(jsonlPath, PERMISSION_MODE_TAIL_BYTES)));
  } catch {
    return lastTranscriptPermissionMode(null);
  }
}

/**
 * Pinned append descriptor: the existing file opened `O_APPEND`, or a new one
 * created exclusively (never through a planted name).
 */
function openAppendSync(jsonlPath: string): number {
  const append = fs.constants.O_WRONLY | fs.constants.O_APPEND;
  try {
    return pinnedTranscriptSync(jsonlPath, append).fd;
  } catch (error) {
    if (!(error instanceof PinnedOpenError) || error.reason !== 'missing') throw error;
    return pinnedTranscriptSync(jsonlPath, append | fs.constants.O_CREAT | fs.constants.O_EXCL).fd;
  }
}

/** True when the transcript's last byte is not a newline (a torn tail). */
function endsTorn(jsonlPath: string): boolean {
  let pinned;
  try {
    pinned = pinnedTranscriptSync(jsonlPath);
  } catch {
    return false; // missing file → no prefix
  }
  try {
    const size = Number(pinned.stat.size);
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    fs.readSync(pinned.fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    fs.closeSync(pinned.fd);
  }
}

export type JsonlScan = {
  validMatch: boolean;
  validMatchCount: number;
  regexMatch: boolean;
  regexMatchCount: number;
  tornLines: number;
  totalLines: number;
  lastLineParseable: boolean | null;
};

/**
 * Scan the conversation jsonl for a COMMITTED delivery of `hId`.
 *  - json  (default): a match requires a fully JSON.parse-able line whose
 *                     handoffId (or an entry of handoffIds[]) equals hId. Torn
 *                     lines are counted but IGNORED (loss-free).
 *  - regex (control): a match is any line containing the handoffId TEXT — the
 *                     unsafe behavior the design rejects; kept only so a test can
 *                     reproduce the divergence on the SAME file.
 */
export function scanJsonl(
  jsonlPath: string,
  hId: string,
  { matcher = 'json' }: { matcher?: 'json' | 'regex' } = {},
): JsonlScan {
  const res: JsonlScan = {
    validMatch: false,
    validMatchCount: 0,
    regexMatch: false,
    regexMatchCount: 0,
    tornLines: 0,
    totalLines: 0,
    lastLineParseable: null,
  };
  const text = readTranscriptSync(jsonlPath);
  if (text === null) {
    return res;
  }
  const lines = text.split('\n');
  const needle = `"handoffId":"${hId}"`;
  for (const line of lines) {
    if (line === '') {
      continue;
    }
    res.totalLines++;
    if (line.includes(needle)) {
      res.regexMatch = true;
      res.regexMatchCount++;
    }
    let obj: Record<string, unknown> | null = null;
    let ok = true;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      ok = false;
    }
    res.lastLineParseable = ok;
    if (!ok) {
      res.tornLines++;
      continue;
    }
    const hoIds = obj?.handoffIds;
    const carries =
      obj?.handoffId === hId ||
      (Array.isArray(hoIds) && (hoIds as unknown[]).includes(hId));
    if (carries) {
      res.validMatch = true;
      res.validMatchCount++;
    }
  }
  return res;
}

/** Arabic display copy per terminal outcome (shown by the card via `summary`). */
const OUTCOME_SUMMARY: Record<DeliverOutcome, string> = {
  SUCCEEDED: 'اكتملت المهمة الخلفية',
  PARTIAL: 'لم تكتمل المهمة الخلفية (جزئي)',
  'PARTIAL-untrusted': 'انتهت المهمة الخلفية دون ختم موثوق (جزئي)',
  CRASHED: 'تعذّر إكمال المهمة الخلفية (انهيار)',
};

/**
 * Clamp `s` to at most `maxBytes` UTF-8 bytes WITHOUT splitting a multi-byte code
 * point. `String.prototype.slice` counts UTF-16 units, so slicing at a BYTE budget
 * keeps ~2× the bytes for 2-byte scripts (Arabic) and can even bisect a code
 * point; this measures real UTF-8 bytes (Buffer) and backs up off any trailing
 * continuation byte (0b10xxxxxx) so the cut lands on a code-point boundary (B-157).
 */
function clampUtf8Bytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) {
    return s;
  }
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return buf.toString('utf8', 0, end);
}

/**
 * Sanitize an untrusted model-output excerpt before it is wrapped (§هـ-3):
 *  - strip C0 control chars except tab/newline (they corrupt a jsonl line),
 *  - neutralize any embedded closing tag so the payload cannot escape the
 *    untrusted wrapper and smuggle trusted markup,
 *  - clamp to the byte budget (byte-precise, code-point-safe) with a marker.
 */
export function sanitizeUntrusted(raw: string): string {
  let s = Array.from(raw)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      // keep tab(9)/newline(10)/CR(13); drop other C0 controls + DEL(127).
      if (c === 9 || c === 10 || c === 13) return true;
      return !(c < 0x20 || c === 0x7f);
    })
    .join('');
  s = s.replace(/<\/background_task_result/gi, '<\\/background_task_result');
  // ADR-219 م-2: a result can never carry a peer wrapper the CLI or model would trust.
  s = escapePeerWrapperTags(s);
  if (Buffer.byteLength(s, 'utf8') > RESULT_EXCERPT_MAX) {
    // Byte-precise, code-point-safe clamp; the marker is counted within the budget
    // so the whole excerpt stays ≤ RESULT_EXCERPT_MAX bytes (B-157).
    const budget = RESULT_EXCERPT_MAX - Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
    s = clampUtf8Bytes(s, budget) + TRUNCATION_MARKER;
  }
  return s;
}

/**
 * Build the dual-purpose delivery card line (see file header). `resultObj` is the
 * raw (untrusted) task output or a small note; it is serialized, sanitized, sized,
 * and wrapped `<background_task_result untrusted="true">…` for the resume path,
 * while the web card shows only the clean Arabic `summary`.
 */
export function buildHandoffCard(
  task: HandoffTask,
  resultObj: unknown,
  outcome: DeliverOutcome,
  hId: string,
): Record<string, unknown> {
  const body = typeof resultObj === 'string' ? resultObj : JSON.stringify(resultObj);
  const untrusted = `<background_task_result untrusted="true">${sanitizeUntrusted(body)}</background_task_result>`;
  const summary = OUTCOME_SUMMARY[outcome];
  const taskStatus = outcome === 'SUCCEEDED' ? 'completed' : 'settled';
  return {
    // (a) web task-notification card (provider returns verbatim; renderer reads
    //     summary/taskStatus; NEVER attributed to the user via originKind).
    kind: 'task_reconcile',
    provider: 'claude',
    sessionId: task.conversationId,
    id: `bgtask-${hId}`,
    timestamp: new Date().toISOString(),
    isTaskNotification: true,
    taskStatus,
    originKind: 'task-notification',
    summary,
    content: summary,
    backgroundTaskOutcome: outcome,
    // machine/audit + exactly-once dedup keys (ignored by the card renderer).
    handoffId: hId,
    handoffIds: [hId],
    taskId: task.taskId,
    taskIds: [task.taskId],
    // (b) transcript-shaped message so `claude -p --resume` reads the result as
    //     UNTRUSTED DATA (§هـ-3). The web card renders `summary`, not this.
    type: 'user',
    uuid: crypto.randomUUID(),
    parentUuid: task.parentUuid ?? null,
    isSidechain: false,
    userType: 'external',
    isMeta: false,
    message: { role: 'user', content: untrusted },
  };
}

/**
 * Append the card line to the conversation jsonl (the "delivery"). Guards the
 * NEW-LINE boundary (T-819 lesson): if a PRIOR append was interrupted the file
 * ends WITHOUT '\n', so appending directly would concatenate onto the torn
 * fragment and corrupt the new line too — start on a fresh line. `tearAtOffset`
 * (test-only) SIGKILLs mid-write BEFORE the newline and BEFORE the ledger, a
 * genuine interrupted append leaving a torn last line + no ledger.
 */
export function appendCardLine(
  jsonlPath: string,
  lineObj: Record<string, unknown>,
  { tearAtOffset = null }: { tearAtOffset?: number | null } = {},
): number {
  fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
  const prefix = endsTorn(jsonlPath) ? '\n' : '';
  const payload = Buffer.from(prefix + JSON.stringify(lineObj) + '\n');
  const fd = openAppendSync(jsonlPath);
  try {
    if (tearAtOffset == null) {
      fs.writeSync(fd, payload);
      fs.fsyncSync(fd);
      return payload.length;
    }
    let written = 0;
    while (written < payload.length) {
      let end = Math.min(written + CHUNK, payload.length);
      if (written < tearAtOffset && tearAtOffset <= end) {
        end = tearAtOffset;
      }
      fs.writeSync(fd, payload, written, end - written);
      written = end;
      if (written === tearAtOffset) {
        fs.fsyncSync(fd);
        process.kill(process.pid, 'SIGKILL');
      }
    }
    fs.fsyncSync(fd);
    return payload.length;
  } finally {
    fs.closeSync(fd);
  }
}

/** Merge one delivery entry into the batch ledger and commit it atomically. */
export function writeLedgerEntry(
  env: NodeJS.ProcessEnv,
  conversationId: string,
  entry: { taskId: string; handoffId: string; outcome: string },
): void {
  writeLedgerEntries(env, conversationId, [entry]);
}

/**
 * Merge SEVERAL delivery entries into the per-conversation batch ledger in ONE
 * atomic tmp→rename (§أ-2 coalescing: a coalesced Tier-B turn commits ALL its
 * taskIds together — no ledger-per-task, so there is no partial-commit window
 * that could re-deliver some of the batch). Idempotent: an entry whose taskId is
 * already present is not duplicated. `writeLedgerEntry` is the size-1 case.
 */
export function writeLedgerEntries(
  env: NodeJS.ProcessEnv,
  conversationId: string,
  newEntries: Array<{ taskId: string; handoffId: string; outcome: string }>,
): void {
  writeDeliveryLedgerEntries(env, conversationId, newEntries.map((e) => ({
    kind: 'handoff', deliveryId: e.taskId, ...e,
  })));
}

/**
 * ADR-219 م-8: merge entries of either kind in ONE atomic tmp→rename, keyed by
 * (kind, deliveryId) so a handoff and a peer delivery can never collide.
 */
export function writeDeliveryLedgerEntries(
  env: NodeJS.ProcessEnv,
  conversationId: string,
  newEntries: Array<LedgerEntry & { kind: DeliveryKind; deliveryId: string; outcome: string }>,
): void {
  const dir = handoffsDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const prev = readLedger(env, conversationId);
  const entries =
    prev && !prev._unparsable && Array.isArray(prev.entries) ? prev.entries.slice() : [];
  const now = new Date().toISOString();
  for (const entry of newEntries) {
    const key = entryKey(entry);
    if (key && !entries.some((e) => entryKey(e) === key)) {
      entries.push({ ...entry, committedAt: now } as never);
    }
  }
  const doc = {
    schema: 't821-handoff-ledger-1',
    conversationId,
    entries,
    committedAt: now,
  };
  writeFileAtomic(dir, `${conversationId}.done`, Buffer.from(JSON.stringify(doc) + '\n'));
}

/**
 * T-822 Tier-B exactly-once anchor. A `--resume` turn does NOT let us author the
 * jsonl line shape (the CLI writes it), so the handoffId cannot ride as a
 * top-level field the way a Tier-A card does. Instead the injector embeds a
 * unique, collision-free ref token INSIDE the untrusted data wrapper it sends as
 * the prompt (see wrapUntrustedResultForInjection); the CLI then persists that
 * token verbatim inside the resumed USER line's message.content. This builds that
 * token so the producer (injector) and the consumer (this scan) agree on it.
 */
export function injectionRefToken(hId: string): string {
  return `bgtaskref-${hId}`;
}

/**
 * Wrap an untrusted result for the INJECTED prompt (§هـ-3), carrying the ref
 * token in the OPENING tag (which we author, before the sanitized body — the
 * body can never rewrite it). Same sanitize/size discipline as the Tier-A card.
 */
export function wrapUntrustedResultForInjection(resultObj: unknown, hId: string): string {
  const body = typeof resultObj === 'string' ? resultObj : JSON.stringify(resultObj);
  const ref = injectionRefToken(hId);
  return `<background_task_result untrusted="true" ref="${ref}">${sanitizeUntrusted(body)}</background_task_result>`;
}

/**
 * Scan the conversation jsonl for a COMMITTED injected turn carrying `ref`. Same
 * loss-free discipline as scanJsonl: only a fully JSON.parse-able line counts (a
 * torn/half-written resume line does NOT parse ⇒ ignored ⇒ treated "not
 * delivered", so the injector re-tries rather than skipping — never a LOSS). On a
 * parseable line the unique 40-char ref token is matched as a substring (it is
 * ours and collision-free). Returns {found, matchCount, tornLines, totalLines}.
 */
export function scanJsonlForInjectedRef(
  jsonlPath: string,
  ref: string,
): { found: boolean; matchCount: number; tornLines: number; totalLines: number } {
  const res = { found: false, matchCount: 0, tornLines: 0, totalLines: 0 };
  const text = readTranscriptSync(jsonlPath);
  if (text === null) {
    return res;
  }
  const lines = text.split('\n');
  for (const line of lines) {
    if (line === '') {
      continue;
    }
    res.totalLines++;
    let ok = true;
    try {
      JSON.parse(line);
    } catch {
      ok = false;
    }
    if (!ok) {
      res.tornLines++;
      continue; // torn line ignored (loss-free) — the 6.5% lesson
    }
    if (line.includes(ref)) {
      res.found = true;
      res.matchCount++;
    }
  }
  return res;
}

/** ADR-219 م-7: the transcript's current byte size (the proof scan's start), null when absent. */
export function transcriptByteSize(jsonlPath: string): number | null {
  let pinned;
  try {
    pinned = pinnedTranscriptSync(jsonlPath);
  } catch {
    return null;
  }
  try {
    return Number(pinned.stat.size);
  } finally {
    fs.closeSync(pinned.fd);
  }
}

/** Upper bound of bytes a proof scan reads after its offset (a turn is USD-capped). */
const PROOF_SCAN_MAX_BYTES = 64 * 1024 * 1024;

/**
 * ADR-219 م-7/م-8: the proof scan over ONLY what was appended since `fromOffset`
 * (the size at claim), so a large history is never re-read. A line cut by the
 * offset is skipped; a torn last line never parses. Missing file → false.
 */
export function scanJsonlForProofFrom(jsonlPath: string, fromOffset: number, isProof: (row: unknown) => boolean): boolean {
  let pinned;
  try {
    pinned = pinnedTranscriptSync(jsonlPath);
  } catch {
    return false;
  }
  try {
    const size = Number(pinned.stat.size);
    const start = Math.max(0, Math.min(fromOffset, size));
    const length = Math.min(size - start, PROOF_SCAN_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(pinned.fd, buffer, 0, length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0 && !atLineStart(pinned.fd, start)) lines.shift();
    return lines.some((line) => line !== '' && parsesAsProof(line, isProof));
  } finally {
    fs.closeSync(pinned.fd);
  }
}

function atLineStart(fd: number, offset: number): boolean {
  const previous = Buffer.alloc(1);
  fs.readSync(fd, previous, 0, 1, offset - 1);
  return previous[0] === 0x0a;
}

function parsesAsProof(line: string, isProof: (row: unknown) => boolean): boolean {
  try {
    return isProof(JSON.parse(line));
  } catch {
    return false;
  }
}

export type FinalizeInput = {
  env: NodeJS.ProcessEnv;
  task: HandoffTask;
  /** The AUTHORITATIVE target resolved from the DB (never built from web input). */
  jsonlPath: string;
  resultObj: unknown;
  outcome: DeliverOutcome;
};

export type FinalizeHooks = {
  matcher?: 'json' | 'regex';
  tearAtOffset?: number | null;
  /** Sleep (ms) between append and ledger — widens the crash window (tests). */
  widenMs?: number;
  /** Marker file written at the top of the append→ledger gap (tests). */
  injectedMarkerPath?: string | null;
  sleep?: (ms: number) => void;
};

export type FinalizeAction = {
  taskId: string;
  conversationId: string;
  handoffId: string;
  event: 'skip-ledger-hit' | 'ledger-repair' | 'inject+ledger';
  injected: boolean;
  ledgerWritten: boolean;
  delivered: boolean;
  outcome: DeliverOutcome;
  scan?: JsonlScan;
};

/**
 * The exactly-once delivery step for ONE terminal task. Order:
 *   ledger (primary) → jsonl reconcile (secondary) → append card → ledger.
 * Returns a structured action for the audit/actions log. Every outcome delivers a
 * card (Tier-A), so the append runs for all — the outcome only sets the copy.
 */
export function finalizeDelivery(input: FinalizeInput, hooks: FinalizeHooks = {}): FinalizeAction {
  const { env, task, jsonlPath, resultObj, outcome } = input;
  const matcher = hooks.matcher ?? 'json';
  const conversationId = task.conversationId;
  const hId = handoffId(task.taskId);
  const base = { taskId: task.taskId, conversationId, handoffId: hId, outcome };
  const sleep = hooks.sleep ?? ((ms: number) => {
    if (ms > 0) {
      const sab = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sab, 0, 0, ms);
    }
  });

  // (1) Primary key: the batch ledger. Already recorded ⇒ idempotent no-op.
  const ledger = readLedger(env, conversationId);
  if (ledgerHasTask(ledger, task.taskId)) {
    return { ...base, event: 'skip-ledger-hit', injected: false, ledgerWritten: false, delivered: true };
  }

  // (2) Ledger absent → reconcile from jsonl. The matcher choice IS the guarantee.
  const scan = scanJsonl(jsonlPath, hId, { matcher });
  const committed = matcher === 'regex' ? scan.regexMatch : scan.validMatch;
  if (committed) {
    // Append already committed but ledger not written (crash window) → repair the
    // ledger only. (In regex mode a TORN line trips this ⇒ ledger claims delivered
    // with no valid line ⇒ LOSS — exactly what JSON.parse mode avoids.)
    writeLedgerEntry(env, conversationId, { taskId: task.taskId, handoffId: hId, outcome });
    return { ...base, event: 'ledger-repair', injected: false, ledgerWritten: true, delivered: true, scan };
  }

  // (3) Not committed (no line, or only a torn one) → append card, then ledger.
  appendCardLine(jsonlPath, buildHandoffCard(task, resultObj, outcome, hId), {
    tearAtOffset: hooks.tearAtOffset ?? null,
  }); // may SIGKILL self here (tear) → dies before marker/ledger
  if (hooks.injectedMarkerPath) {
    try {
      fs.writeFileSync(hooks.injectedMarkerPath, hId);
    } catch {
      /* best-effort */
    }
  }
  if (hooks.widenMs && hooks.widenMs > 0) {
    sleep(hooks.widenMs); // crash window for a monitor kill -9 (test-only)
  }
  writeLedgerEntry(env, conversationId, { taskId: task.taskId, handoffId: hId, outcome });
  if (hooks.injectedMarkerPath) {
    try {
      fs.unlinkSync(hooks.injectedMarkerPath);
    } catch {
      /* best-effort */
    }
  }
  return { ...base, event: 'inject+ledger', injected: true, ledgerWritten: true, delivered: true, scan };
}
