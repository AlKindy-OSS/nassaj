/**
 * T-1910: idempotent provider reads (quota) carried by the server process itself.
 *
 * The lease is admitted with a local footprint and records this server as its effect child
 * in the same CAS as the start. If the server dies mid-read, boot reconciliation proves the
 * child dead through the owner identity and settles unknownLocal: no scope fence, not fatal.
 * The helper takes a request descriptor, never a closure: one GET to an allowlisted
 * origin, redirects refused, one deadline over headers and body, no callbacks, no spawn,
 * no file writes and no credential refresh. Callers parse the returned body themselves.
 */
import type { PermissionTerminalOutcome } from '@/modules/database/index.js';

import { isGatewayIssuedExecution, type PermissionExecutionHandle } from './execution-gateway.service.js';
import { issueInProcessReadCapability } from './in-process-read-capability.js';
import {
  InProcessReadRefusedError,
  validateInProcessReadDescriptor,
  type InProcessReadDescriptor,
  type InProcessReadResult,
} from './in-process-read-descriptor.js';
import { authorizeRuntimeUserProviderEffect } from './runtime-user-effect.js';

const CAPABILITY = issueInProcessReadCapability();

export const IN_PROCESS_READ_MAX_BODY_BYTES = 1_048_576;

class BodyTooLargeError extends Error {}

/** Rejects once the deadline signal fires, so a stalled body cannot outlive the deadline. */
const untilAborted = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

const readBoundedBody = async (response: Response, signal: AbortSignal): Promise<string> => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const aborted = untilAborted(signal);
  aborted.catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > IN_PROCESS_READ_MAX_BODY_BYTES) throw new BodyTooLargeError();
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString('utf8');
};

const isRedirect = (response: Response): boolean => response.redirected
  || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);

/** Sends exactly one validated request under one deadline. Never throws. */
const performRead = async (
  descriptor: InProcessReadDescriptor,
  fetchImpl: typeof fetch,
): Promise<InProcessReadResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('IN_PROCESS_READ_DEADLINE')),
    descriptor.deadlineMs);
  try {
    const response = await Promise.race([
      fetchImpl(descriptor.url, {
        method: descriptor.method,
        headers: { ...descriptor.headers },
        redirect: 'error',
        signal: controller.signal,
      }),
      untilAborted(controller.signal),
    ]);
    if (isRedirect(response)) {
      void response.body?.cancel().catch(() => {});
      return Object.freeze({ kind: 'failed', reason: 'redirect' });
    }
    const body = await readBoundedBody(response, controller.signal);
    return Object.freeze({ kind: 'response', status: response.status, body });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return Object.freeze({ kind: 'failed', reason: 'too_large' });
    return Object.freeze({ kind: 'failed', reason: controller.signal.aborted ? 'timeout' : 'network' });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};

const outcomeOf = (result: InProcessReadResult): PermissionTerminalOutcome => {
  if (result.kind === 'response') return result.status >= 200 && result.status < 300 ? 'succeeded' : 'failed';
  return result.reason === 'timeout' ? 'timed_out' : 'failed';
};

export type InProcessReadScope = Readonly<{
  authenticatedPrincipal: unknown;
  provider: string;
  purpose: 'quota';
}>;

/** Production admission for an in-process read: a local footprint on the caller's scope. */
const authorizeInProcessRead = (scope: InProcessReadScope): PermissionExecutionHandle =>
  authorizeRuntimeUserProviderEffect({
    authenticatedPrincipal: scope.authenticatedPrincipal,
    provider: scope.provider,
    engine: `${scope.provider}_${scope.purpose}`,
    entrypoint: `provider.routes.${scope.purpose}.in_process_read`,
    purpose: scope.purpose,
    effectFootprint: 'local',
    projectId: `system:provider-${scope.purpose}`,
    workspacePath: process.cwd(),
  });

export type InProcessReadDependencies = Readonly<{
  authorize?: (scope: InProcessReadScope) => PermissionExecutionHandle;
  fetchImpl?: typeof fetch;
}>;

/**
 * Runs one admitted in-process read. A refused descriptor throws before admission; a refused
 * or failed start throws after settling `failed`. Network failures and the deadline settle
 * `failed` / `timed_out` and return a failed result; this helper never settles unknown.
 * Fail-closed: if the terminal settlement cannot be persisted after the read returned, the
 * gateway blocks the protocol generation and this call throws (the route answers 500);
 * the read's result is discarded rather than served without its durable receipt.
 * `authorize` is a test seam only; its result must still be a gateway-minted handle.
 */
export const runAuthorizedInProcessRead = async (
  scope: InProcessReadScope,
  rawDescriptor: unknown,
  dependencies: InProcessReadDependencies = {},
): Promise<InProcessReadResult> => {
  const descriptor = validateInProcessReadDescriptor(rawDescriptor);
  const execution: unknown = (dependencies.authorize ?? authorizeInProcessRead)(scope);
  // The capability is handed only to a handle a gateway minted; an injected look-alike
  // (or a wrapper around a real handle) never receives it.
  if (!isGatewayIssuedExecution(execution)) {
    throw new InProcessReadRefusedError('IN_PROCESS_READ_HANDLE_UNTRUSTED');
  }
  execution.consume();
  try {
    execution.markStartedInProcessRead(CAPABILITY);
  } catch (error) {
    // Nothing was sent: the start record is written before the request exists.
    try { execution.settle('failed'); } catch { /* Keep the start failure as the cause. */ }
    throw error;
  }
  const result = await performRead(descriptor, dependencies.fetchImpl ?? fetch);
  execution.settle(outcomeOf(result));
  return result;
};
