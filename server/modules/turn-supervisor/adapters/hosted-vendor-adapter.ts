import { VENDOR_RUNTIME } from '@/modules/providers/index.js';

import {
  TurnAdapterError,
  type HostedTurnProvider,
  type TurnAdapterRegistration,
  type TurnAdapterResult,
} from './types.js';

const PROVIDERS = new Set<HostedTurnProvider>(['kimi', 'deepseek', 'glm']);
const DEFAULT_MAX_TOKENS = 8_192;

export interface HostedVendorAdapterOptions {
  /** Server-side secret resolver. The token never contains this value. */
  readonly resolveCredential: (
    provider: HostedTurnProvider,
    userId: string | number,
  ) => string | null | undefined | Promise<string | null | undefined>;
  readonly fetchImpl?: typeof fetch;
}

interface AnthropicResponse {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly stop_reason?: string;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
}

/** Creates the external, stateless hosted-provider adapter registration. */
export function createHostedVendorAdapter(options: HostedVendorAdapterOptions): TurnAdapterRegistration {
  const fetchImpl = options.fetchImpl ?? fetch;

  const adapter: TurnAdapterRegistration = {
    id: 'hosted-vendor-ephemeral',
    supports(provider: string): provider is HostedTurnProvider {
      return PROVIDERS.has(provider as HostedTurnProvider);
    },
    async probe(request): Promise<boolean> {
      if (!PROVIDERS.has(request.provider as HostedTurnProvider)) {
        return false;
      }
      const credential = await options.resolveCredential(
        request.provider as HostedTurnProvider,
        request.userId,
      );
      return typeof credential === 'string' && credential.length > 0;
    },
    async invoke(request): Promise<TurnAdapterResult> {
      if (!PROVIDERS.has(request.provider as HostedTurnProvider)) {
        throw new TurnAdapterError('provider_unavailable', 'Hosted adapter received another provider');
      }
      const provider = request.provider as HostedTurnProvider;
      if (request.signal?.aborted) {
        throw aborted(request.signal.reason);
      }
      if (request.persist !== false) {
        throw new TurnAdapterError('invalid_persistence', 'Hosted turns require persist:false');
      }
      if (request.effects && request.effects.length > 0) {
        throw new TurnAdapterError('effects_unsupported', 'Hosted turns cannot execute effects');
      }

      const credential = await options.resolveCredential(provider, request.userId);
      if (!credential) {
        throw new TurnAdapterError('credential_unavailable', 'Provider credential is unavailable');
      }
      if (request.signal?.aborted) {
        throw aborted(request.signal.reason);
      }

      const system = [request.system, ...(request.hiddenContext ?? [])]
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .join('\n\n');
      const body = {
        model: request.model,
        max_tokens: clampInteger(request.maxTokens, DEFAULT_MAX_TOKENS),
        stream: false,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: request.prompt }],
        ...(typeof request.temperature === 'number'
          ? { temperature: Math.min(1, Math.max(0, request.temperature)) }
          : {}),
      };

      let response: Response;
      try {
        response = await fetchImpl(VENDOR_RUNTIME[provider].messagesUrl, {
          method: 'POST',
          signal: request.signal,
          headers: {
            'x-api-key': credential,
            Authorization: `Bearer ${credential}`,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (request.signal?.aborted || isAbortError(error)) {
          throw aborted(request.signal?.reason ?? error);
        }
        throw new TurnAdapterError('remote_error', 'Hosted provider request failed', {
          cause: error,
        });
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new TurnAdapterError(
          'remote_error',
          `Hosted provider request failed with HTTP ${response.status}`,
        );
      }

      const payload = (await response.json()) as AnthropicResponse;
      const text = (payload.content ?? [])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
      const usage = payload.usage
        ? {
            inputTokens: payload.usage.input_tokens,
            outputTokens: payload.usage.output_tokens,
          }
        : undefined;

      await request.writer.capture({ type: 'text', text });
      if (usage) {
        await request.writer.capture({ type: 'usage', ...usage });
      }
      await request.writer.capture({ type: 'complete', stopReason: payload.stop_reason });

      return {
        provider,
        model: request.model,
        text,
        stopReason: payload.stop_reason,
        usage,
      };
    },
  };
  return Object.freeze(adapter);
}

function clampInteger(value: number | undefined, fallback: number): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) {
    return fallback;
  }
  return Math.min(value as number, 65_536);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError');
}

function aborted(cause: unknown): TurnAdapterError {
  return new TurnAdapterError('aborted', 'Hosted provider request was aborted', { cause });
}
