export type IdentityBarrierPhase = 'stable' | 'limited' | 'changing' | 'committed' | 'locked';

export type IdentityBarrierSnapshot = Readonly<{
  phase: IdentityBarrierPhase;
  version: string;
  reason: string;
}>;

const STORAGE_KEY = 'nassaj_identity_barrier_v1';
const CHANNEL_NAME = 'nassaj-identity-barrier';
const listeners = new Set<() => void>();
let requestController = new AbortController();
const ownedTransitions = new Set<string>();
const tabNonce = globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let localClock = Date.now();

const stableSnapshot = (): IdentityBarrierSnapshot => ({ phase: 'stable', version: '0:legacy', reason: '' });

function normalizeVersion(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return `${value.toString(36)}:legacy`;
  if (typeof value !== 'string' || value.length > 160 || !/^[0-9a-z]{1,16}:[0-9a-z-]{1,128}$/i.test(value)) return null;
  const clock = parseInt(value.split(':', 1)[0], 36);
  if (!Number.isSafeInteger(clock)) return null;
  return value;
}

function compareVersion(left: string, right: string): number {
  const [leftClock, leftNonce] = left.split(':', 2);
  const [rightClock, rightNonce] = right.split(':', 2);
  const clockOrder = parseInt(leftClock, 36) - parseInt(rightClock, 36);
  if (clockOrder !== 0) return clockOrder > 0 ? 1 : -1;
  return leftNonce < rightNonce ? -1 : leftNonce > rightNonce ? 1 : 0;
}

function normalizeSnapshot(value: unknown): IdentityBarrierSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<IdentityBarrierSnapshot>;
  if (!['stable', 'limited', 'changing', 'committed', 'locked'].includes(candidate.phase ?? '')) return null;
  const version = normalizeVersion(candidate.version);
  if (!version || (typeof candidate.reason === 'string' && candidate.reason.length > 128)) return null;
  return { phase: candidate.phase!, version, reason: typeof candidate.reason === 'string' ? candidate.reason : '' };
}

function parseSnapshot(raw: string | null): IdentityBarrierSnapshot {
  if (raw === null) return stableSnapshot();
  try {
    const parsed = raw.length <= 4_096 ? normalizeSnapshot(JSON.parse(raw)) : null;
    if (parsed) return parsed;
  } catch {
    // Fall through to a bounded recovery fence. A present-but-corrupt record
    // may represent an interrupted identity transition and must not fail open.
  }
  return {
    phase: 'committed',
    version: `${Date.now().toString(36)}:${tabNonce}`,
    reason: 'identity_reconciliation_retry',
  };
}

let snapshot = typeof localStorage === 'undefined' ? stableSnapshot() : parseSnapshot(localStorage.getItem(STORAGE_KEY));
if (snapshot.phase === 'changing' || snapshot.phase === 'locked') {
  snapshot = { ...snapshot, phase: 'committed', reason: 'identity_reconciliation_retry' };
}
if (snapshot.phase !== 'stable') requestController.abort('identity_barrier');

const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME);
(channel as (BroadcastChannel & { unref?: () => void }) | null)?.unref?.();

function phaseRank(phase: IdentityBarrierPhase): number {
  return phase === 'changing' ? 1 : phase === 'committed' ? 2 : phase === 'stable' ? 3
    : phase === 'limited' ? 4 : 5;
}

function shouldAccept(next: IdentityBarrierSnapshot): boolean {
  const versionOrder = compareVersion(next.version, snapshot.version);
  return versionOrder > 0
    || (versionOrder === 0 && phaseRank(next.phase) > phaseRank(snapshot.phase));
}

function applySnapshot(
  next: IdentityBarrierSnapshot,
  options: { publish: boolean; persist: boolean; force?: boolean },
): void {
  if (!options.force && !shouldAccept(next) && next !== snapshot) return;
  snapshot = next;
  if (next.phase === 'stable') requestController = new AbortController();
  else requestController.abort('identity_barrier');
  if (options.persist && typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  if (options.publish) channel?.postMessage(next);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('auth:identity-barrier', { detail: next }));
    if (next.phase !== 'stable') window.dispatchEvent(new Event('auth:identity-changing'));
  }
  listeners.forEach((listener) => listener());
}

/** Fence all general account traffic while only the password endpoint is allowed. */
export function enterPasswordChangeOnlyMode(): void {
  if (snapshot.phase !== 'stable') return;
  applySnapshot(
    { phase: 'limited', version: snapshot.version, reason: 'password_change_required' },
    { publish: false, persist: false, force: true },
  );
}

/** Release a purpose-limited session after a new normal session is established. */
export function exitPasswordChangeOnlyMode(): void {
  if (snapshot.phase !== 'limited') return;
  applySnapshot(
    { phase: 'stable', version: snapshot.version, reason: '' },
    { publish: false, persist: false, force: true },
  );
}

function nextVersion(): string {
  const [snapshotClock] = snapshot.version.split(':', 1);
  localClock = Math.max(localClock + 1, Date.now(), parseInt(snapshotClock, 36) + 1);
  return `${localClock.toString(36)}:${tabNonce}`;
}

/** Start a cross-tab identity fence before the first state-changing request. */
export function beginIdentityTransition(reason: string): string {
  const version = nextVersion();
  ownedTransitions.add(version);
  applySnapshot({ phase: 'changing', version, reason }, { publish: true, persist: true });
  return version;
}

/** Mark the server mutation authoritative; consumers must clean and rehydrate. */
export function commitIdentityTransition(version: string, reason: string): void {
  if (!ownedTransitions.delete(version) || snapshot.version !== version || snapshot.phase !== 'changing') return;
  applySnapshot({ phase: 'committed', version, reason }, { publish: true, persist: true });
}

/** Release a failed pre-commit mutation without accepting any new identity. */
export function cancelIdentityTransition(version: string): void {
  // This is the only stable state that crosses tabs: it cancels a transition
  // whose mutation was never committed. Receivers accept it only while they
  // are still in `changing`, so it can never unlock reconciliation or a lock.
  if (!ownedTransitions.delete(version) || snapshot.version !== version || snapshot.phase !== 'changing') return;
  applySnapshot({ phase: 'stable', version, reason: 'transition_cancelled' }, { publish: true, persist: true });
}

/** Permanently fail closed until a successful, explicit reconciliation. */
export function lockIdentityBarrier(version: string, reason: string): void {
  // Cleanup is tab-local. A slow/failed tab must fail closed without locking a
  // different tab that has already completed its own cleanup.
  applySnapshot({ phase: 'locked', version, reason }, { publish: false, persist: false });
}

/** Release the fence only after cleanup and authoritative identity hydration. */
export function stabilizeIdentityBarrier(version: string): void {
  // Stable means this tab completed cleanup and hydration. Never broadcast or
  // persist it: another tab may still be reconciling or may be fail-closed.
  if (snapshot.version !== version) return;
  applySnapshot({ phase: 'stable', version, reason: '' }, { publish: false, persist: false, force: true });
}

/** A 4401 revocation is authoritative and must never enter reconnect backoff. */
export function reconcileRevokedIdentity(): void {
  if (snapshot.phase !== 'stable') return;
  const version = beginIdentityTransition('identity_revoked');
  commitIdentityTransition(version, 'identity_revoked');
}

export function isIdentityRevocationClose(code: number): boolean {
  return code === 4401;
}

export function getIdentityBarrierSnapshot(): IdentityBarrierSnapshot {
  return snapshot;
}

/** True only while this tab is still reconciling the captured transition. */
export function isCurrentIdentityReconciliation(version: string): boolean {
  return snapshot.phase === 'committed' && snapshot.version === version;
}

export function subscribeIdentityBarrier(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Throws before a new ordinary request can observe a stale identity. */
export function identityRequestSignal(signal?: AbortSignal | null): AbortSignal {
  if (snapshot.phase !== 'stable') throw new DOMException('Identity transition in progress', 'AbortError');
  if (!signal) return requestController.signal;
  return AbortSignal.any([signal, requestController.signal]);
}

/** Apply a newer snapshot received from another tab; stale versions are ignored. */
export function receiveIdentityBarrierSnapshot(value: unknown): void {
  const next = normalizeSnapshot(value);
  if (!next) return;
  // A failed tab stays fail-closed. It may retry only after another tab proves
  // that a mutation committed (which starts a fresh local reconciliation),
  // never from a speculative `changing` or a cancellation.
  if (snapshot.phase === 'locked' && next.phase !== 'committed') return;
  if (next.phase === 'stable') {
    const cancelsLocalChanging = snapshot.phase === 'changing' && next.version === snapshot.version;
    const advancesIdleVersion = snapshot.phase === 'stable' && compareVersion(next.version, snapshot.version) > 0;
    if (!cancelsLocalChanging && !advancesIdleVersion) return;
  }
  if (shouldAccept(next)) applySnapshot(next, { publish: false, persist: false });
}

channel?.addEventListener('message', (event: MessageEvent<IdentityBarrierSnapshot>) => {
  receiveIdentityBarrierSnapshot(event.data);
});

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    const next = parseSnapshot(event.newValue);
    receiveIdentityBarrierSnapshot(next);
  });
}
