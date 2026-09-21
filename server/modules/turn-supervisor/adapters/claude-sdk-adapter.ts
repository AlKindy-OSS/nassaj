import { query, type Options, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

import { assertAnthropicBaseUrlAllowed, assertSettingsEnvAllowed } from '../../../services/isolation/anthropic-base-url-guard.js';
import { resolveClaudeCodeExecutablePath } from '../../../shared/claude-cli-path.js';

import {
  TurnAdapterError,
  type TurnAdapterCapabilities,
  type TurnAdapterRegistration,
  type TurnAdapterResult,
} from './types.js';

export const CLAUDE_SDK_MECHANICAL_FLAG = 'NASSAJ_TURN_SUPERVISOR_CLAUDE_CHAT_SDK_MECHANICAL';

export const CLAUDE_SDK_CAPABILITIES: TurnAdapterCapabilities = Object.freeze({
  execution: 'ephemeral-cli',
  persist: false,
  hiddenContext: 'system',
  abort: true,
  effects: 'none',
  nativeDelegation: Object.freeze({
    supported: false,
    reason: 'supervisor_disables_native_delegation',
  }),
});

export function isClaudeSdkMechanicalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CLAUDE_SDK_MECHANICAL_FLAG] === '1';
}

type QueryFactory = (input: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeSdkTurnAdapterOptions {
  readonly enabled?: () => boolean;
  readonly getAuthStatus?: (userId: string | number) => Promise<{
    readonly installed: boolean;
    readonly authenticated: boolean;
  }>;
  readonly queryFactory?: QueryFactory;
  readonly resolveEnvironment?: (
    userId: string | number,
    baseEnv: NodeJS.ProcessEnv,
  ) => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
}

/**
 * Ephemeral Claude Agent SDK adapter for supervisor-owned roles.
 *
 * It exposes no transcript/websocket/effect surface. Claude's complete built-in
 * tool set is removed, Agent/Task are denied again by name, and the permission
 * callback denies every attempted tool as a final fail-closed boundary.
 */
export function createClaudeSdkTurnAdapter(
  options: ClaudeSdkTurnAdapterOptions = {},
): TurnAdapterRegistration {
  const enabled = options.enabled ?? isClaudeSdkMechanicalEnabled;
  const getAuthStatus = options.getAuthStatus
    ?? (async (userId) => {
      const { providerAuthService } = await import('../../providers/index.js');
      return providerAuthService.getProviderAuthStatus('claude', userId);
    });
  const queryFactory = options.queryFactory ?? ((input) => query(input));
  const resolveEnvironment = options.resolveEnvironment
    ?? (async (userId, baseEnv) => {
      const { resolveProviderEnv } = await import('../../../services/isolation/resolve-provider-env.js');
      return resolveProviderEnv(userId, 'claude', baseEnv);
    });

  const adapter: TurnAdapterRegistration = {
    id: 'claude-sdk-ephemeral',
    capabilities: CLAUDE_SDK_CAPABILITIES,
    supports(provider: string): provider is 'claude' {
      return provider === 'claude';
    },
    async probe(request): Promise<boolean> {
      if (request.provider !== 'claude' || !enabled()) return false;
      const status = await getAuthStatus(request.userId);
      return status.installed && status.authenticated;
    },
    async invoke(request): Promise<TurnAdapterResult> {
      if (request.provider !== 'claude' || !enabled()) {
        throw new TurnAdapterError('provider_unavailable', 'Claude SDK supervisor cell is disabled');
      }
      if (request.persist !== false) {
        throw new TurnAdapterError('invalid_persistence', 'Claude supervisor roles require persist:false');
      }
      if (request.effects && request.effects.length > 0) {
        throw new TurnAdapterError('effects_unsupported', 'Claude supervisor roles cannot execute effects');
      }
      if (request.signal?.aborted) throw aborted(request.signal.reason);

      const abortController = new AbortController();
      const forwardAbort = (): void => abortController.abort(request.signal?.reason);
      request.signal?.addEventListener('abort', forwardAbort, { once: true });

      try {
        const env = await resolveEnvironment(request.userId, { ...process.env });
        assertAnthropicBaseUrlAllowed(env);
        assertSettingsEnvAllowed(env.CLAUDE_CONFIG_DIR ?? '', env);
        const sdkOptions: Options = {
          abortController,
          env,
          model: request.model,
          maxTurns: 1,
          persistSession: false,
          settingSources: [],
          tools: [],
          allowedTools: [],
          disallowedTools: ['Agent', 'Task'],
          agents: {},
          mcpServers: {},
          plugins: [],
          skills: [],
          permissionMode: 'dontAsk',
          includePartialMessages: false,
          pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(env.CLAUDE_CLI_PATH),
          systemPrompt: [request.system, ...(request.hiddenContext ?? [])]
            .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
            .join('\n\n'),
          canUseTool: async () => ({
            behavior: 'deny',
            message: 'Turn Supervisor internal roles have no effect or native-spawn authority.',
            interrupt: true,
          }),
        };
        if (process.env.NASSAJ_PROVIDER_CAGE === '1') {
          const { buildCagedSdkSpawn } = await import('../../../services/isolation/provider-cage-wiring.js');
          const cagedSpawn = buildCagedSdkSpawn({ userId: request.userId, cwd: null });
          if (cagedSpawn) sdkOptions.spawnClaudeCodeProcess = cagedSpawn;
        }

        let terminal: SDKResultMessage | undefined;
        for await (const message of queryFactory({ prompt: request.prompt, options: sdkOptions })) {
          if (abortController.signal.aborted) throw aborted(abortController.signal.reason);
          if (message.type === 'assistant' && message.message.content.some((block) => block.type === 'tool_use')) {
            abortController.abort('tool_use_denied');
            throw new TurnAdapterError(
              'effects_unsupported',
              'Claude emitted a tool call despite the toolless supervisor profile',
            );
          }
          if (message.type === 'result') terminal = message;
        }
        if (!terminal) {
          throw new TurnAdapterError('remote_error', 'Claude SDK ended without a terminal result');
        }
        if (terminal.subtype !== 'success' || terminal.is_error) {
          throw new TurnAdapterError('remote_error', 'Claude SDK returned a failed terminal result');
        }

        const usage = {
          inputTokens: terminal.usage.input_tokens,
          outputTokens: terminal.usage.output_tokens,
        };
        await request.writer.capture({ type: 'text', text: terminal.result });
        await request.writer.capture({ type: 'usage', ...usage });
        await request.writer.capture({ type: 'complete', stopReason: terminal.stop_reason ?? undefined });
        return {
          provider: 'claude',
          model: request.model,
          text: terminal.result,
          stopReason: terminal.stop_reason ?? undefined,
          usage,
        };
      } catch (error) {
        if (error instanceof TurnAdapterError) throw error;
        if (abortController.signal.aborted || request.signal?.aborted || isAbortError(error)) {
          throw aborted(request.signal?.reason ?? abortController.signal.reason ?? error);
        }
        throw new TurnAdapterError('remote_error', 'Claude SDK supervisor request failed', { cause: error });
      } finally {
        request.signal?.removeEventListener('abort', forwardAbort);
      }
    },
  };
  return Object.freeze(adapter);
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError');
}

function aborted(cause: unknown): TurnAdapterError {
  return new TurnAdapterError('aborted', 'Claude SDK supervisor request was aborted', { cause });
}
