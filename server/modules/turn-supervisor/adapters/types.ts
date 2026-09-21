/**
 * Provider-neutral envelope used by the turn supervisor's adapter boundary.
 *
 * The envelope deliberately has no websocket or transcript surface. Adapters may
 * capture an ephemeral result, but they cannot publish it or turn it into history.
 */

export type HostedTurnProvider = 'kimi' | 'deepseek' | 'glm';
export type CliTurnProvider = 'codex' | 'claude' | 'qwen' | 'opencode' | 'hermes';
export type TurnProvider = HostedTurnProvider | CliTurnProvider;

declare const capabilityTokenBrand: unique symbol;

/**
 * Opaque authority issued by {@link TurnAdapterRegistry}. Its runtime value is
 * identity-checked; this brand only prevents accidental construction in TS.
 */
export interface TurnCapabilityToken {
  readonly [capabilityTokenBrand]: 'turn-capability';
}

export type TurnAdapterErrorCode =
  | 'aborted'
  | 'capability_expired'
  | 'capability_forged'
  | 'capability_used'
  | 'credential_unavailable'
  | 'effects_unsupported'
  | 'invalid_persistence'
  | 'provider_unavailable'
  | 'remote_error';

export class TurnAdapterError extends Error {
  readonly code: TurnAdapterErrorCode;

  constructor(code: TurnAdapterErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TurnAdapterError';
    this.code = code;
  }
}

export interface TurnAdapterCapabilities {
  readonly execution: 'ephemeral-external' | 'ephemeral-cli';
  readonly persist: false;
  readonly hiddenContext: 'system';
  readonly abort: true;
  readonly effects: 'none';
  readonly nativeDelegation: {
    readonly supported: false;
    readonly reason:
      | 'hosted_completion_endpoint_has_no_native_delegation'
      | 'supervisor_disables_native_delegation';
  };
}

export type TurnCaptureEvent =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'usage';
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    }
  | { readonly type: 'complete'; readonly stopReason?: string };

/** Capture-only by construction: no send, append, session, or persistence API. */
export interface TurnCaptureWriter {
  capture(event: TurnCaptureEvent): void | Promise<void>;
}

export interface TurnAdapterInvoke {
  readonly capability: TurnCapabilityToken;
  readonly model: string;
  readonly prompt: string;
  /** Trusted context sent only through the provider's system channel. */
  readonly hiddenContext?: readonly string[];
  readonly system?: string;
  /** Must be explicitly false; adapters never create or resume remote history. */
  readonly persist: false;
  /** Reserved for a future cage. This capture-only envelope accepts none. */
  readonly effects?: readonly unknown[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  readonly writer: TurnCaptureWriter;
  readonly executionIdentity?: Readonly<{ runId: string; writerEpoch: number }>;
}

export interface TurnAdapterProbeRequest {
  readonly provider: string;
  /** Server-authenticated principal; never a capability claim from the client. */
  readonly userId: string | number;
}

export interface TurnAdapterProbeResult {
  readonly provider: string;
  readonly available: boolean;
  readonly reason?: 'missing_credential' | 'unsupported_provider' | 'unavailable';
  readonly capabilities?: TurnAdapterCapabilities;
  readonly capability?: TurnCapabilityToken;
}

export interface TurnAdapterResult {
  readonly provider: TurnProvider;
  readonly model: string;
  readonly text: string;
  readonly stopReason?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
}

/** Server-side registration contract. Callers execute registrations via registry. */
export interface TurnAdapterRegistration {
  readonly id: string;
  readonly capabilities?: TurnAdapterCapabilities;
  supports(provider: string): provider is TurnProvider;
  probe(request: TurnAdapterProbeRequest): Promise<boolean>;
  invoke(
    request: Omit<TurnAdapterInvoke, 'capability'> & {
      readonly provider: TurnProvider;
      readonly userId: string | number;
    },
  ): Promise<TurnAdapterResult>;
}
