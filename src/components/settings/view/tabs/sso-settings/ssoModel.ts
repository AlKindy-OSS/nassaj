/**
 * Pure view model of the SSO settings tab (brief §4–§5, ADR-194 D1/D4/D5/D8).
 * Kept free of React so the state rules are tested directly.
 */
import { tenantValuesOf } from './ssoApi';
import type { SsoConfigView, SsoDraftForm, SsoStatus, SsoTestResult } from './ssoTypes';

export type HeaderState = 'off' | 'offByOwner' | 'active' | 'unavailable' | 'paused' | 'hostDisabled' | 'readyNotOn';

export const HEADER_TONE: Readonly<Record<HeaderState, 'neutral' | 'success' | 'warning' | 'danger'>> = {
  off: 'neutral', offByOwner: 'neutral', hostDisabled: 'neutral',
  active: 'success', unavailable: 'danger', paused: 'warning', readyNotOn: 'warning',
};

/** Brief §4.1: which badge and meaning line the status header shows. */
export function headerStateOf(status: SsoStatus): HeaderState {
  if (status.hostDisabled) return 'hostDisabled';
  if (status.ssoState === 'active') return 'active';
  if (status.ssoState === 'unavailable') return 'unavailable';
  if (status.ssoState === 'paused') return 'paused';
  if (status.disabledRecord) return 'offByOwner';
  if (status.active && !status.active.enabled) return 'readyNotOn';
  return 'off';
}

/** "Disable SSO" is hidden only where there is nothing to disable. */
export function canDisable(state: HeaderState): boolean {
  return state !== 'off' && state !== 'offByOwner' && state !== 'hostDisabled';
}

/** Non-owner members linked under `issuer`, or under any issuer when omitted. */
export function linkedCount(status: SsoStatus, issuer?: string | null): number {
  return status.identityCountsByIssuer
    .filter((row) => issuer == null || row.issuer === issuer)
    .reduce((sum, row) => sum + (Number.isInteger(row.linkedUsers) ? row.linkedUsers : 0), 0);
}

export type UnavailableFault = 'endpointChanged' | 'linksNoConfig' | 'configInvalid' | 'runtimeFault' | 'cannotUse';

/** Brief §7.4, derived from the fields the API actually returns. */
export function unavailableFaultOf(status: SsoStatus): UnavailableFault | null {
  if (status.ssoState !== 'unavailable' || status.hostDisabled) return null;
  const { active } = status;
  if (active?.runtimeFault === 'discovery_endpoint_changed') return 'endpointChanged';
  if (active?.runtimeFault) return 'runtimeFault';
  if (!active) return linkedCount(status) > 0 ? 'linksNoConfig' : 'cannotUse';
  if (active.invalidReason) return 'configInvalid';
  return 'cannotUse';
}

export type BannerId =
  | 'hostDisabled' | 'endpointChanged' | 'unavailable' | 'linksNoConfig' | 'paused'
  | 'originMismatch' | 'noBackchannel' | 'noAuthTime';

/** Brief §4.2, in priority order. */
export function bannersOf(status: SsoStatus): BannerId[] {
  const banners: BannerId[] = [];
  const fault = unavailableFaultOf(status);
  if (status.hostDisabled) banners.push('hostDisabled');
  if (fault === 'endpointChanged') banners.push('endpointChanged');
  else if (fault === 'linksNoConfig') banners.push('linksNoConfig');
  else if (fault) banners.push('unavailable');
  if (!status.hostDisabled && status.ssoState === 'paused') banners.push('paused');
  if (status.redirectOriginStatus === 'redirect_origin_mismatch') banners.push('originMismatch');
  if (status.ssoState === 'active' && status.active?.discoveryFlags?.backchannel_logout_supported === false) {
    banners.push('noBackchannel');
  }
  const flags = status.lastProofs.signIn?.shapeFlags;
  if (status.ssoState === 'active' && flags && flags.authTimeFresh === false) banners.push('noAuthTime');
  return banners;
}

/** A saved draft the live row does not carry yet. */
export function draftPending(status: SsoStatus): boolean {
  return Boolean(status.active && status.draft && status.draft.draftVersion !== status.active.draftVersion);
}

export type StepId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type StepView = {
  id: StepId;
  /** Step that must be finished first, when locked. */
  lockedBy: StepId | null;
  /** Locked for a reason other than an earlier step (paused before import). */
  lockedReason: 'import' | null;
  done: boolean;
  recheck: boolean;
};

const proofCurrent = (status: SsoStatus, kind: 'discovery' | 'signIn') => {
  const proof = status.lastProofs[kind];
  return Boolean(proof?.passed && proof.current);
};
const proofStale = (status: SsoStatus, kind: 'discovery' | 'signIn') => {
  const proof = status.lastProofs[kind];
  return Boolean(status.draft && proof?.passed && !proof.current);
};

/** True when the saved draft carries a role path and at least one rule. */
export function rolesDone(draft: SsoConfigView | null): boolean {
  return Boolean(draft && draft.roleClaimPath !== '' && draft.roleRules.length > 0);
}

/**
 * Brief §2 step table. Every draft save clears the pinned endpoints, so the
 * mapping steps unlock once a draft exists (not on a current discovery proof,
 * which each of their own saves would invalidate).
 */
export function stepsOf(status: SsoStatus, ackedOurValues: boolean): StepView[] {
  const origin = status.ourValues.originConfirmed;
  const hasDraft = status.draft !== null;
  const pausedBeforeImport = status.ssoState === 'paused' && !hasDraft;
  const discovery = proofCurrent(status, 'discovery');
  const signIn = discovery && proofCurrent(status, 'signIn');
  const roles = rolesDone(status.draft);
  const applied = Boolean(status.active && status.draft && status.active.draftVersion === status.draft.draftVersion);
  const view = (id: StepId, lockedBy: StepId | null, done: boolean, recheck = false): StepView => ({
    id, lockedBy: pausedBeforeImport && id > 0 ? null : lockedBy,
    lockedReason: pausedBeforeImport && id > 0 ? 'import' : null, done, recheck,
  });
  return [
    view(0, null, origin),
    view(1, origin ? null : 0, ackedOurValues || hasDraft),
    view(2, origin ? null : 0, discovery, proofStale(status, 'discovery')),
    view(3, !origin ? 0 : hasDraft ? null : 2, roles),
    view(4, !origin ? 0 : hasDraft ? (roles ? null : 3) : 2, roles),
    view(5, !origin ? 0 : hasDraft ? (roles ? null : 3) : 2, roles),
    // Steps 6–7 open once the mapping is saved; their buttons explain a missing proof.
    view(6, !origin ? 0 : !hasDraft ? 2 : roles ? null : 3, signIn, proofStale(status, 'signIn')),
    view(7, !origin ? 0 : !hasDraft ? 2 : roles ? null : 3, applied),
  ];
}

export function isLocked(step: StepView): boolean {
  return step.lockedBy !== null || step.lockedReason !== null;
}

/** Both apply proofs pass for the current draft version. */
export function proofsReady(status: SsoStatus): boolean {
  return proofCurrent(status, 'discovery') && proofCurrent(status, 'signIn');
}

export function discoveryCurrent(status: SsoStatus): boolean {
  return proofCurrent(status, 'discovery');
}

/** The step to open on load: the first unlocked step that is not done. */
export function defaultOpenStep(steps: StepView[]): StepId {
  const next = steps.find((step) => !isLocked(step) && (!step.done || step.recheck));
  return next?.id ?? 7;
}

export const EMPTY_FORM: SsoDraftForm = {
  issuer: '', clientId: '', clientAuth: 'none', clientSecret: '', clearClientSecret: false, extraScopes: '',
  roleClaimPath: '', roleRules: [], tenantMode: 'none', tenantClaimPath: '', tenantValuesText: '',
  jitEnabled: false, attestationMaxAgeHours: 12, allowPrivateNetwork: false, issuerPort: '',
};

/** Form values from the draft, else the live row, else empty. */
export function formFrom(config: SsoConfigView | null): SsoDraftForm {
  if (!config) return { ...EMPTY_FORM };
  return {
    issuer: config.issuer ?? '', clientId: config.clientId ?? '', clientAuth: config.clientAuth ?? 'none',
    clientSecret: '', clearClientSecret: false, extraScopes: config.extraScopes ?? '',
    roleClaimPath: config.roleClaimPath ?? '', roleRules: (config.roleRules ?? []).map((rule) => ({ ...rule })),
    tenantMode: config.tenantMode ?? 'none', tenantClaimPath: config.tenantClaimPath ?? '',
    tenantValuesText: (config.tenantValues ?? []).join('\n'), jitEnabled: Boolean(config.jitEnabled),
    attestationMaxAgeHours: config.attestationMaxAgeHours ?? 12,
    allowPrivateNetwork: Boolean(config.allowPrivateNetwork),
    issuerPort: config.issuerPort == null ? '' : String(config.issuerPort),
  };
}

/** I5: turning private-network reach on, or changing the explicit port, needs step-up. */
export function draftNeedsStepUp(saved: SsoConfigView | null, form: SsoDraftForm): boolean {
  const wasPrivate = Boolean(saved?.allowPrivateNetwork);
  const port = form.allowPrivateNetwork && form.issuerPort.trim() ? Number(form.issuerPort.trim()) : null;
  return (form.allowPrivateNetwork && !wasPrivate) || port !== (saved?.issuerPort ?? null);
}

/** ADR-194 D4 (I9): claims the person can edit themselves. */
export const USER_EDITABLE_CLAIMS: ReadonlySet<string> = new Set([
  'name', 'given_name', 'family_name', 'middle_name', 'nickname', 'preferred_username', 'profile',
  'picture', 'website', 'locale', 'zoneinfo', 'gender', 'birthdate', 'phone_number', 'address',
]);

function topSegment(path: string): string {
  const trimmed = path.trim();
  const bracket = /^\[\s*"([^"]*)"\s*\]/.exec(trimmed);
  if (bracket) return bracket[1];
  return trimmed.split('.')[0] ?? '';
}

/** I9: a role path, or a tenant path, the person could change themselves. `email` is a tenant-only path. */
export function claimPathUserEditable(path: string, use: 'role' | 'tenant'): boolean {
  if (!path.trim()) return false;
  const top = topSegment(path);
  if (USER_EDITABLE_CLAIMS.has(top)) return true;
  if (top === 'email') return use === 'role' || path.trim() !== 'email';
  return false;
}

/** D5/N6: an e-mail tenant path is an exact per-person list. */
export function isEmailTenantPath(form: SsoDraftForm): boolean {
  return form.tenantMode === 'claim' && form.tenantClaimPath.trim() === 'email';
}

/** Lines that cannot be a full e-mail address (no `@`, leading `@`, or a wildcard). */
export function invalidEmailLines(text: string): string[] {
  return tenantValuesOf(text).filter((line) => !line.includes('@') || line.startsWith('@') || line.includes('*'));
}

const GENERIC_ROLE_WORDS = new Set(['admin', 'member', 'user', 'viewer']);
const BROAD_ROLE_PATHS = new Set(['groups', 'roles']);

/** D4 collision warning: a generic value on a broad claim. */
export function roleCollisionRisk(form: SsoDraftForm): boolean {
  return BROAD_ROLE_PATHS.has(form.roleClaimPath.trim())
    && form.roleRules.some((rule) => GENERIC_ROLE_WORDS.has(rule.value.trim().toLowerCase()));
}

const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,64}$/;
const ALWAYS_SENT_SCOPES = new Set(['openid', 'profile', 'email']);

/** D3 grammar of extra scopes: ≤10 unique scope tokens, never repeating the fixed three. */
export function extraScopesValid(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized === '') return true;
  const tokens = normalized.split(' ');
  if (tokens.length > 10 || new Set(tokens).size !== tokens.length) return false;
  return tokens.every((token) => SCOPE_TOKEN.test(token) && !ALWAYS_SENT_SCOPES.has(token));
}

export const MAX_ROLE_RULES = 64;

export type RoleShape = 'list' | 'single' | 'grouped' | 'none' | null;

/** Brief §5 step 3: what the last test found at the role path. */
export function roleShapeOf(status: SsoStatus, result: SsoTestResult | null): RoleShape {
  if (status.lastProofs.signIn?.shapeFlags?.roleClaimObjectOfObjects) return 'grouped';
  if (result) {
    const value = result.roleClaimValue;
    if (!Array.isArray(value)) return 'none';
    return value.length === 1 ? 'single' : 'list';
  }
  return status.lastProofs.signIn ? null : 'none';
}

/** Whether a test account would sign in, from the one-time result. */
export function wouldSignIn(result: SsoTestResult): boolean {
  return result.mappedRole !== null && result.tenantOk && result.diagnostics.length === 0;
}
