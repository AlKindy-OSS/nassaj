import crypto from 'node:crypto';

import type { PermissionExecutionHandle } from './execution-gateway.service.js';
import { createAuthenticatedLaunchActor } from './actor.js';
import { authorizeRuntimeProviderExecution } from './runtime-gateway.js';
import type { LaunchPurpose } from './types.js';

type RuntimeUserEffect = Readonly<{
  authenticatedPrincipal?: unknown;
  provider: string;
  body?: string;
  engine: string;
  entrypoint: string;
  purpose: LaunchPurpose;
  /**
   * Omitted = 'external' (safe). 'local' is declared only at reviewed sites: host-child
   * spawns (T-1593), and the in-process read helper (T-1910, ADR-198), whose effect is one
   * idempotent GET to an allowlisted origin with redirects refused, a bounded deadline, no
   * writes and no credential refresh, started only under the in-process read capability.
   */
  effectFootprint?: 'local' | 'external';
  sessionId?: string | null;
  projectId: string;
  workspacePath: string;
}>;

/** Issues one execution handle from a canonical authentication result, never a user-id surrogate. */
export const authorizeRuntimeUserProviderEffect = (
  input: RuntimeUserEffect,
): PermissionExecutionHandle => {
  if (!input.authenticatedPrincipal) {
    throw new Error('RUNTIME_EFFECT_AUTHENTICATED_PRINCIPAL_REQUIRED');
  }
  const actor = createAuthenticatedLaunchActor(input.authenticatedPrincipal as never);
  const permission = authorizeRuntimeProviderExecution({
    ...(input.authenticatedPrincipal as Record<string, unknown>),
  }, {
    launchId: `${input.entrypoint}:${crypto.randomUUID()}`,
    principalId: actor.principalId,
    sessionId: input.sessionId ?? null,
    projectId: input.projectId,
    workspacePath: input.workspacePath,
    provider: input.provider,
    body: input.body ?? input.provider,
    engine: input.engine,
    entrypoint: input.entrypoint,
    purpose: input.purpose,
    effectFootprint: input.effectFootprint ?? 'external',
  });
  if (permission.kind === 'denied') {
    throw new Error(`RUNTIME_EFFECT_PERMISSION_DENIED:${permission.reasonCodes.join(',')}`);
  }
  return permission.execution;
};
