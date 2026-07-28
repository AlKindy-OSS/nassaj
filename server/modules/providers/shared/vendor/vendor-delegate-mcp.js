/**
 * vendor-delegate-mcp — an in-process MCP server that lets a Claude run delegate
 * a single prompt to a hosted vendor model (kimi/deepseek/glm) without changing
 * the run's own engine (ADR-037, B-DEL-5).
 *
 * This is the "ask a vendor a question mid-run" tool, NOT the "run the engine on
 * a vendor" path (that is apply-claude-engine-provider-env.js). It is built
 * PER SPAWN via buildVendorDelegateMcp(userId): the user id is captured in the
 * tool closure so the key fetch is always scoped to the spawning user, and there
 * is no module-level/global server instance that could leak one user's key into
 * another user's run.
 *
 * Iron-rule posture: the tool calls the vendor's Anthropic-compatible endpoint as
 * a fully independent HTTP client — `fetch` with an `x-api-key` header. It never
 * reads or writes any ANTHROPIC_ or CLAUDE_ env var and never touches
 * sdkOptions.env, so it cannot redirect the Claude engine. (It is intentionally
 * outside SEAM_FILES because it imports the SDK's MCP wrapper helpers, but it
 * routes no Claude traffic.)
 *
 * @typedef {import('../../../../services/isolation/provider-anthropic-endpoints.js').EngineProvider} EngineProvider
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import {
  ENGINE_PROVIDERS,
  PROVIDER_ANTHROPIC_ENDPOINT,
} from '../../../../services/isolation/provider-anthropic-endpoints.js';
import { getProviderKey } from '../../../../services/isolation/provider-secrets-store.js';

/** Cap on tokens requested from the vendor for a single delegated answer. */
const DEFAULT_MAX_TOKENS = 4096;

/** Default model id per provider when the caller does not pin one. */
const DEFAULT_MODEL = Object.freeze({
  kimi: 'kimi-k2.6',
  deepseek: 'deepseek-v4-pro',
  glm: 'glm-5.2',
});

/** Wraps a plain string into the MCP tool_result content shape. */
function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * Builds a per-spawn MCP server exposing `delegate_to_vendor`. The returned value
 * is dropped straight into sdkOptions.mcpServers under a stable key.
 *
 * @param {string|number|null} userId user whose stored vendor key authorizes the call
 * @returns {import('@anthropic-ai/claude-agent-sdk').McpSdkServerConfigWithInstance}
 */
export function buildVendorDelegateMcp(userId) {
  return createSdkMcpServer({
    name: 'vendor-delegate',
    version: '1.0.0',
    tools: [
      tool(
        'delegate_to_vendor',
        'Delegate a single prompt to a hosted vendor model (kimi, deepseek, or glm) ' +
          'and return its answer as text. Use to get a second opinion or offload a ' +
          'subtask to another model. Requires the user to have configured an API key ' +
          'for the chosen provider.',
        {
          provider: z
            .enum(['kimi', 'deepseek', 'glm'])
            .describe('Which hosted vendor model to delegate to.'),
          prompt: z.string().min(1).describe('The full prompt to send to the vendor model.'),
          model: z
            .string()
            .optional()
            .describe('Optional explicit vendor model id; defaults to the provider default.'),
          max_tokens: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Optional max tokens for the vendor response.'),
        },
        async ({ provider, prompt, model, max_tokens }) => {
          // Membership gate: only the three engine providers are delegable.
          if (!ENGINE_PROVIDERS.has(provider)) {
            return textResult(`Unknown vendor provider: ${String(provider)}`, true);
          }

          // Per-user key: scoped to the spawning user captured in this closure.
          const token = getProviderKey(userId, provider);
          if (!token) {
            return textResult(
              `No API key configured for ${provider}. Add one in the provider settings, ` +
                'then retry.',
              true,
            );
          }

          const endpoint = PROVIDER_ANTHROPIC_ENDPOINT[provider];
          try {
            const response = await fetch(`${endpoint}/v1/messages`, {
              method: 'POST',
              headers: {
                'x-api-key': token,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                model: model || DEFAULT_MODEL[provider],
                max_tokens: max_tokens || DEFAULT_MAX_TOKENS,
                messages: [{ role: 'user', content: prompt }],
              }),
            });

            if (!response.ok) {
              // Surface a generic, non-leaky failure to the model; the key/body
              // are never echoed back.
              return textResult(
                `Vendor ${provider} request failed with status ${response.status}.`,
                true,
              );
            }

            const data = await response.json();
            const text = Array.isArray(data?.content)
              ? data.content
                  .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
                  .map((block) => block.text)
                  .join('')
              : '';
            return textResult(text || '(vendor returned no text content)');
          } catch (error) {
            return textResult(
              `Vendor ${provider} delegation error: ${error?.message || 'request failed'}`,
              true,
            );
          }
        },
      ),
    ],
  });
}
