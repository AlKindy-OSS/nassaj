import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { IS_PLATFORM } from '../../../constants/config';
import { shareLoginPath } from '../../document-sharing/share-navigation';
import { api, setCookieSessionKind } from '../../../utils/api';
import { AUTH_ERROR_MESSAGES, AUTH_TOKEN_STORAGE_KEY } from '../constants';
import { exchangeOidcCode, fetchOidcIdentity } from '../oidc';
import type {
  AuthContextValue,
  AuthProviderProps,
  AuthSessionPayload,
  AuthStatusPayload,
  AuthUser,
  AuthUserPayload,
  OnboardingStatusPayload,
} from '../types';
import { parseJsonSafely, resolveApiErrorMessage } from '../utils';
import {
  hydratePreferencesFromServer,
  setPreferenceIdentityAuthenticated,
} from '../../../preferences/preferencesSync';
import { clearOutbox, setOutboxUser } from '../../chat/utils/messageOutbox';
import { useOutboxDurableRecovery } from '../../chat/hooks/useOutboxDurableRecovery';
import {
  beginIdentityTransition,
  cancelIdentityTransition,
  commitIdentityTransition,
  enterPasswordChangeOnlyMode,
  exitPasswordChangeOnlyMode,
  getIdentityBarrierSnapshot,
  isCurrentIdentityReconciliation,
  lockIdentityBarrier,
  reconcileRevokedIdentity,
  stabilizeIdentityBarrier,
  subscribeIdentityBarrier,
} from '../accountIdentityBarrier';
import { purgeAccountIdentityState } from '../accountIdentityIsolation';
import {
  AccountWalletError,
  finishWalletIdentityTransition,
  isAccountWallet,
  mutateAccountWallet,
  readAccountWallet,
  type AccountWallet,
} from '../accountWalletClient';
import {
  authUserKey,
  clearIdentityCompletionReceipt,
  readIdentityCompletionReceipt,
  receiptMatchesIdentity,
  writeIdentityCompletionReceipt,
} from '../accountIdentityReceipt';

const AuthContext = createContext<AuthContextValue | null>(null);

const readStoredToken = (): string | null => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

const persistToken = (token: string) => {
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
};

const clearStoredToken = () => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
};

// How often the foreground sweep re-checks the token's age (B-131 gap أ). The
// heavy lifting is the event-driven checks (focus / visibility / online); this
// interval is only a floor for a tab left open and focused for a long time. The
// check is cheap — a local decode — and a network call fires only past half-life.
// Exported so the timer test drives the exact production value (no drift).
export const PROACTIVE_REFRESH_INTERVAL_MS = 4 * 60 * 1000;

type TokenTimestamps = { exp?: number; iat?: number };
type AuthCheckOperation = Readonly<{
  epoch: number;
  barrierVersion: string;
  controller: AbortController;
}>;

/**
 * Decode a JWT's payload segment WITHOUT verifying the signature — used only to
 * read the non-secret `exp`/`iat` claims so the client can refresh proactively
 * before expiry. base64url → bytes → UTF-8 so a non-ASCII `username` claim can't
 * corrupt the parse. Returns null on any malformed input (never throws).
 */
const decodeTokenTimestamps = (token: string): TokenTimestamps | null => {
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4);
    const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' ? (parsed as TokenTimestamps) : null;
  } catch {
    return null;
  }
};

/** True once the token is past the midpoint of its lifetime — mirrors the
 * server's own auto-refresh trigger (server/middleware/auth.js). */
const isPastHalfLife = (claims: TokenTimestamps): boolean => {
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') return false;
  const nowSec = Date.now() / 1000;
  const midpoint = claims.iat + (claims.exp - claims.iat) / 2;
  return nowSec > midpoint;
};

/** True when the token is already expired (or carries no exp). Refreshing an
 * expired token just 401s, so proactive refresh skips it and leaves recovery to
 * the 401 path. */
const isTokenExpired = (claims: TokenTimestamps): boolean => {
  if (typeof claims.exp !== 'number') return true;
  return Date.now() / 1000 >= claims.exp;
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

/**
 * Soft read of the auth context: `null` outside a provider instead of throwing.
 * For components that only *decorate* with identity (e.g. the sidebar row's
 * participant avatars) and must stay mountable in isolation — a missing
 * provider degrades that decoration, it does not break the component.
 */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: AuthProviderProps) {
  const identityBarrier = useSyncExternalStore(
    subscribeIdentityBarrier,
    getIdentityBarrierSnapshot,
    getIdentityBarrierSnapshot,
  );
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Server-counted: does this deployment hold more than one active account?
  // Defaults to false so a server that predates the field (or a failed read)
  // behaves like a single-user install — attribution UI stays hidden rather
  // than appearing with a lone avatar on every row.
  const [isMultiUser, setIsMultiUser] = useState(false);
  const [deviceAccountSessionsEnabled, setDeviceAccountSessionsEnabled] = useState(false);
  const mustChangePassword = Boolean(user?.mustChangePassword);
  // Prevent checkAuthStatus from re-running immediately after a successful login/register/invite.
  // Without this flag, changing `token` state causes checkAuthStatus to be rebuilt
  // (it closes over `token`), which re-triggers the useEffect and may call clearSession()
  // before the new token is settled in all async paths.
  const skipNextAuthCheck = useRef(false);
  const reconcilingIdentityVersion = useRef<string | null>(null);
  const authCheckEpoch = useRef(0);
  const authCheckController = useRef<AbortController | null>(null);

  const invalidateAuthCheck = useCallback(() => {
    authCheckEpoch.current += 1;
    authCheckController.current?.abort('identity_changed');
    authCheckController.current = null;
  }, []);

  const beginAuthCheck = useCallback((): AuthCheckOperation | null => {
    const barrier = getIdentityBarrierSnapshot();
    if (barrier.phase !== 'stable') return null;
    invalidateAuthCheck();
    const controller = new AbortController();
    authCheckController.current = controller;
    return { epoch: authCheckEpoch.current, barrierVersion: barrier.version, controller };
  }, [invalidateAuthCheck]);

  const isCurrentAuthCheck = useCallback((operation: AuthCheckOperation): boolean => {
    const barrier = getIdentityBarrierSnapshot();
    return authCheckEpoch.current === operation.epoch
      && authCheckController.current === operation.controller
      && !operation.controller.signal.aborted
      && barrier.phase === 'stable'
      && barrier.version === operation.barrierVersion;
  }, []);

  // Abort at the barrier notification itself, rather than waiting for React's
  // next effect pass. A mocked or already-buffered response may ignore abort,
  // so every continuation also checks the epoch + barrier version before it
  // commits state.
  useEffect(() => subscribeIdentityBarrier(() => {
    if (getIdentityBarrierSnapshot().phase !== 'stable') invalidateAuthCheck();
  }), [invalidateAuthCheck]);

  const setSession = useCallback((nextUser: AuthUser, nextToken: string) => {
    setCookieSessionKind('none');
    setPreferenceIdentityAuthenticated(true);
    setUser(nextUser);
    setToken(nextToken);
    persistToken(nextToken);
  }, []);

  const setDeviceSession = useCallback((nextUser: AuthUser, limited = false) => {
    setCookieSessionKind(limited ? 'limited' : 'device');
    setPreferenceIdentityAuthenticated(true);
    setUser(nextUser);
    setToken(null);
    clearStoredToken();
  }, []);

  const clearSession = useCallback(() => {
    setCookieSessionKind('none');
    setPreferenceIdentityAuthenticated(false);
    setUser(null);
    setToken(null);
    clearStoredToken();
    // T-1295 (فيتو الخصوصية): الخروج يمسح صندوق الصادر ومعه صور الرسائل غير
    // المُرسَلة. الخروج كان يزيل التوكن وحده، و`localStorage`/IndexedDB مقيَّدان
    // بالأصل (origin) لا بالحساب — فصندوقٌ متروك يعني كلامَ عضوٍ ظاهراً لعضو
    // بعده على المتصفّح نفسه، ونسّاج يُفترض فيه أعضاء لا يثق بعضهم ببعض.
    clearOutbox();
  }, []);

  // Compare-and-clear eviction (B-131 "vortex killer"). An involuntary logout
  // path (a 401, a mount-time auth check) knows WHICH token was rejected. Before
  // wiping the session, check what is ACTUALLY in localStorage now:
  //   - a DIFFERENT (newer) token is present → a parallel tab or our own
  //     proactive refresh rotated it mid-flight. Adopt it and KEEP the session
  //     instead of logging the user out on a freshly-minted valid token (the
  //     observed 313 no_token calls / 5 min: a dead tab evicting a live one).
  //   - the rejected token is still the current one (or nothing is stored) →
  //     a genuine rejection: clear React state + localStorage.
  // Returns true when it actually evicted, false when it adopted a newer token.
  const evictIfTokenStale = useCallback((rejectedToken: string | null): boolean => {
    const stored = readStoredToken();
    if (stored && rejectedToken && stored !== rejectedToken) {
      // Adopt the newer token WITHOUT rewriting localStorage (it already holds
      // it). The [token]-keyed WebSocket effect redials on this state change.
      setToken((current) => (current === stored ? current : stored));
      return false;
    }
    setUser(null);
    setToken(null);
    clearStoredToken();
    return true;
  }, []);

  // Proactive refresh trigger (B-131 gap أ). Reads the FRESHEST token from
  // localStorage (never a stale React closure), and — only when it is valid and
  // past half-life — asks api.js for a fresh one. Single-flight in api.js
  // coalesces the timer + focus/visibility/online triggers into ONE request; the
  // new token flows back via `auth:token-refreshed` (adopted by the effect
  // below). An already-expired token is left to the 401 path (refresh would just
  // fail). Stable (no deps) so the effect that wires the triggers never churns.
  const maybeRefreshToken = useCallback(() => {
    if (IS_PLATFORM) return;
    const current = readStoredToken();
    if (!current) return;
    const claims = decodeTokenTimestamps(current);
    if (!claims) return;
    if (isTokenExpired(claims)) return;
    if (!isPastHalfLife(claims)) return;
    void api.auth.refresh();
  }, []);

  // Re-fetch the authoritative identity after sign-in. The login/invite
  // responses carry a trimmed user object (id/username/role) that omits
  // `mustChangePassword`; /api/auth/user returns the full row so the forced
  // password-change gate (F-2) can engage immediately after sign-in.
  const hydrateUserIdentity = useCallback(async () => {
    try {
      const response = await api.auth.user();
      if (!response.ok) {
        return;
      }
      const payload = await parseJsonSafely<AuthUserPayload>(response);
      if (payload?.user) {
        setUser(payload.user);
      }
      setIsMultiUser(Boolean(payload?.isMultiUser));
    } catch (caughtError) {
      console.error('Failed to hydrate user identity:', caughtError);
    }
  }, []);

  // Pull the account's synced UI preferences and apply them live (the account
  // is authoritative — decision 2), or seed the account from this device on a
  // first sign-in (decision 3). Never throws: a missing route / network error
  // degrades silently to localStorage (the route only goes live after the
  // server restart). Initial sign-in can hydrate in the background; identity
  // transitions await it while their privacy barrier remains on screen.
  const hydratePreferences = useCallback(async () => {
    try {
      return await hydratePreferencesFromServer();
    } catch (caughtError) {
      console.error('Failed to hydrate UI preferences:', caughtError);
      return { status: 'unavailable' as const };
    }
  }, []);

  const checkOnboardingStatus = useCallback(async () => {
    try {
      const response = await api.user.onboardingStatus();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<OnboardingStatusPayload>(response);
      setHasCompletedOnboarding(Boolean(payload?.hasCompletedOnboarding));
    } catch (caughtError) {
      console.error('Error checking onboarding status:', caughtError);
      // Fail open to avoid blocking access on transient onboarding status errors.
      setHasCompletedOnboarding(true);
    }
  }, []);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  const checkAuthStatus = useCallback(async () => {
    const operation = beginAuthCheck();
    if (!operation) return;

    // Skip the re-check that fires immediately after login/register/invite sets a new token.
    // The login flow already validates the session via the /login response itself.
    if (skipNextAuthCheck.current) {
      skipNextAuthCheck.current = false;
      if (isCurrentAuthCheck(operation)) setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const statusResponse = await api.auth.status({ signal: operation.controller.signal });
      const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);
      if (!isCurrentAuthCheck(operation)) return;
      setDeviceAccountSessionsEnabled(statusPayload?.deviceAccountSessionsEnabled === true);

      if (statusPayload?.needsSetup) {
        setNeedsSetup(true);
        return;
      }

      setNeedsSetup(false);

      const userResponse = await api.auth.user({ signal: operation.controller.signal });
      if (!isCurrentAuthCheck(operation)) return;
      if (!userResponse.ok) {
        // Only clear the session on definitive auth rejection (401/403).
        // Do not clear on transient errors (5xx, network) to avoid logout loops.
        // Compare-and-clear against the token we validated: a parallel tab may
        // have written a newer one while this check was in flight (B-131).
        const status = userResponse.status;
        if (status === 401 || status === 403) {
          if (token) evictIfTokenStale(token);
        } else {
          console.error('[Auth] Transient error checking auth status, keeping session:', status);
          setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
        }
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (!isCurrentAuthCheck(operation)) return;
      if (!userPayload?.user) {
        if (token) clearSession();
        return;
      }

      setUser(userPayload.user);
      setCookieSessionKind(token ? 'none' : 'device');
      setPreferenceIdentityAuthenticated(true);
      setIsMultiUser(Boolean(userPayload.isMultiUser));
      try {
        if (statusPayload?.deviceAccountSessionsEnabled !== true) throw new Error('wallet_disabled');
        const wallet = await readAccountWallet(operation.controller.signal);
        if (isCurrentAuthCheck(operation)) {
          writeIdentityCompletionReceipt(operation.barrierVersion, wallet, userPayload.user);
        }
      } catch {
        // Legacy/single-account deployments have no wallet. Absence of a
        // receipt only makes a later wallet event take the full safe path.
      }
      if (!isCurrentAuthCheck(operation)) return;
      await checkOnboardingStatus();
      if (!isCurrentAuthCheck(operation)) return;
      hydratePreferences();
    } catch (caughtError) {
      if (!isCurrentAuthCheck(operation)) return;
      console.error('[Auth] Auth status check failed:', caughtError);
      // Network error — do not clear the session, let the user retry.
      setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
    } finally {
      if (isCurrentAuthCheck(operation)) {
        authCheckController.current = null;
        setIsLoading(false);
      }
    }
  }, [beginAuthCheck, checkOnboardingStatus, clearSession, evictIfTokenStale,
    hydratePreferences, isCurrentAuthCheck, token]);

  // Listen for 401 responses dispatched by authenticatedFetch (api.js). When
  // any endpoint rejects the token we clear the local session and redirect to
  // the login page so the user is never left in a broken "logged-in" state.
  useEffect(() => {
    if (IS_PLATFORM) return;

    const handleUnauthorized = (event: Event) => {
      // The event carries the EXACT token authenticatedFetch had rejected.
      // Compare-and-clear (B-131): if a newer token has replaced it in the
      // meantime, adopt it and stay signed in instead of evicting.
      const rejectedToken = (event as CustomEvent<{ token?: string }>).detail?.token ?? null;
      if (!evictIfTokenStale(rejectedToken)) return;
      // Genuinely evicted. Defense-in-depth: never hard-redirect to /login if we
      // are already on it — a second `location.href` assignment would only force
      // a redundant full-page reload (and could re-arm a reload loop if a
      // pre-auth fetch still 401s on mount).
      if (window.location.pathname !== '/login') {
        window.location.href = shareLoginPath(window.location.pathname);
      }
    };

    window.addEventListener('auth:unauthorized', handleUnauthorized);
    return () => {
      window.removeEventListener('auth:unauthorized', handleUnauthorized);
    };
  }, [evictIfTokenStale]);

  // Adopt a server-rotated JWT into React state. `authenticatedFetch` (api.js)
  // and the file-upload XHR persist a refreshed token to localStorage and fire
  // `auth:token-refreshed` (see applyRefreshedToken). Without pulling it into
  // state, the token-keyed WebSocket effect keeps dialing with the pre-rotation
  // token until it expires — the B-131 "random logout". Mirrors the
  // `auth:unauthorized` channel above.
  useEffect(() => {
    if (IS_PLATFORM) return;

    const handleTokenRefreshed = (event: Event) => {
      const nextToken = (event as CustomEvent<{ token?: string }>).detail?.token;
      if (!nextToken) return;
      // Persist (idempotent — the primary guard in applyRefreshedToken already
      // wrote it) then adopt into state so the [token]-keyed WebSocket effect
      // reconnects with the fresh token.
      // Defense-in-depth (B-163): the updater is PURE (StrictMode may call it
      // twice) — return current when unchanged OR when nextToken is not strictly
      // newer by exp than the current state. Fail-open when either token is not
      // a well-formed JWT (decodeTokenTimestamps returns null → exp undefined).
      persistToken(nextToken);
      setToken((current) => {
        if (current === nextToken) return current;
        const nextExp = decodeTokenTimestamps(nextToken)?.exp;
        const currentExp = current ? decodeTokenTimestamps(current)?.exp : undefined;
        if (
          typeof nextExp === 'number' &&
          typeof currentExp === 'number' &&
          nextExp <= currentExp
        ) {
          return current; // not strictly newer: keep current state
        }
        return nextToken;
      });
    };

    window.addEventListener('auth:token-refreshed', handleTokenRefreshed);
    return () => {
      window.removeEventListener('auth:token-refreshed', handleTokenRefreshed);
    };
  }, []);

  // (أ) Proactive refresh — keep a live session from silently dying at the 7-day
  // TTL. Arms only while signed in and re-checks on a timer AND whenever the app
  // regains the foreground / network. The proven B-131 failure is a device
  // asleep (or a throttled PWA) for a full day where timers never fired and zero
  // refreshes happened; the focus/visibility/online triggers recover the moment
  // it wakes. maybeRefreshToken reads the freshest localStorage token and only
  // hits the network past half-life, so these triggers are cheap. Keyed on the
  // signed-in flag (not the token value) so a routine rotation does not re-arm.
  const isAuthenticated = Boolean(token);
  useEffect(() => {
    if (IS_PLATFORM || !isAuthenticated) return;

    const onVisibility = () => {
      if (document.visibilityState === 'visible') maybeRefreshToken();
    };

    const intervalId = window.setInterval(maybeRefreshToken, PROACTIVE_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', maybeRefreshToken);
    window.addEventListener('online', maybeRefreshToken);
    document.addEventListener('visibilitychange', onVisibility);

    // Catch a token already past half-life at arm time (app reopened after hours
    // asleep — the interval had no chance to fire yet).
    maybeRefreshToken();

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', maybeRefreshToken);
      window.removeEventListener('online', maybeRefreshToken);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isAuthenticated, maybeRefreshToken]);

  // Cross-tab sync (B-131, third proven mechanism). React to auth-token changes
  // made by OTHER tabs — the 'storage' event never fires in the writing tab, so
  // there is no echo/loop:
  //   - a new value → adopt it into React state WITHOUT rewriting localStorage
  //     (it is already there); the [token]-keyed WebSocket effect redials.
  //   - the key removed → another tab signed out → mirror a unified logout here.
  useEffect(() => {
    if (IS_PLATFORM) return;

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== AUTH_TOKEN_STORAGE_KEY) return;
      const nextToken = event.newValue;
      if (!nextToken) {
        clearSession();
        return;
      }
      setToken((current) => (current === nextToken ? current : nextToken));
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [clearSession]);

  useEffect(() => {
    if (IS_PLATFORM) {
      setUser({ username: 'platform-user' });
      setNeedsSetup(false);
      void checkOnboardingStatus().finally(() => {
        setIsLoading(false);
      });
      return;
    }

    void checkAuthStatus();
  }, [checkAuthStatus, checkOnboardingStatus]);

  useEffect(() => {
    if (identityBarrier.phase !== 'committed'
        || reconcilingIdentityVersion.current === identityBarrier.version) return;
    reconcilingIdentityVersion.current = identityBarrier.version;
    const reconciliationVersion = identityBarrier.version;
    const reconcile = async () => {
      try {
        // A persisted revocation resumes on reload without emitting a fresh
        // identity-changing event. Neutralize old account preferences before
        // any identity can become visible.
        setPreferenceIdentityAuthenticated(false);
        let wallet: AccountWallet;
        try {
          wallet = await readAccountWallet(undefined, true);
        } catch (caughtError) {
          const status = caughtError && typeof caughtError === 'object'
            && 'status' in caughtError ? caughtError.status : null;
          const expectedWalletAbsence = status === 401
            && ['logout', 'logout_all', 'identity_revoked'].includes(identityBarrier.reason);
          if (!expectedWalletAbsence) throw caughtError;

          // Removing the final slot makes /accounts itself unauthorized. In an
          // explicit logout transition that absence is the authoritative end
          // state, but local cleanup must still succeed before login is shown.
          clearIdentityCompletionReceipt();
          await purgeAccountIdentityState();
          if (!isCurrentIdentityReconciliation(reconciliationVersion)) return;
          clearSession(); setIsMultiUser(false);
          setNeedsSetup(false); setError(null); setIsLoading(false);
          stabilizeIdentityBarrier(reconciliationVersion);
          return;
        }
        if (!isCurrentIdentityReconciliation(reconciliationVersion)) return;
        const receipt = readIdentityCompletionReceipt();
        if (identityBarrier.reason === 'wallet_generation_changed'
            && receiptMatchesIdentity(receipt, wallet, user)) {
          setCookieSessionKind('device');
          setPreferenceIdentityAuthenticated(true);
          await hydratePreferences();
          if (!isCurrentIdentityReconciliation(reconciliationVersion)) return;
          writeIdentityCompletionReceipt(reconciliationVersion, wallet, user!);
          setError(null);
          setIsLoading(false);
          stabilizeIdentityBarrier(reconciliationVersion);
          return;
        }

        const mayReuseCompletedCleanup = receipt?.version === reconciliationVersion
          && receipt.activeSlotId === wallet.activeSlotId
          && receipt.walletGeneration === wallet.generation;
        if (!mayReuseCompletedCleanup) {
          clearIdentityCompletionReceipt();
          await purgeAccountIdentityState();
        }
        if (!isCurrentIdentityReconciliation(reconciliationVersion)) return;
        const response = await api.auth.userForIdentityReconciliation();
        if (!isCurrentIdentityReconciliation(reconciliationVersion)) return;
        if (response.status === 401) {
          if (mayReuseCompletedCleanup) await purgeAccountIdentityState();
          if (!isCurrentIdentityReconciliation(reconciliationVersion)) return;
          clearIdentityCompletionReceipt();
          clearSession(); setIsMultiUser(false);
          setError(null); setIsLoading(false);
          stabilizeIdentityBarrier(reconciliationVersion);
          return;
        }
        const payload = await parseJsonSafely<AuthUserPayload>(response);
        if (!isCurrentIdentityReconciliation(reconciliationVersion)) return;
        if (!response.ok || !payload?.user) throw new Error('identity_hydration_failed');
        if (mayReuseCompletedCleanup && receipt.userKey !== authUserKey(payload.user)) {
          clearIdentityCompletionReceipt();
          await purgeAccountIdentityState();
          if (!isCurrentIdentityReconciliation(reconciliationVersion)) return;
        }
        setCookieSessionKind('device');
        setPreferenceIdentityAuthenticated(true);
        setUser(payload.user); setToken(null); clearStoredToken();
        setIsMultiUser(Boolean(payload.isMultiUser));
        setError(null); setIsLoading(false);
        writeIdentityCompletionReceipt(reconciliationVersion, wallet, payload.user);
        await hydratePreferences();
        if (!isCurrentIdentityReconciliation(reconciliationVersion)) return;
        await checkOnboardingStatus();
        if (!isCurrentIdentityReconciliation(reconciliationVersion)) return;
        stabilizeIdentityBarrier(reconciliationVersion);
      } catch {
        if (isCurrentIdentityReconciliation(reconciliationVersion)) {
          lockIdentityBarrier(reconciliationVersion, 'identity_cleanup_or_hydration_failed');
        }
      }
    };
    void reconcile();
  }, [checkOnboardingStatus, clearSession, hydratePreferences, identityBarrier, user]);

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.login(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (response.ok && payload?.passwordChangeRequired && payload.user) {
          // This is a purpose-limited HttpOnly cookie, not a general session.
          // Remove any legacy bearer before rendering the forced-change gate.
          skipNextAuthCheck.current = true;
          clearIdentityCompletionReceipt();
          setDeviceSession({ ...payload.user, mustChangePassword: true }, true);
          enterPasswordChangeOnlyMode();
          setNeedsSetup(false);
          setIsLoading(false);
          return { success: true };
        }

        if (!response.ok || !payload?.user || (!payload.token && !payload.wallet)) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        // Prevent the token-change-driven useEffect from re-running checkAuthStatus
        // (which would call clearSession if any intermediate state is stale).
        skipNextAuthCheck.current = true;
        if (payload.token) setSession(payload.user, payload.token);
        else {
          setDeviceAccountSessionsEnabled(Boolean(payload.wallet));
          setDeviceSession(payload.user);
        }
        setNeedsSetup(false);
        await hydrateUserIdentity();
        await checkOnboardingStatus();
        hydratePreferences();
        return { success: true };
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, hydratePreferences, hydrateUserIdentity, setDeviceSession, setSession],
  );

  // Passkey sign-in (C-PK-1). The WebAuthn ceremony itself (options +
  // startAuthentication) lives in useWebAuthn; this only exchanges the
  // assertion for a session, then mirrors `login` step for step so the
  // mustChangePassword and onboarding gates engage identically.
  const loginWithPasskey = useCallback<AuthContextValue['loginWithPasskey']>(
    async (assertionResponse) => {
      try {
        setError(null);
        const response = await api.auth.webauthn.loginVerify(assertionResponse);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        // Same guard as `login`: prevent the token-change-driven useEffect from
        // re-running checkAuthStatus against a half-settled session.
        skipNextAuthCheck.current = true;
        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await hydrateUserIdentity();
        await checkOnboardingStatus();
        hydratePreferences();
        return { success: true };
      } catch (caughtError) {
        console.error('Passkey login error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, hydratePreferences, hydrateUserIdentity, setSession],
  );

  // SSO sign-in (B-728). The exchange answers only `{ token, userId }`, so the
  // identity is loaded with that token BEFORE anything is persisted; then the
  // same session steps as `login` run so the mustChangePassword and onboarding
  // gates engage identically.
  const loginWithOidcCode = useCallback<AuthContextValue['loginWithOidcCode']>(
    async (code) => {
      setError(null);
      const exchange = await exchangeOidcCode(code);
      if (!exchange.ok) {
        return { success: false, reason: exchange.reason };
      }
      const identity = await fetchOidcIdentity(exchange.token);
      if (!identity.ok) {
        return { success: false, reason: identity.reason };
      }

      skipNextAuthCheck.current = true;
      setSession(identity.user, exchange.token);
      setIsMultiUser(identity.isMultiUser);
      setNeedsSetup(false);
      await checkOnboardingStatus();
      hydratePreferences();
      return { success: true };
    },
    [checkOnboardingStatus, hydratePreferences, setSession],
  );

  const register = useCallback<AuthContextValue['register']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.register(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.registrationFailed);
          setError(message);
          return { success: false, error: message };
        }

        skipNextAuthCheck.current = true;
        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        hydratePreferences();
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, hydratePreferences, setSession],
  );

  const acceptInvite = useCallback<AuthContextValue['acceptInvite']>(
    async (inviteToken, username, password) => {
      try {
        setError(null);
        const response = await api.auth.acceptInvite(inviteToken, username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.inviteFailed);
          setError(message);
          return { success: false, error: message };
        }

        skipNextAuthCheck.current = true;
        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        hydratePreferences();
        return { success: true };
      } catch (caughtError) {
        console.error('Invite acceptance error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, hydratePreferences, setSession],
  );

  const changePassword = useCallback<AuthContextValue['changePassword']>(
    async (currentPassword, newPassword) => {
      const passwordChangeOnly = mustChangePassword
        && getIdentityBarrierSnapshot().phase === 'limited';
      try {
        setError(null);
        const response = await api.auth.changePassword(currentPassword, newPassword,
          passwordChangeOnly ? { __identityBypass: true } : undefined);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (response.ok && !payload) {
          if (passwordChangeOnly) {
            const version = getIdentityBarrierSnapshot().version;
            lockIdentityBarrier(version, 'password_change_outcome_unknown');
          }
          return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
        }

        if (response.ok && payload?.success === true
            && !payload.token && !payload.wallet && !passwordChangeOnly) {
          // A normal device session remains cookie-backed after rotation. No
          // bearer or replacement wallet is required in the body; reconcile
          // the authoritative wallet + user instead of reporting false failure.
          const transition = beginIdentityTransition('password_change');
          commitIdentityTransition(transition, 'password_change');
          return { success: true };
        }

        if (!response.ok || (!payload?.token && !payload?.wallet)) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.passwordChangeFailed);
          return { success: false, error: message };
        }

        if (payload.wallet) {
          const transition = beginIdentityTransition('password_change');
          commitIdentityTransition(transition, 'password_change');
          return { success: true };
        }

        // Persist the fresh token so this device stays signed in (server rotated
        // pwd_iat and would otherwise invalidate the old token), and clear the
        // forced-change gate locally — the server has already cleared it.
        setToken(payload.token!);
        persistToken(payload.token!);
        setUser((previous) =>
          previous ? { ...previous, mustChangePassword: false } : previous,
        );
        if (passwordChangeOnly) exitPasswordChangeOnlyMode();
        return { success: true };
      } catch (caughtError) {
        if (passwordChangeOnly && getIdentityBarrierSnapshot().phase === 'limited') {
          const version = getIdentityBarrierSnapshot().version;
          lockIdentityBarrier(version, 'password_change_outcome_unknown');
        }
        console.error('Password change error:', caughtError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [mustChangePassword],
  );

  const changeUsername = useCallback<AuthContextValue['changeUsername']>(
    async (username) => {
      try {
        setError(null);
        const response = await api.auth.changeUsername(username);
        const payload = await parseJsonSafely<AuthSessionPayload & { username?: string }>(response);

        if (!response.ok) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.usernameChangeFailed);
          return { success: false, error: message };
        }

        const nextUsername = payload?.username ?? username;
        setUser((previous) => (previous ? { ...previous, username: nextUsername } : previous));
        return { success: true };
      } catch (caughtError) {
        console.error('Username change error:', caughtError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [],
  );

  // Update the avatar on the in-context user after a successful upload. The
  // upload request itself lives in the profile UI; the context only owns the
  // canonical user object, so callers reflect the new URL here.
  const updateAvatar = useCallback<AuthContextValue['updateAvatar']>((avatarUrl) => {
    setUser((previous) => (previous ? { ...previous, avatarUrl } : previous));
  }, []);

  const logout = useCallback(() => {
    const tokenToInvalidate = token;
    if (tokenToInvalidate) {
      clearSession();
      void api.auth.logout().catch((caughtError: unknown) => {
        console.error('Logout endpoint error:', caughtError);
      });
      return;
    }

    if (!user || !deviceAccountSessionsEnabled) {
      clearSession();
      return;
    }

    const logoutDeviceIdentity = async () => {
      let wallet: AccountWallet;
      try {
        wallet = await readAccountWallet();
      } catch {
        reconcileRevokedIdentity();
        return;
      }
      const transition = beginIdentityTransition('logout');
      try {
        const next = await mutateAccountWallet<{ generation: number; activeSlotId: string | null }>(
          '/api/auth/logout', 'POST', 'logout', { expectedGeneration: wallet.generation },
          { identityBypass: true },
        );
        finishWalletIdentityTransition(transition, wallet.activeSlotId, next.activeSlotId, 'logout');
      } catch (caught) {
        if (caught instanceof AccountWalletError && (caught.status === 409 || caught.outcomeUnknown)) {
          try {
            const authoritative = isAccountWallet(caught.wallet)
              ? caught.wallet : await readAccountWallet(undefined, true);
            finishWalletIdentityTransition(
              transition, wallet.activeSlotId, authoritative.activeSlotId, 'logout',
            );
            return;
          } catch {
            lockIdentityBarrier(transition, 'logout_reconciliation_failed');
            return;
          }
        }
        // The state-changing request was not accepted; keep the verified identity.
        cancelIdentityTransition(transition);
      }
    };
    void logoutDeviceIdentity();
  }, [clearSession, deviceAccountSessionsEnabled, token, user]);

  // T-1295 — ربط صندوق الصادر بصاحبه.
  //
  // المفتاح يحمل `userId`، وتغيّرُ المستخدم يمسح صندوق من سبقه ومعه صوره. ولا
  // يُمسح شيء عند `null`: الحالة الأولى قبل أن يُحسم التوثيق `null` أيضاً،
  // ومسحُها هناك كان سيُتلف صندوق المستخدم نفسه عند كل إعادة تحميل. المسح عند
  // الخروج مسؤولية `clearSession` وحدها — وهي تعرف أنه خروجٌ فعليّ.
  const outboxIdentity = user?.id ?? user?.username ?? null;
  useEffect(() => {
    if (outboxIdentity === null || outboxIdentity === undefined) {
      return;
    }
    setOutboxUser(outboxIdentity);
  }, [outboxIdentity]);

  useOutboxDurableRecovery(outboxIdentity);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isLoading,
      needsSetup,
      hasCompletedOnboarding,
      mustChangePassword,
      isMultiUser,
      deviceAccountSessionsEnabled,
      error,
      login,
      loginWithPasskey,
      loginWithOidcCode,
      register,
      acceptInvite,
      changePassword,
      changeUsername,
      updateAvatar,
      logout,
      refreshOnboardingStatus,
    }),
    [
      acceptInvite,
      changePassword,
      changeUsername,
      updateAvatar,
      error,
      hasCompletedOnboarding,
      isLoading,
      isMultiUser,
      deviceAccountSessionsEnabled,
      login,
      loginWithPasskey,
      loginWithOidcCode,
      logout,
      mustChangePassword,
      needsSetup,
      refreshOnboardingStatus,
      register,
      token,
      user,
    ],
  );

  const arabic = document.documentElement.lang.startsWith('ar');
  const barrierScreen = (
    <div className="fixed inset-0 z-[1000] flex min-h-dvh items-center justify-center bg-background p-6 text-foreground" role={identityBarrier.phase === 'locked' ? 'alert' : 'status'} aria-live="assertive">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-xl">
        <h1 className="text-lg font-semibold">{identityBarrier.phase === 'locked' ? (arabic ? 'تعذر تأمين تبديل الحساب' : 'Account switch could not be secured') : (arabic ? 'جارٍ تأمين الحساب…' : 'Securing account…')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{identityBarrier.phase === 'locked' ? (arabic ? 'أُوقفت الطلبات والاتصالات لحماية بيانات الحساب. أعد تحميل الصفحة للمحاولة بأمان.' : 'Requests and realtime connections are stopped to protect account data. Reload to retry safely.') : (arabic ? 'لن تُعرض بيانات الحساب حتى يكتمل التنظيف والتحقق من الهوية.' : 'Account data stays hidden until cleanup and identity verification finish.')}</p>
      </div>
    </div>
  );

  return <AuthContext.Provider value={contextValue}>
    {identityBarrier.phase === 'committed' || identityBarrier.phase === 'locked'
      ? barrierScreen
      : <>{children}{identityBarrier.phase === 'changing' ? barrierScreen : null}</>}
  </AuthContext.Provider>;
}
