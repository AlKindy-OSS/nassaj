import type {
  IProvider,
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { KimiProviderAuth } from './kimi-auth.provider.js';
import { KimiProviderModels } from './kimi-models.provider.js';

/** Typed refusal for every body facet: kimi has no launcher, skills, MCP or sessions. */
function notABody(): never {
  throw new AppError('"kimi" is an engine of the Claude body, not a body.', {
    code: 'UNSUPPORTED_PROVIDER',
    statusCode: 400,
  });
}

const refusedMcp: IProviderMcp = {
  supportsMcp: false,
  writesPerUserConfig: false,
  listServers: async () => notABody(),
  listServersForScope: async () => notABody(),
  upsertServer: async () => notABody(),
  removeServer: async () => notABody(),
};

const refusedSkills: IProviderSkills = {
  listSkills: async () => notABody(),
  addSkills: async () => notABody(),
  removeSkill: async () => notABody(),
};

const refusedSessions: IProviderSessions = {
  normalizeMessage: () => notABody(),
  fetchHistory: async () => notABody(),
};

/**
 * Nothing to index: no body writes kimi sessions any more. A late file event
 * from the vendor transcript root is ignored, never an error.
 */
const inertSynchronizer: IProviderSessionSynchronizer = {
  synchronize: async () => 0,
  synchronizeFile: async () => null,
};

/**
 * The Kimi ENGINE face (ADR-229). The Kimi body is removed; what stays is the
 * Moonshot model catalog and the key status that the Claude engine picker and
 * the engine re-stamp path read through `resolveProvider('kimi')`. It is
 * registered apart from the bodies, so `listProviders` and the history reader
 * never see it, and every body facet answers a typed refusal.
 */
export class KimiEngineProvider implements IProvider {
  readonly id: LLMProvider = 'kimi';
  readonly models: IProviderModels = new KimiProviderModels();
  readonly auth: IProviderAuth = new KimiProviderAuth();
  readonly mcp = refusedMcp;
  readonly skills = refusedSkills;
  readonly sessions = refusedSessions;
  readonly sessionSynchronizer = inertSynchronizer;
}
