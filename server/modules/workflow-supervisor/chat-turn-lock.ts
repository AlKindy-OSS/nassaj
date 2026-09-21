/**
 * chat-turn-lock — the per-conversation advisory flock BOTH the live chat path
 * (claude-sdk.js) and the Tier-B injector take, so a resumed injection can never
 * interleave its jsonl appends with a live turn writing the same `<sid>.jsonl`
 * (§ج-4, الشرط 3 — the single critical-path touch, the 502-risk seam).
 *
 * THE KERNEL PRIMITIVE (same OFD trick as supervisor-lock.ts, proven kill-9-safe)
 * ------------------------------------------------------------------------------
 * openSync(lockPath) → an fd the process holds for the lock's lifetime. A child
 * `flock <fd>` (mapped to child fd 3 via stdio inheritance) locks the SHARED open
 * file description; the child exits but the lock PERSISTS through the parent's fd,
 * and is released only when the parent closes it (or dies — any signal, incl.
 * kill -9). So a crashed holder never leaves a stale lock.
 *
 * ASYNC, NEVER BLOCKING THE EVENT LOOP
 * ------------------------------------
 * The chat side is on the app's hot path, so acquisition uses async `spawn`
 * (NOT spawnSync): the `flock -w <sec>` child blocks in ITS OWN process while our
 * event loop stays free. A JS-side belt timer kills a stuck flock so a hung lock
 * binary can never freeze a turn.
 *
 * TWO TAKERS, TWO DISCIPLINES (§ج-4):
 *  - acquireInjectorTurnLock  : `flock -n`  (non-block). Held by a human ⇒ the
 *      injector DEFERS immediately (human priority — it never blocks a live turn).
 *  - acquireChatTurnLockForLiveTurn : `flock -w <ceilingSec>`. The rare case (an
 *      injection started just before this human turn); it waits the bounded
 *      ceiling — the injector's own hold cap is smaller, so it releases first and
 *      the human acquires CLEANLY (zero concurrent append). A genuine timeout past
 *      the ceiling ⇒ proceed fail-OPEN for the human (§ح-3) + audit — never an
 *      infinite block on the critical path.
 *
 * FLAG-OFF ⇒ BYTE-IDENTICAL: the chat helper returns a null lock synchronously
 * when the sub-flag is off (one env read, no fs, no spawn, no await), so the
 * critical path is unchanged.
 */

import { openSync, closeSync, mkdirSync, appendFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  isChatTurnLockEnabled,
  chatLocksDir,
  chatLockWaitMs,
  chatLockAuditPath,
} from './config.js';

/** Same strict charset as a DurableTask conversationId (no path traversal). */
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type ChatTurnLock = {
  /** true only when a real flock is held; false = fail-open no-op (proceed). */
  held: boolean;
  /** Why the lock is in this state (for audit/tests). */
  reason:
    | 'acquired'
    | 'disabled'
    | 'bad-conversation-id'
    | 'open-failed'
    | 'contended' // injector: held by someone else ⇒ defer
    | 'timeout-fail-open' // chat: waited the ceiling, proceeding anyway
    | 'error-fail-open';
  /** Release the held lock (no-op when not held). Idempotent. */
  release: () => void;
};

const NOOP_RELEASE = (): void => {};

function lockPathFor(conversationId: string, env: NodeJS.ProcessEnv): string {
  return path.join(chatLocksDir(env), `${conversationId}.lock`);
}

/** Best-effort audit line for the chat-lock seam (never throws, never hot when off). */
function auditChatLock(env: NodeJS.ProcessEnv, rec: Record<string, unknown>): void {
  try {
    appendFileSync(
      chatLockAuditPath(env),
      JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n',
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Run `flock <args> 3` against the shared OFD asynchronously. Resolves true when
 * the child exits 0 (lock acquired), false otherwise (would-block/timeout/error).
 * A belt timer (`killAfterMs`) kills a flock that overruns so nothing hangs.
 */
function flockAsync(fd: number, args: string[], killAfterMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('flock', args, { stdio: ['ignore', 'ignore', 'ignore', fd] });
    } catch {
      done(false);
      return;
    }
    const timer =
      killAfterMs > 0
        ? setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
            done(false);
          }, killAfterMs)
        : null;
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
  });
}

/**
 * Open the lock file and return its held fd, or null on failure. mkdir 0700 first
 * so the whole chat-locks tree matches the web-originated 0700 discipline.
 */
function openLockFd(conversationId: string, env: NodeJS.ProcessEnv): number | null {
  try {
    const dir = chatLocksDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort */
    }
    return openSync(lockPathFor(conversationId, env), 'w', 0o600);
  } catch {
    return null;
  }
}

function makeHeldLock(fd: number, reason: ChatTurnLock['reason']): ChatTurnLock {
  let released = false;
  return {
    held: true,
    reason,
    release: () => {
      if (released) return;
      released = true;
      try {
        closeSync(fd); // dropping the last fd to the OFD releases the flock
      } catch {
        /* process death releases it regardless */
      }
    },
  };
}

/**
 * INJECTOR side — non-blocking. Returns a held lock, or a NOT-held lock with
 * reason 'contended' when a human turn already holds it (⇒ the injector defers,
 * human priority). Never waits, never throws.
 */
export async function acquireInjectorTurnLock(
  conversationId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChatTurnLock> {
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    return { held: false, reason: 'bad-conversation-id', release: NOOP_RELEASE };
  }
  const fd = openLockFd(conversationId, env);
  if (fd == null) {
    return { held: false, reason: 'open-failed', release: NOOP_RELEASE };
  }
  const acquired = await flockAsync(fd, ['-n', '3'], 5_000);
  if (!acquired) {
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
    return { held: false, reason: 'contended', release: NOOP_RELEASE };
  }
  return makeHeldLock(fd, 'acquired');
}

/**
 * LIVE CHAT side — bounded wait. Returns a null-ish lock synchronously when the
 * sub-flag is off (byte-identical critical path). Otherwise waits up to the
 * ceiling for the lock:
 *   - acquired ⇒ held lock (release in the caller's finally),
 *   - ceiling exceeded / error ⇒ NOT-held (fail-OPEN for the human, §ح-3) + audit;
 *     the caller proceeds exactly as before.
 * `conversationId` is the resume target (options.sessionId). New conversations
 * (no resume id) must not call this — there is nothing an injector can target.
 */
export async function acquireChatTurnLockForLiveTurn(
  conversationId: string | null | undefined,
  userId: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChatTurnLock> {
  // Flag OFF (or no resume target) ⇒ no lock, no fs, no spawn — byte-identical.
  if (!conversationId || !isChatTurnLockEnabled(env)) {
    return { held: false, reason: 'disabled', release: NOOP_RELEASE };
  }
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    return { held: false, reason: 'bad-conversation-id', release: NOOP_RELEASE };
  }
  const fd = openLockFd(conversationId, env);
  if (fd == null) {
    auditChatLock(env, { event: 'chat-lock-open-failed', conversationId, userId: userId ?? null });
    return { held: false, reason: 'open-failed', release: NOOP_RELEASE };
  }
  const waitMs = chatLockWaitMs(env);
  const waitSec = Math.max(0, waitMs / 1000);
  // Belt: kill the flock child a little past its own -w ceiling so a hung binary
  // cannot freeze the turn (the ceiling itself already bounds -w).
  const acquired = await flockAsync(fd, ['-w', String(waitSec), '3'], waitMs + 2_000);
  if (!acquired) {
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
    // §ح-3: a genuine timeout means the injector overran even its own hold cap
    // (a bug). Proceed fail-OPEN for the human rather than block the critical
    // path — with an audit line so the rare event is visible.
    auditChatLock(env, {
      event: 'chat-lock-timeout-fail-open',
      conversationId,
      userId: userId ?? null,
      waitMs,
    });
    return { held: false, reason: 'timeout-fail-open', release: NOOP_RELEASE };
  }
  return makeHeldLock(fd, 'acquired');
}
