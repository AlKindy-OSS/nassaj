import assert from 'node:assert/strict';
import test, { after, afterEach, mock } from 'node:test';

import { JSDOM } from 'jsdom';

const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'test';
const { createElement } = await import('react');

const dom = new JSDOM('', { url: 'https://wallet.example.test' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}
let purge: () => Promise<void> = async () => {};
let hydrate: () => Promise<Response> = async () => Response.json({ user: { id: 2, username: 'B' } });
let initialUser: () => Promise<Response> = async () => Response.json({ user: { id: 1, username: 'A' } });
let wallet = { generation: 1, activeSlotId: 'slot-a', accounts: [
  { slotId: 'slot-a', displayName: 'A', isActive: true, lastUsedAt: null },
] };
let loginResponse: () => Promise<Response> = async () => Response.json({}, { status: 401 });
let passwordResponse: () => Promise<Response> = async () => Response.json({}, { status: 400 });
let passwordOptions: unknown;
let walletEnabled = true;
let readWallet: () => Promise<typeof wallet> = async () => wallet;
let mutateWallet: () => Promise<{ generation: number; activeSlotId: string | null }> = async () => ({ generation: 2, activeSlotId: null });
let finishTransition: (version: string, previous: string | null, next: string | null, reason: string) => void = () => {};
let hydrateAccountPreferences: () => Promise<{ status: 'applied' | 'unavailable' }> = async () => ({ status: 'applied' });
class MockAccountWalletError extends Error {
  constructor(public status: number, public outcomeUnknown = false, public walletValue?: typeof wallet) { super('wallet_error'); }
  get wallet() { return this.walletValue; }
}
mock.module('../../../constants/config', { namedExports: { IS_PLATFORM: false } });
mock.module('../../../utils/api', { namedExports: { authenticatedFetch: async () => Response.json({}), setCookieSessionKind: () => {}, api: {
  auth: {
    status: async () => Response.json({ needsSetup: false, deviceAccountSessionsEnabled: walletEnabled }),
    user: () => initialUser(),
    userForIdentityReconciliation: () => hydrate(),
    login: () => loginResponse(),
    changePassword: (_current: string, _next: string, options: unknown) => {
      passwordOptions = options;
      return passwordResponse();
    },
  },
  user: { onboardingStatus: async () => Response.json({ hasCompletedOnboarding: true }) },
} } });
mock.module('../../../preferences/preferencesSync', { namedExports: {
  hydratePreferencesFromServer: () => hydrateAccountPreferences(),
  setPreferenceIdentityAuthenticated: () => {},
} });
mock.module('../../chat/hooks/useOutboxDurableRecovery', { namedExports: { useOutboxDurableRecovery: () => {} } });
mock.module('../accountIdentityIsolation', { namedExports: { purgeAccountIdentityState: () => purge() } });
mock.module('../accountWalletClient', { namedExports: {
  AccountWalletError: MockAccountWalletError,
  finishWalletIdentityTransition: (...args: [string, string | null, string | null, string]) => finishTransition(...args),
  isAccountWallet: (value: unknown) => Boolean(value && typeof value === 'object' && Array.isArray((value as typeof wallet).accounts)),
  mutateAccountWallet: () => mutateWallet(),
  readAccountWallet: () => readWallet(),
} });
mock.module('../../onboarding/view/Onboarding', { defaultExport: () => createElement('div', null, 'onboarding') });
mock.module('../view/AuthLoadingScreen', { defaultExport: () => createElement('div', null, 'loading') });
mock.module('../view/ForceChangePasswordForm', {
  defaultExport: () => createElement('form', null,
    createElement('input', { id: 'current-password', type: 'password' })),
});
mock.module('../view/LoginForm', { defaultExport: () => createElement('div', null, 'login') });
mock.module('../view/SetupForm', { defaultExport: () => createElement('div', null, 'setup') });

const { act, render, renderHook, cleanup } = await import('@testing-library/react');
const { AuthProvider, useAuth } = await import('./AuthContext');
const { default: ProtectedRoute } = await import('../view/ProtectedRoute');
const barrier = await import('../accountIdentityBarrier');
finishTransition = (version, _previous, _next, reason) => barrier.commitIdentityTransition(version, reason);

afterEach(() => {
  cleanup();
  purge = async () => {};
  hydrate = async () => Response.json({ user: { id: 2, username: 'B' } });
  initialUser = async () => Response.json({ user: { id: 1, username: 'A' } });
  wallet = { generation: 1, activeSlotId: 'slot-a', accounts: [
    { slotId: 'slot-a', displayName: 'A', isActive: true, lastUsedAt: null },
  ] };
  loginResponse = async () => Response.json({}, { status: 401 });
  passwordResponse = async () => Response.json({}, { status: 400 });
  passwordOptions = undefined;
  walletEnabled = true;
  readWallet = async () => wallet;
  mutateWallet = async () => ({ generation: 2, activeSlotId: null });
  hydrateAccountPreferences = async () => ({ status: 'applied' });
  const version = barrier.beginIdentityTransition('test_reset');
  barrier.cancelIdentityTransition(version);
  localStorage.clear(); sessionStorage.clear();
});
after(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  dom.window.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount() {
  const view = renderHook(() => useAuth(), { wrapper: ({ children }) => createElement(AuthProvider, null, children) });
  await act(async () => {});
  assert.equal(view.result.current.user?.username, 'A');
  return view;
}

test('server status is the only wallet UI capability source', async () => {
  walletEnabled = false;
  let walletReads = 0;
  readWallet = async () => { walletReads++; return wallet; };
  const view = await mount();
  assert.equal(view.result.current.deviceAccountSessionsEnabled, false);
  assert.equal(walletReads, 0);
});

test('device logout remains fenced until the HttpOnly slot is authoritatively gone', async () => {
  const view = await mount();
  mutateWallet = async () => {
    readWallet = async () => { throw { status: 401 }; };
    return { generation: 2, activeSlotId: null };
  };
  await act(async () => { view.result.current.logout(); });
  await act(async () => {});
  assert.equal(view.result.current.user, null);
  assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'stable');

  initialUser = async () => Response.json({}, { status: 401 });
  const reloaded = renderHook(() => useAuth(), { wrapper: ({ children }) => createElement(AuthProvider, null, children) });
  await act(async () => {});
  assert.equal(reloaded.result.current.user, null);
});

test('a persisted identity revocation accepts authoritative wallet 401 and restores login', async () => {
  let releaseFirstRead!: () => void;
  readWallet = () => new Promise((resolve) => { releaseFirstRead = () => resolve(wallet); });
  const first = await mount();
  await act(async () => { barrier.reconcileRevokedIdentity(); });
  assert.equal(barrier.getIdentityBarrierSnapshot().reason, 'identity_revoked');
  first.unmount();

  let purges = 0;
  purge = async () => { purges++; };
  readWallet = async () => { throw { status: 401, code: 'device_session_invalid' }; };
  initialUser = async () => Response.json({}, { status: 401 });
  const reloaded = render(createElement(AuthProvider, null,
    createElement(ProtectedRoute, null, createElement('div', null, 'private'))));
  await act(async () => {});
  assert.equal(purges, 1);
  assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'stable');
  assert.equal(reloaded.container.textContent, 'login');
  void releaseFirstRead;
});

test('identity barrier stays committed until account B preferences finish hydrating', async () => {
  let releasePreferences!: () => void;
  hydrateAccountPreferences = () => new Promise((resolve) => {
    releasePreferences = () => resolve({ status: 'applied' });
  });
  let currentAuth: ReturnType<typeof useAuth> | null = null;
  function AccountSurface() {
    currentAuth = useAuth();
    return createElement('div', { 'data-testid': 'account-surface' }, currentAuth.user?.username ?? 'none');
  }
  const view = render(createElement(AuthProvider, null, createElement(AccountSurface)));
  await act(async () => {});
  wallet = { generation: 2, activeSlotId: 'slot-b', accounts: [
    { slotId: 'slot-b', displayName: 'B', isActive: true, lastUsedAt: null },
  ] };
  hydrate = async () => Response.json({ user: { id: 2, username: 'B' } });
  await act(async () => {
    const version = barrier.beginIdentityTransition('switch');
    barrier.commitIdentityTransition(version, 'switch');
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'committed');
  assert.equal(view.queryByTestId('account-surface'), null, 'old account surface must be hidden');
  assert.match(view.container.textContent ?? '', /Securing account/);
  await act(async () => { releasePreferences(); });
  assert.equal(currentAuth!.user?.username, 'B');
  assert.equal(view.queryByTestId('account-surface')?.textContent, 'B');
  assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'stable');
});

for (const delayedPhase of ['cleanup', 'headers', 'body']) {
  test(`stale reconciliation ${delayedPhase} cannot overwrite a newer account`, async () => {
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    purge = delayedPhase === 'cleanup' ? () => ++calls === 1 ? deferred : Promise.resolve() : async () => {};
    hydrate = async () => {
      if (delayedPhase !== 'cleanup' && ++calls === 1) {
        if (delayedPhase === 'headers') await deferred;
        return { ok: true, status: 200, json: async () => {
          if (delayedPhase === 'body') await deferred;
          return { user: { id: 2, username: 'B' } };
        } } as Response;
      }
      return Response.json({ user: { id: 3, username: 'C' } });
    };
    const view = await mount();
    await act(async () => {
      const version = barrier.beginIdentityTransition('switch');
      barrier.commitIdentityTransition(version, 'switch');
    });
    await act(async () => {
      const version = barrier.beginIdentityTransition('switch');
      barrier.commitIdentityTransition(version, 'switch');
    });
    assert.equal(view.result.current.user?.username, 'C');
    await act(async () => release());
    assert.equal(view.result.current.user?.username, 'C');
    assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'stable');
  });
}

test('generation-only add and inactive removal retain drafts and outbox in the mounted provider', async () => {
  let purges = 0;
  purge = async () => { purges++; };
  const view = await mount();
  localStorage.setItem('draft_input_private', 'unsent');
  localStorage.setItem('nassaj_outbox_user-a', 'queued');
  for (const action of ['add', 'remove']) {
    await act(async () => {
      const version = barrier.beginIdentityTransition(action);
      barrier.commitIdentityTransition(version, 'wallet_generation_changed');
    });
    assert.equal(view.result.current.user?.username, 'A');
    assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'stable');
    assert.equal(localStorage.getItem('draft_input_private'), 'unsent');
    assert.equal(localStorage.getItem('nassaj_outbox_user-a'), 'queued');
  }
  assert.equal(purges, 0);
});

test('cleanup rejection keeps the mounted provider locked and hides account children', async () => {
  purge = async () => { throw new Error('cache_delete_failed'); };
  await mount();
  await act(async () => {
    const version = barrier.beginIdentityTransition('switch');
    barrier.commitIdentityTransition(version, 'switch');
  });
  assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'locked');
  assert.throws(() => barrier.identityRequestSignal(), { name: 'AbortError' });
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /could not be secured/);
});

test('initial authentication body from A cannot overwrite a completed switch to B', async () => {
  let release!: (value: unknown) => void;
  const body = new Promise((resolve) => { release = resolve; });
  initialUser = async () => ({ ok: true, status: 200, json: () => body }) as Response;
  purge = async () => {};
  hydrate = async () => Response.json({ user: { id: 2, username: 'B' } });
  const view = renderHook(() => useAuth(), { wrapper: ({ children }) => createElement(AuthProvider, null, children) });
  await act(async () => {});
  await act(async () => {
    const version = barrier.beginIdentityTransition('switch');
    barrier.commitIdentityTransition(version, 'switch');
  });
  assert.equal(view.result.current.user?.username, 'B');
  await act(async () => release({ user: { id: 1, username: 'A' } }));
  assert.equal(view.result.current.user?.username, 'B');
});

for (const operation of ['add', 'remove']) {
test(`a slow A to B reconciliation cannot treat a later ${operation} event as local proof`, async () => {
  let release!: (value: unknown) => void;
  const delayedBody = new Promise((resolve) => { release = resolve; });
  let hydrationCalls = 0;
  hydrate = async () => ++hydrationCalls === 1
    ? ({ ok: true, status: 200, json: () => delayedBody }) as Response
    : Response.json({ user: { id: 2, username: 'B' } });
  const view = await mount();
  wallet = { generation: 2, activeSlotId: 'slot-b', accounts: [
    { slotId: 'slot-b', displayName: 'B', isActive: true, lastUsedAt: null },
  ] };
  await act(async () => {
    const version = barrier.beginIdentityTransition('switch');
    barrier.commitIdentityTransition(version, 'switch');
  });
  await act(async () => {
    wallet = { ...wallet, generation: 3 };
    const version = barrier.beginIdentityTransition(operation);
    barrier.commitIdentityTransition(version, 'wallet_generation_changed');
  });
  assert.equal(view.result.current.user?.username, 'B');
  await act(async () => release({ user: { id: 1, username: 'A' } }));
  assert.equal(view.result.current.user?.username, 'B');
  assert.ok(hydrationCalls >= 2);
});
}

test('limited password login exposes only the forced-change state and wallet success reconciles', async () => {
  initialUser = async () => Response.json({}, { status: 401 });
  loginResponse = async () => Response.json({
    success: true,
    passwordChangeRequired: true,
    user: { id: 2, username: 'B', role: 'user' },
  });
  const view = renderHook(() => useAuth(), {
    wrapper: ({ children }) => createElement(AuthProvider, null, children),
  });
  await act(async () => {});
  localStorage.setItem('auth-token', 'stale-jwt');
  let loginResult: Awaited<ReturnType<typeof view.result.current.login>> | undefined;
  await act(async () => { loginResult = await view.result.current.login('B', 'temporary'); });
  assert.deepEqual(loginResult, { success: true });
  assert.equal(view.result.current.user?.username, 'B');
  assert.equal(view.result.current.mustChangePassword, true);
  assert.equal(view.result.current.token, null);
  assert.equal(localStorage.getItem('auth-token'), null);
  assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'limited');
  assert.throws(() => barrier.identityRequestSignal(), { name: 'AbortError' });

  wallet = { generation: 4, activeSlotId: 'slot-b', accounts: [
    { slotId: 'slot-b', displayName: 'B', isActive: true, lastUsedAt: null },
  ] };
  hydrate = async () => Response.json({ user: { id: 2, username: 'B', mustChangePassword: false } });
  passwordResponse = async () => Response.json({ success: true, wallet });
  let changeResult: Awaited<ReturnType<typeof view.result.current.changePassword>> | undefined;
  await act(async () => {
    changeResult = await view.result.current.changePassword('temporary', 'permanent-password');
  });
  assert.deepEqual(changeResult, { success: true });
  assert.deepEqual(passwordOptions, { __identityBypass: true });
  assert.equal(view.result.current.user?.username, 'B');
  assert.equal(view.result.current.mustChangePassword, false);
  assert.equal(view.result.current.token, null);
  assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'stable');
});

test('protected route never renders the general app during a limited password session', async () => {
  initialUser = async () => Response.json({}, { status: 401 });
  loginResponse = async () => Response.json({
    success: true,
    passwordChangeRequired: true,
    user: { id: 2, username: 'B', role: 'user' },
  });
  let auth: ReturnType<typeof useAuth> | null = null;
  function GatedApplication() {
    auth = useAuth();
    return createElement(ProtectedRoute, null,
      createElement('div', { 'data-testid': 'general-app' }, 'general app'));
  }
  const view = render(createElement(AuthProvider, null, createElement(GatedApplication)));
  await act(async () => {});
  await act(async () => { await auth!.login('B', 'temporary'); });
  assert.equal(view.queryByTestId('general-app'), null);
  assert.ok(view.container.querySelector('#current-password'));

  wallet = { generation: 5, activeSlotId: 'slot-b', accounts: [
    { slotId: 'slot-b', displayName: 'B', isActive: true, lastUsedAt: null },
  ] };
  hydrate = async () => Response.json({ user: { id: 2, username: 'B', mustChangePassword: false } });
  passwordResponse = async () => Response.json({ success: true, wallet });
  await act(async () => { await auth!.changePassword('temporary', 'permanent-password'); });
  assert.ok(view.queryByTestId('general-app'));
});

test('a matching local completion receipt avoids deleting new work on reload reconciliation', async () => {
  let purges = 0;
  purge = async () => { purges++; };
  hydrate = async () => Response.json({ user: { id: 1, username: 'A' } });
  const view = await mount();
  const receipt = await import('../accountIdentityReceipt');
  let version = '';
  await act(async () => {
    version = barrier.beginIdentityTransition('switch');
    receipt.writeIdentityCompletionReceipt(version, wallet, view.result.current.user!);
  });
  localStorage.setItem('draft_input_after_switch', 'new draft');
  localStorage.setItem('nassaj_outbox_after_switch', 'new outbox entry');
  view.unmount();
  barrier.commitIdentityTransition(version, 'switch');
  const reloaded = renderHook(() => useAuth(), { wrapper: ({ children }) => createElement(AuthProvider, null, children) });
  await act(async () => {});
  assert.equal(purges, 0);
  assert.equal(localStorage.getItem('draft_input_after_switch'), 'new draft');
  assert.equal(localStorage.getItem('nassaj_outbox_after_switch'), 'new outbox entry');
  assert.equal(reloaded.result.current.user?.username, 'A');
});

for (const failure of ['transport', 'body']) {
  test(`uncertain limited password change ${failure} failure locks general requests`, async () => {
    initialUser = async () => Response.json({}, { status: 401 });
    loginResponse = async () => Response.json({ passwordChangeRequired: true, user: { id: 2, username: 'B' } });
    const view = renderHook(() => useAuth(), { wrapper: ({ children }) => createElement(AuthProvider, null, children) });
    await act(async () => {});
    await act(async () => { await view.result.current.login('B', 'temporary'); });
    assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'limited');
    passwordResponse = async () => {
      if (failure === 'transport') throw new TypeError('connection lost');
      return new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    let result: { success: boolean } | undefined;
    const consoleError = mock.method(console, 'error', () => {});
    try {
      await act(async () => { result = await view.result.current.changePassword('temporary', 'permanent-password'); });
      assert.equal(result?.success, false);
      assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'locked');
      assert.throws(() => barrier.identityRequestSignal(), { name: 'AbortError' });
    } finally { consoleError.mock.restore(); }
  });
}

test('real WebSocketProvider stays disconnected throughout limited login and connects after wallet reconciliation', async () => {
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const connections: string[] = [];
  class SocketBoundary {
    static OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    constructor(url: string) {
      connections.push(url);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    close() { this.readyState = 3; }
    send() {}
  }
  Object.defineProperty(globalThis, 'WebSocket', { value: SocketBoundary, configurable: true });
  try {
    const { WebSocketProvider } = await import('../../../contexts/WebSocketContext');
    initialUser = async () => Response.json({}, { status: 401 });
    loginResponse = async () => Response.json({ passwordChangeRequired: true, user: { id: 2, username: 'B' } });
    const view = renderHook(() => useAuth(), {
      wrapper: ({ children }) => createElement(AuthProvider, null, createElement(WebSocketProvider, null, children)),
    });
    await act(async () => {});
    await act(async () => { await view.result.current.login('B', 'temporary'); });
    assert.deepEqual(connections, []);
    wallet = { generation: 5, activeSlotId: 'slot-b', accounts: [
      { slotId: 'slot-b', displayName: 'B', isActive: true, lastUsedAt: null },
    ] };
    hydrate = async () => Response.json({ user: { id: 2, username: 'B', mustChangePassword: false } });
    passwordResponse = async () => Response.json({ success: true, wallet });
    await act(async () => { await view.result.current.changePassword('temporary', 'permanent-password'); });
    assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'stable');
    assert.equal(connections.length, 1);
    assert.doesNotMatch(connections[0], /token=/);
    view.unmount();
  } finally {
    if (originalWebSocket) Object.defineProperty(globalThis, 'WebSocket', originalWebSocket);
    else Reflect.deleteProperty(globalThis, 'WebSocket');
  }
});

test('logout of the final wallet slot treats authoritative 401 as a cleaned signed-out state', async () => {
  let purges = 0;
  purge = async () => {
    purges++;
    localStorage.removeItem('draft_input_before_logout');
  };
  const view = await mount();
  localStorage.setItem('draft_input_before_logout', 'private');
  readWallet = async () => { throw { status: 401, code: 'device_session_required' }; };
  await act(async () => {
    const version = barrier.beginIdentityTransition('logout');
    barrier.commitIdentityTransition(version, 'logout');
  });
  assert.equal(purges, 1);
  assert.equal(view.result.current.user, null);
  assert.equal(view.result.current.token, null);
  assert.equal(localStorage.getItem('draft_input_before_logout'), null);
  assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'stable');
  const receipt = await import('../accountIdentityReceipt');
  assert.equal(receipt.readIdentityCompletionReceipt(), null);
  view.unmount();
  initialUser = async () => Response.json({}, { status: 401 });
  const reloaded = render(createElement(AuthProvider, null,
    createElement(ProtectedRoute, null,
      createElement('div', { 'data-testid': 'private-app' }, 'private data'))));
  await act(async () => {});
  assert.equal(reloaded.queryByTestId('private-app'), null);
  assert.equal(reloaded.container.textContent, 'login');
  assert.equal(localStorage.getItem('draft_input_before_logout'), null);
  assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'stable');
});

test('wallet 401 never opens an unknown mutation or a failed logout cleanup', async () => {
  const view = await mount();
  readWallet = async () => { throw { status: 401, code: 'device_session_required' }; };
  await act(async () => {
    const version = barrier.beginIdentityTransition('switch');
    barrier.commitIdentityTransition(version, 'active_identity_conflict');
  });
  assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'locked');
  assert.equal(view.result.current.user?.username, 'A');

  await act(async () => {
    const resetVersion = barrier.beginIdentityTransition('test_reset');
    barrier.cancelIdentityTransition(resetVersion);
  });
  purge = async () => { throw new Error('cache_delete_failed'); };
  await act(async () => {
    const version = barrier.beginIdentityTransition('logout');
    barrier.commitIdentityTransition(version, 'logout');
  });
  assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'locked');
  assert.equal(view.result.current.user?.username, 'A');
});

test('normal device password success without token or wallet reconciles instead of failing', async () => {
  let purges = 0;
  purge = async () => { purges++; };
  hydrate = async () => Response.json({ user: { id: 1, username: 'A', mustChangePassword: false } });
  passwordResponse = async () => Response.json({ success: true });
  const view = await mount();
  let result: Awaited<ReturnType<typeof view.result.current.changePassword>> | undefined;
  await act(async () => {
    result = await view.result.current.changePassword('old-password', 'new-device-password');
  });
  assert.deepEqual(result, { success: true });
  assert.equal(passwordOptions, undefined);
  assert.equal(purges, 1);
  assert.equal(view.result.current.user?.username, 'A');
  assert.equal(view.result.current.error, null);
  assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'stable');
});
