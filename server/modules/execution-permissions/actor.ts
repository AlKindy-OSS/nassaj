import type { UserRole } from '@/modules/database/index.js';

export type AuthenticatedLaunchActor = Readonly<{
  userId: number;
  principalId: string;
  authenticationKind: 'session' | 'ck' | 'verified_proxy' | 'internal_service';
  authenticationCredentialId?: string;
  authorizationGeneration: number;
  roles: readonly UserRole[];
  authenticatedAt: string;
}>;

export class LaunchActorError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'LaunchActorError';
  }
}

type PersistedPrincipal = Readonly<{
  id?: unknown;
  userId?: unknown;
  role?: unknown;
  status?: unknown;
  is_active?: unknown;
  authenticationKind?: unknown;
  authenticationCredentialId?: unknown;
  authorizationGeneration?: unknown;
}>;

const ROLES = new Set<UserRole>(['owner', 'admin', 'user']);
const KINDS = new Set(['session', 'ck', 'verified_proxy', 'internal_service']);

/**
 * Builds a frozen actor only from a canonical authentication result. Callers must pass the
 * persisted principal attached by auth middleware, never request body or arbitrary headers.
 */
export const createAuthenticatedLaunchActor = (
  principal: PersistedPrincipal | null | undefined,
  authenticatedAt = new Date().toISOString(),
): AuthenticatedLaunchActor => {
  if (principal?.authenticationKind === 'platform_unverified') {
    throw new LaunchActorError('PLATFORM_ACTOR_UNVERIFIED');
  }
  if (!principal) {
    throw new LaunchActorError('ACTOR_ID_INVALID');
  }
  const rawId = principal?.id ?? principal?.userId;
  const userId = typeof rawId === 'string' && /^\d+$/u.test(rawId) ? Number(rawId) : rawId;
  if (!Number.isSafeInteger(userId) || Number(userId) <= 0) {
    throw new LaunchActorError('ACTOR_ID_INVALID');
  }
  if (!KINDS.has(String(principal?.authenticationKind))) {
    throw new LaunchActorError('ACTOR_AUTHENTICATION_KIND_INVALID');
  }
  if (!ROLES.has(principal?.role as UserRole)) {
    throw new LaunchActorError('ACTOR_ROLE_INVALID');
  }
  if (principal?.status !== undefined && principal.status !== 'active') {
    throw new LaunchActorError('ACTOR_INACTIVE');
  }
  if (principal?.is_active !== undefined && principal.is_active !== 1
    && principal.is_active !== true) {
    throw new LaunchActorError('ACTOR_INACTIVE');
  }
  if (!Number.isSafeInteger(principal?.authorizationGeneration)
    || Number(principal?.authorizationGeneration) <= 0) {
    throw new LaunchActorError('ACTOR_AUTHORIZATION_GENERATION_INVALID');
  }
  if (Number.isNaN(Date.parse(authenticatedAt)) || new Date(authenticatedAt).toISOString() !== authenticatedAt) {
    throw new LaunchActorError('ACTOR_AUTHENTICATED_AT_INVALID');
  }
  const authenticationKind = principal.authenticationKind as AuthenticatedLaunchActor['authenticationKind'];
  const credential = principal.authenticationCredentialId;
  if (credential !== undefined && (typeof credential !== 'string' || !credential
    || credential.length > 256 || /[\u0000-\u001f\u007f]/u.test(credential))) {
    throw new LaunchActorError('ACTOR_CREDENTIAL_ID_INVALID');
  }
  if (authenticationKind === 'ck' && credential === undefined) {
    throw new LaunchActorError('ACTOR_CREDENTIAL_ID_REQUIRED');
  }
  return Object.freeze({
    userId: Number(userId),
    principalId: `user:${Number(userId)}`,
    authenticationKind,
    ...(credential === undefined ? {} : { authenticationCredentialId: credential }),
    authorizationGeneration: Number(principal.authorizationGeneration),
    roles: Object.freeze([principal.role as UserRole]),
    authenticatedAt,
  });
};
