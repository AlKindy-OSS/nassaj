// ADR-H20 S6, client side: N1 auto sign-in (local path, one-time suppression
// after an explicit sign-out, 3-bounce loop guard), N4 end_session, D9-1
// silent re-check once per page load, and the return classification (the N2
// owner step-up was withdrawn 2026-10-18).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  session: vi.fn(),
  startRecheck: vi.fn(),
}));
vi.mock('../../utils/api', () => ({
  api: { auth: { oidc: apiMock } },
}));

import {
  admitAutoSignIn,
  consumeExplicitSignOut,
  decideAutoSignIn,
  EXPLICIT_SIGN_OUT_TTL_MS,
  followEndSession,
  LOOP_GUARD_WINDOW_MS,
  localLoginRequested,
  markExplicitSignOut,
  readSsoSessionReturn,
  RECHECK_COOLDOWN_MS,
  resetAutoSignInGuard,
  resetRecheckPageGuard,
  runSsoRecheckIfDue,
} from './ssoLinkedSession';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    map,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('N1 auto sign-in', () => {
  it('goes to the IdP only when the node setting is on and SSO is available', () => {
    const deps = { local: memoryStorage(), session: memoryStorage(), now: () => 1_000 };
    expect(decideAutoSignIn({ autoSignIn: false, loginAvailable: true, search: '' }, deps)).toBe('show_login');
    expect(decideAutoSignIn({ autoSignIn: true, loginAvailable: false, search: '' }, deps)).toBe('show_login');
    expect(decideAutoSignIn({ autoSignIn: true, loginAvailable: true, search: '' }, deps)).toBe('redirect');
  });

  it('/login?local=1 keeps the password sign-in (break-glass)', () => {
    expect(localLoginRequested('?local=1')).toBe(true);
    expect(localLoginRequested('?local=0')).toBe(false);
    const deps = { local: memoryStorage(), session: memoryStorage() };
    expect(decideAutoSignIn({ autoSignIn: true, loginAvailable: true, search: '?local=1' }, deps)).toBe('show_login');
  });

  it('no auto sign-in once right after an explicit sign-out, then it resumes', () => {
    const local = memoryStorage();
    const deps = { local, session: memoryStorage(), now: () => 50_000 };
    markExplicitSignOut({ local, now: () => 40_000 });
    expect(decideAutoSignIn({ autoSignIn: true, loginAvailable: true, search: '' }, deps)).toBe('show_login');
    expect(decideAutoSignIn({ autoSignIn: true, loginAvailable: true, search: '' }, deps)).toBe('redirect');
  });

  it('an old sign-out mark is spent without suppressing', () => {
    const local = memoryStorage();
    markExplicitSignOut({ local, now: () => 0 });
    expect(consumeExplicitSignOut({ local, now: () => EXPLICIT_SIGN_OUT_TTL_MS + 1 })).toBe(false);
    expect(local.map.size).toBe(0);
  });

  it('the loop guard fires at 3 bounces within 30 s and frees up after the window', () => {
    const session = memoryStorage();
    let now = 100_000;
    const clock = () => now;
    for (let i = 0; i < 3; i += 1) {
      expect(admitAutoSignIn({ session, now: clock })).toBe(true);
      now += 5_000;
    }
    expect(decideAutoSignIn({ autoSignIn: true, loginAvailable: true, search: '' },
      { local: memoryStorage(), session, now: clock })).toBe('loop_guard');
    now += LOOP_GUARD_WINDOW_MS;
    expect(admitAutoSignIn({ session, now: clock })).toBe(true);
    resetAutoSignInGuard({ session });
    expect(session.map.size).toBe(0);
  });

  it('corrupt storage never blocks and never throws', () => {
    const session = memoryStorage();
    session.setItem('nassaj:sso-auto-sign-in-bounces', '{not json');
    expect(admitAutoSignIn({ session, now: () => 1 })).toBe(true);
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
    expect(admitAutoSignIn({ session: throwing, now: () => 1 })).toBe(true);
    expect(consumeExplicitSignOut({ local: throwing })).toBe(false);
  });
});

describe('N4 end_session', () => {
  it('follows only an absolute https URL', () => {
    const assign = vi.fn();
    expect(followEndSession('https://id.example/oidc/v1/end_session?client_id=c', assign)).toBe(true);
    expect(assign).toHaveBeenCalledWith('https://id.example/oidc/v1/end_session?client_id=c');
    for (const bad of [undefined, '', 'javascript:alert(1)', 'http://id.example/end', '/relative']) {
      expect(followEndSession(bad, assign)).toBe(false);
    }
    expect(assign).toHaveBeenCalledTimes(1);
  });
});

describe('D9-1 silent re-check', () => {
  beforeEach(() => {
    resetRecheckPageGuard();
    apiMock.session.mockReset();
    apiMock.startRecheck.mockReset();
  });

  it('when due, starts prompt=none once per page load and records the attempt', async () => {
    apiMock.session.mockResolvedValue(json({ sso: true, recheckDue: true }));
    apiMock.startRecheck.mockResolvedValue(json({ authorizationUrl: 'https://id.example/authorize?prompt=none' }));
    const session = memoryStorage();
    const assign = vi.fn();
    expect(await runSsoRecheckIfDue({ session, now: () => 1_000, assign })).toBe(true);
    expect(assign).toHaveBeenCalledWith('https://id.example/authorize?prompt=none');
    expect(await runSsoRecheckIfDue({ session, now: () => 2_000, assign })).toBe(false);
    expect(apiMock.session).toHaveBeenCalledTimes(1);
  });

  it('not due, not SSO, a recent attempt in this tab, or a failure: no navigation', async () => {
    const assign = vi.fn();
    apiMock.session.mockResolvedValue(json({ sso: false }));
    expect(await runSsoRecheckIfDue({ session: memoryStorage(), assign })).toBe(false);

    resetRecheckPageGuard();
    apiMock.session.mockResolvedValue(json({ sso: true, recheckDue: true }));
    const session = memoryStorage();
    session.setItem('nassaj:sso-recheck-started-at', '1000');
    expect(await runSsoRecheckIfDue({ session, now: () => 1_000 + RECHECK_COOLDOWN_MS - 1, assign })).toBe(false);

    resetRecheckPageGuard();
    apiMock.startRecheck.mockResolvedValue(json({ code: 'recheck_not_applicable' }, 409));
    expect(await runSsoRecheckIfDue({ session: memoryStorage(), assign })).toBe(false);

    resetRecheckPageGuard();
    apiMock.session.mockRejectedValue(new Error('offline'));
    expect(await runSsoRecheckIfDue({ session: memoryStorage(), assign })).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('return classification', () => {
  it('reads the re-check outcomes; anything else (a retired owner_step_up included) is not ours', () => {
    expect(readSsoSessionReturn(new URLSearchParams('owner_step_up=ok'))).toBeNull();
    for (const outcome of ['ok', 'kept', 'signed_out'] as const) {
      expect(readSsoSessionReturn(new URLSearchParams(`oidc_recheck=${outcome}`))).toEqual({ kind: 'recheck', outcome });
    }
    expect(readSsoSessionReturn(new URLSearchParams('oidc_recheck=other'))).toBeNull();
    expect(readSsoSessionReturn(new URLSearchParams('oidc_code=x'))).toBeNull();
  });
});
