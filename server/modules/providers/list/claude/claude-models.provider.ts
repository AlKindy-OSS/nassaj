import { readFile } from 'node:fs/promises';

import { getClaudeModelCatalog } from '@/modules/providers/list/claude/claude-catalog.client.js';
import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

/**
 * Graceful-degradation safety net for the Claude model picker.
 *
 * The authoritative source is now the LIVE catalog fetched from the installed
 * Claude Code via {@link getClaudeModelCatalog} (see claude-catalog.client.ts),
 * which reflects the operator's actual subscription and automatically surfaces
 * the newest model the account can use. This array is served ONLY when that live
 * probe is unavailable (Claude not installed, spawn/timeout failure, circuit
 * breaker open), and is flagged `degraded` by the catalog client so the cache
 * layer re-probes within minutes.
 *
 * Values/descriptions mirror what `supportedModels()` returns today (verified
 * against the live SDK output) so the degraded picker stays plausible. Keep
 * `sonnet[1m]` — it is a real selectable value but consumes 1M-context usage
 * credits, hence the explicit note.
 *
 * `claude-fable-5` is intentionally absent. Two layers keep it out: (1) the live
 * catalog now probes under the user's REAL credentials (resolveProviderEnv), so
 * Anthropic only advertises the models that subscription is entitled to and an
 * unreleased model never appears in the first place; (2) this degraded fallback
 * — served only when the live probe is unavailable — must also omit it so the
 * picker never offers an unusable model. Do NOT re-add it until it is actually
 * usable. (Older note: a hand-maintained UNRELEASED_HIDDEN_MODELS hide-list used
 * to exist in claude-catalog.client.ts; it was removed once real authentication
 * made it redundant.)
 */
export const CLAUDE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the default model (currently Opus 4.8 (1M context)) · $5/$25 per Mtok',
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Sonnet 4.6 · Best for everyday tasks · $3/$15 per Mtok',
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Sonnet 4.6 with 1M context · Requires 1M-context access · draws from usage credits · $3/$15 per Mtok',
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok',
    },
    {
      value: 'claude-opus-4-8',
      label: 'Opus 4.8',
      description: 'Opus 4.8 · Latest, most capable Opus for complex work',
    },
  ],
  DEFAULT: 'default',
};
type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:'
  + '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]'
  + '|(?:[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);

const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel || null;
};

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsi(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    if (changedModel?.[1]?.trim()) {
      return changedModel[1].trim();
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag || null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

export class ClaudeProviderModels implements IProviderModels {
  /**
   * Returns the live Claude model catalog when the SDK probe succeeds, otherwise
   * {@link CLAUDE_FALLBACK_MODELS} flagged as degraded. The catalog client owns
   * the side-effect-free probe (zero-turn streaming prompt in an isolated temp
   * cwd — no jsonl session, no workspace listing), the abort timeout, the
   * circuit breaker, the single-flight lock, and the graceful fallback.
   *
   * The provider-models service caches a live catalog for the normal multi-day
   * TTL and a degraded fallback only briefly, and serves a stale entry instantly
   * while refreshing in the background, so this probe never blocks the request
   * path.
   *
   * `userId` is forwarded to the catalog client so the probe runs under THIS
   * user's CLAUDE_CONFIG_DIR (their real subscription). That is what makes the
   * list accurate per account and lets Anthropic's own entitlement filtering hide
   * unreleased models. When omitted/null (system/anon/platform) the operator's
   * shared environment is used — unchanged from the single-user behaviour.
   */
  async getSupportedModels(userId?: string | number | null): Promise<ProviderModelsDefinition> {
    return getClaudeModelCatalog(userId ?? null);
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('claude', input);
  }
}
