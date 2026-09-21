/**
 * useRawExecConfig — shared check for "may this user run a raw command?".
 *
 * Reads the CALLER-SCOPED view at /api/system/command-board-raw once per session
 * (module-level cache, 30s TTL) so every rendered code block shares a single
 * request instead of firing one each.
 *
 * Why that endpoint and not /command-board-config: the config route is owner-only
 * and returns the WHOLE matrix, so it could neither be read by a non-owner nor
 * answer "what is MY tier". The raw route reports the caller's own effective mode,
 * the armed flag and the environment blockers — exactly the three inputs of the
 * server-side decision, so the button appears if and only if the server would
 * accept it. Asking the same question the enforcer asks is what keeps the UI and
 * the route from drifting apart.
 *
 * Fail-closed contract:
 *   • Any missing/ambiguous field, any non-ok response, any throw → false.
 *   • rawExecEnabled must be explicitly true (not merely truthy).
 *   • The caller's own mode must be 'raw' (or legacy 'general' from an older
 *     server, where that vocabulary carried the same capability).
 *   • rawExecBlockedReasons must be a PRESENT, empty array (missing → blocked).
 *
 * The same payload also carries the shared raw QUEUE (B-247). Surfacing it is
 * what `useRawExecQueue` below exists for, and it is deliberately read from this
 * one response rather than a second endpoint: the server already decides there
 * whether the caller may read the queue at all (`mayReadQueue` in
 * server/routes/system.js — raw tier + armed flag + no environment blockers) and
 * ships `commands: []` to everyone else. The client therefore never re-derives
 * visibility from a role; it renders exactly the rows the gate handed it.
 */

import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import type { RawCommand } from '../components/command-board/ExecReviewDialog';

const RAW_URL = '/api/system/command-board-raw';
const CACHE_TTL_MS = 30_000;

/** Stable empty array — a fresh [] each render would re-fire consumer effects. */
const NO_COMMANDS: readonly RawCommand[] = Object.freeze([]);

type BoardPermission = {
  canUseRaw: boolean;
  commands: readonly RawCommand[];
};

/**
 * Keeps only rows the review dialog can actually act on.
 *
 * A row missing `id`, `command` or `digest` cannot be reviewed safely: the digest
 * is the binding between the bytes a human reads and the bytes the server runs,
 * so a row without one would render an Execute path with the integrity check
 * silently absent. Dropping it is the fail-closed reading of a malformed payload.
 */
function parseCommands(value: unknown): readonly RawCommand[] {
  if (!Array.isArray(value)) return NO_COMMANDS;
  const rows = value.flatMap((entry): RawCommand[] => {
    if (!entry || typeof entry !== 'object') return [];
    const v = entry as Record<string, unknown>;
    if (typeof v.id !== 'string' || !v.id) return [];
    if (typeof v.command !== 'string' || !v.command) return [];
    if (typeof v.digest !== 'string' || !v.digest) return [];
    return [{
      id: v.id,
      command: v.command,
      digest: v.digest,
      requestedBy: typeof v.requestedBy === 'string' ? v.requestedBy : null,
      requestedAt: typeof v.requestedAt === 'string' ? v.requestedAt : null,
    }];
  });
  return rows.length > 0 ? rows : NO_COMMANDS;
}

// ── Module-level singleton cache ─────────────────────────────────────────────

let cachedPerm: BoardPermission | null = null;
let cacheTimestamp = 0;
let pendingFetch: Promise<void> | null = null;
/** A refresh asked for while a fetch was already in flight (see ensureFresh). */
let refetchQueued = false;
const subscribers = new Set<(p: BoardPermission) => void>();

function notifySubscribers(p: BoardPermission) {
  subscribers.forEach((fn) => fn(p));
}

function publish(canUseRaw: boolean, commands: readonly RawCommand[] = NO_COMMANDS) {
  cachedPerm = { canUseRaw, commands };
  cacheTimestamp = Date.now();
  notifySubscribers(cachedPerm);
}

/**
 * Drop the cached permission so the next consumer re-fetches immediately.
 *
 * Call this after any write that can change the answer (arming/disarming the
 * master switch, editing the role matrix). Without it the 30s TTL leaves a window
 * where the settings page says "disarmed" while chat code blocks still offer an
 * Execute button — the server would refuse it, so the risk is a confusing dead
 * button rather than an unauthorised run, but the two views must not disagree.
 */
export function invalidateRawExecConfig(): void {
  cachedPerm = null;
  cacheTimestamp = 0;
}

/**
 * Invalidate AND immediately re-read, notifying every subscriber.
 *
 * Used by the live signal (WS 'pending-actions-updated', which the server also
 * broadcasts on raw insert/dismiss/execute) and after the review dialog consumes
 * a row. Unlike invalidateRawExecConfig this does not wait for a consumer to
 * mount — the sidebar badge must drop to zero on its own.
 */
export function refreshRawExecConfig(): void {
  invalidateRawExecConfig();
  ensureFresh(true);
}

async function doFetchConfig(): Promise<void> {
  try {
    const res = await (authenticatedFetch as (url: string) => Promise<Response>)(RAW_URL);
    if (!res.ok) {
      // 401/403 (no tier, disarmed, or blocked environment) → no button.
      publish(false);
      return;
    }
    const data = (await res.json()) as Record<string, unknown>;

    const mode = data.mode;
    const rawExecEnabled = data.rawExecEnabled;
    const blockedReasons = data.rawExecBlockedReasons;

    publish(
      rawExecEnabled === true &&
        (mode === 'raw' || mode === 'general') &&
        Array.isArray(blockedReasons) &&
        (blockedReasons as unknown[]).length === 0,
      // Not conditioned on the flags above: the server already withheld the rows
      // from a caller who may not read them. Re-gating here on a locally derived
      // boolean would only add a second, divergible copy of the same decision.
      parseCommands(data.commands),
    );
  } catch {
    // Network error or parse failure → fail closed.
    publish(false);
  } finally {
    pendingFetch = null;
    if (refetchQueued) {
      // A refresh landed mid-flight; the response we just published predates it.
      refetchQueued = false;
      ensureFresh(true);
    }
  }
}

function ensureFresh(force = false): void {
  if (pendingFetch) {
    // Cannot cancel the in-flight read, so remember to redo it once it settles.
    if (force) refetchQueued = true;
    return;
  }
  if (!force && cachedPerm !== null && Date.now() - cacheTimestamp < CACHE_TTL_MS) return; // fresh
  pendingFetch = doFetchConfig();
}

// ── React hook ───────────────────────────────────────────────────────────────

type RawExecConfigResult = {
  canUseRaw: boolean;
  loading: boolean;
};

/**
 * Returns whether the current user may use the raw-exec "Execute" button.
 *
 * @param isAuthenticated - pass `!!user` from useAuth(). Only an anonymous caller
 *   short-circuits without a round-trip; the ROLE is deliberately not inspected
 *   here, because since ADR-072 (amended 2026-07-26) any role can hold the raw
 *   tier. Hardcoding an owner check client-side would hide the button from an
 *   admin the server actually authorises.
 */
export function useRawExecConfig(isAuthenticated: boolean): RawExecConfigResult {
  const [perm, setPerm] = useState<BoardPermission | null>(() =>
    // Seed from cache if already populated (avoids a render cycle on re-mount)
    cachedPerm,
  );

  useEffect(() => {
    if (!isAuthenticated) return;

    // Subscribe to future cache updates (e.g. first mount triggers fetch,
    // subsequent mounts get notified when the in-flight request resolves).
    subscribers.add(setPerm);
    ensureFresh();

    return () => {
      subscribers.delete(setPerm);
    };
  }, [isAuthenticated]);

  if (!isAuthenticated) return { canUseRaw: false, loading: false };
  if (perm === null) return { canUseRaw: false, loading: true };
  return { canUseRaw: perm.canUseRaw, loading: false };
}

// ── Queue view (B-247) ───────────────────────────────────────────────────────

type RawExecQueueResult = {
  /** Rows the SERVER decided this caller may read; [] for everyone else. */
  commands: readonly RawCommand[];
  canUseRaw: boolean;
  loading: boolean;
  /** Force a re-read (after a dismiss, or after the dialog consumes a row). */
  refresh: () => void;
};

/**
 * Returns the shared raw-command queue as the server scoped it to this caller.
 *
 * Deliberately free of WebSocket context so it can be used anywhere in the tree
 * (the settings nav renders outside a WebSocketProvider in tests). Liveness comes
 * from the single WS bridge in useServerActions, which calls
 * refreshRawExecConfig() on 'pending-actions-updated' and thereby pushes a new
 * snapshot to every subscriber of this module cache.
 */
export function useRawExecQueue(isAuthenticated: boolean): RawExecQueueResult {
  const [perm, setPerm] = useState<BoardPermission | null>(() => cachedPerm);

  useEffect(() => {
    if (!isAuthenticated) return;
    subscribers.add(setPerm);
    ensureFresh();
    return () => {
      subscribers.delete(setPerm);
    };
  }, [isAuthenticated]);

  const refresh = useCallback(() => {
    if (isAuthenticated) refreshRawExecConfig();
  }, [isAuthenticated]);

  if (!isAuthenticated) return { commands: NO_COMMANDS, canUseRaw: false, loading: false, refresh };
  if (perm === null) return { commands: NO_COMMANDS, canUseRaw: false, loading: true, refresh };
  return { commands: perm.commands, canUseRaw: perm.canUseRaw, loading: false, refresh };
}
