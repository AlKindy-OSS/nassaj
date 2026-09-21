import type { LLMProvider } from '@/shared/types.js';

import { runPermissionExecutionAdapter } from './adapter.js';
import { createAuthenticatedLaunchActor } from './actor.js';
import { authorizeRuntimeUserProviderEffect } from './runtime-user-effect.js';

/** Runs one live provider catalog probe under its own actor, lease, and permit. */
export const runAuthorizedProviderCatalog = async <T>(
  provider: LLMProvider,
  userId: string | number | null | undefined,
  authenticatedPrincipal: unknown,
  probe: () => Promise<T>,
): Promise<T> => {
  const numericUserId = typeof userId === 'string' && /^\d+$/u.test(userId)
    ? Number(userId)
    : userId;
  if (!Number.isSafeInteger(numericUserId) || Number(numericUserId) <= 0) {
    throw new Error('CATALOG_ACTOR_REQUIRED');
  }
  const actor = createAuthenticatedLaunchActor(authenticatedPrincipal as never);
  if (actor.userId !== Number(numericUserId)) {
    throw new Error('CATALOG_ACTOR_USER_MISMATCH');
  }
  const execution = authorizeRuntimeUserProviderEffect({
    authenticatedPrincipal,
    provider,
    engine: 'catalog_adapter',
    entrypoint: 'provider.models.catalog',
    purpose: 'catalog',
    effectFootprint: 'external',
    projectId: 'system:provider-catalog',
    workspacePath: process.cwd(),
  });
  return runPermissionExecutionAdapter(execution, probe);
};
