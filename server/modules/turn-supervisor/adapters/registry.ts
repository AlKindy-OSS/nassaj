import type { AdapterTerminalExitProof } from '../resource-admission.js';

import {
  TurnAdapterError,
  type TurnAdapterCapabilities,
  type TurnAdapterInvoke,
  type TurnAdapterProbeRequest,
  type TurnAdapterProbeResult,
  type TurnAdapterRegistration,
  type TurnAdapterResult,
  type TurnCapabilityToken,
} from './types.js';

export const HOSTED_CAPABILITIES: TurnAdapterCapabilities = Object.freeze({
  execution: 'ephemeral-external',
  persist: false,
  hiddenContext: 'system',
  abort: true,
  effects: 'none',
  nativeDelegation: Object.freeze({
    supported: false,
    reason: 'hosted_completion_endpoint_has_no_native_delegation',
  }),
});

interface CapabilityBinding {
  readonly adapter: TurnAdapterRegistration;
  readonly provider: string;
  readonly userId: string;
  readonly expiresAt: number;
  used: boolean;
}

export interface TurnAdapterRegistryOptions {
  readonly capabilityTtlMs?: number;
  readonly now?: () => number;
  readonly issueTerminalProof?: (input: {
    adapterId: string; runId: string; writerEpoch: number; observedAtMs: number; settled: true;
  }) => AdapterTerminalExitProof;
}

/**
 * Sole capability issuer and execution gateway for turn adapters.
 *
 * Tokens are null-prototype identities stored only in a private WeakMap. They
 * throw from JSON serialization and cannot be reconstructed from client input.
 */
export class TurnAdapterRegistry {
  readonly #registrations: readonly TurnAdapterRegistration[];
  readonly #bindings = new WeakMap<object, CapabilityBinding>();
  readonly #capabilityTtlMs: number;
  readonly #now: () => number;
  readonly #issueTerminalProof?: TurnAdapterRegistryOptions['issueTerminalProof'];
  readonly #executions = new Map<string, { active: number; closed: boolean; adapterId: string | null }>();

  constructor(registrations: readonly TurnAdapterRegistration[], options: TurnAdapterRegistryOptions = {}) {
    this.#registrations = Object.freeze(registrations.slice());
    this.#capabilityTtlMs = options.capabilityTtlMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#issueTerminalProof = options.issueTerminalProof;
    if (!Number.isSafeInteger(this.#capabilityTtlMs) || this.#capabilityTtlMs < 1) {
      throw new TypeError('capabilityTtlMs must be a positive safe integer');
    }
  }

  async probe(request: TurnAdapterProbeRequest): Promise<TurnAdapterProbeResult> {
    const adapter = this.#registrations.find((candidate) => candidate.supports(request.provider));
    if (!adapter) {
      return { provider: request.provider, available: false, reason: 'unsupported_provider' };
    }

    // The adapter resolves credentials/server state itself. No client-supplied
    // capability declaration can influence this answer.
    const available = await adapter.probe(request).catch(() => false);
    if (!available) {
      return { provider: request.provider, available: false, reason: 'missing_credential' };
    }

    const capability = this.#issue(adapter, request);
    return {
      provider: request.provider,
      available: true,
      capabilities: adapter.capabilities ?? HOSTED_CAPABILITIES,
      capability,
    };
  }

  async invoke(request: TurnAdapterInvoke): Promise<TurnAdapterResult> {
    const token = request.capability as unknown;
    if ((typeof token !== 'object' || token === null) && typeof token !== 'function') {
      throw new TurnAdapterError('capability_forged', 'Turn capability was not issued by this registry');
    }
    const binding = this.#bindings.get(token as object);
    if (!binding) {
      throw new TurnAdapterError('capability_forged', 'Turn capability was not issued by this registry');
    }
    if (binding.used) {
      throw new TurnAdapterError('capability_used', 'Turn capability has already been consumed');
    }
    if (this.#now() > binding.expiresAt) {
      binding.used = true;
      throw new TurnAdapterError('capability_expired', 'Turn capability has expired');
    }

    // Consume before any async boundary: one authority starts at most one remote
    // request, including when the request later aborts or fails ambiguously.
    binding.used = true;
    if (request.persist !== false) {
      throw new TurnAdapterError('invalid_persistence', 'Turn adapters require persist:false');
    }
    if (request.effects && request.effects.length > 0) {
      throw new TurnAdapterError('effects_unsupported', 'Hosted capture-only turns do not support effects');
    }

    const { capability: _capability, executionIdentity, ...invocation } = request;
    const executionKey = executionIdentity
      ? `${executionIdentity.runId}:${executionIdentity.writerEpoch}` : null;
    const execution = executionKey ? this.#executions.get(executionKey) : undefined;
    if (executionIdentity && this.#issueTerminalProof && !execution) {
      throw new TurnAdapterError('capability_forged', 'Execution identity was not opened by registry');
    }
    if (execution) {
      if (execution.closed) throw new TurnAdapterError('capability_expired', 'Execution identity is closed');
      execution.active += 1;
      execution.adapterId = binding.adapter.id;
    }
    try {
      return await binding.adapter.invoke({
        ...invocation,
        provider: binding.provider as never,
        userId: binding.userId,
      });
    } finally {
      if (execution) execution.active -= 1;
    }
  }

  beginExecution(runId: string, writerEpoch: number): void {
    const key = `${runId}:${writerEpoch}`;
    if (!runId || !Number.isSafeInteger(writerEpoch) || writerEpoch < 0 || this.#executions.has(key)) {
      throw new TypeError('invalid or duplicate registry execution identity');
    }
    this.#executions.set(key, { active: 0, closed: false, adapterId: null });
  }

  closeExecution(runId: string, writerEpoch: number): AdapterTerminalExitProof | null {
    const key = `${runId}:${writerEpoch}`;
    const execution = this.#executions.get(key);
    if (!execution || execution.closed || execution.active !== 0 || !this.#issueTerminalProof) return null;
    execution.closed = true;
    this.#executions.delete(key);
    return this.#issueTerminalProof({
      adapterId: execution.adapterId ?? 'hosted-vendor-ephemeral:no-dispatch',
      runId, writerEpoch, observedAtMs: this.#now(), settled: true,
    });
  }

  abandonUndispatchedExecution(runId: string, writerEpoch: number): boolean {
    const key = `${runId}:${writerEpoch}`;
    const execution = this.#executions.get(key);
    if (!execution || execution.active !== 0 || execution.adapterId !== null) return false;
    return this.#executions.delete(key);
  }

  #issue(adapter: TurnAdapterRegistration, request: TurnAdapterProbeRequest): TurnCapabilityToken {
    const token = Object.create(null) as object;
    Object.defineProperty(token, 'toJSON', {
      enumerable: false,
      value(): never {
        throw new TypeError('Turn capability tokens are not serializable');
      },
    });
    Object.freeze(token);
    this.#bindings.set(token, {
      adapter,
      provider: request.provider,
      userId: String(request.userId),
      expiresAt: this.#now() + this.#capabilityTtlMs,
      used: false,
    });
    return token as TurnCapabilityToken;
  }
}
