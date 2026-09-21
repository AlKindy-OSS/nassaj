import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

function createTestExecution() {
  return {
    decisionId: 'test-permission-decision',
    leaseId: 'test-permission-lease',
    mode: 'legacy' as const,
    consume: () => ({ decisionId: 'test-permission-decision' }),
    markStarted: () => undefined,
    settle: () => undefined,
    notStarted: () => undefined,
  };
}

/** Explicitly authorizes a provider launch in legacy dispatch harnesses. */
export function authorizeTestProviderExecution() {
  return { kind: 'authorized' as const, execution: createTestExecution() };
}

/** In-memory workspace seam for dispatch-only tests that do not exercise binding. */
export function createPermissionTestWorkspaceModule() {
  const resolve = (input: Record<string, any>) => ({
    cwd: input.projectPath,
    logicalProjectPath: input.projectPath,
    isolation: 'overlay' as const,
    generation: 'permission-test-generation',
  });
  return {
    resolveSessionWorkspaceForLaunch: resolve,
    bindSessionWorkspace: resolve,
  };
}

type Dispatch = (
  messageType: string,
  data: Record<string, unknown>,
  writer: WebSocketWriter,
  dependencies: Record<string, unknown>,
  principalId?: string | number | null,
  authenticatedPrincipal?: unknown,
) => Promise<void>;

/**
 * Supplies the server-authoritative launch facts that predate permission
 * admission in focused websocket harnesses. Production never calls this helper.
 */
export function dispatchAuthorizedProviderCommand(
  dispatch: Dispatch,
  messageType: string,
  data: Record<string, any>,
  writer: WebSocketWriter,
  dependencies: Record<string, any>,
  principalId: string | number = 1,
): Promise<void> {
  const options = {
    cwd: process.cwd(),
    ...(data.options ?? {}),
  };
  return dispatch(
    messageType,
    { ...data, options },
    writer,
    { authorizeProviderExecution: authorizeTestProviderExecution, ...dependencies },
    principalId,
    Object.freeze({
      id: principalId,
      role: 'user',
      authenticationKind: 'session',
      authorizationGeneration: 1,
    }),
  );
}
