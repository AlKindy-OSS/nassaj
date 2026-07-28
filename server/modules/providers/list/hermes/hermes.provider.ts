import { AppError, buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';
import type {
  IProvider,
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  McpScope,
  NormalizedMessage,
  ProviderMcpServer,
  ProviderModelsDefinition,
  ProviderSkill,
  ProviderSkillCreateInput,
  ProviderSkillListOptions,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';

import { HermesProviderAuth } from './hermes-auth.provider.js';

const notSupported = (method: string): never => {
  throw new AppError(`Hermes provider: ${method} is not yet implemented.`, {
    code: 'NOT_IMPLEMENTED',
    statusCode: 501,
  });
};

// Hermes (Nous) routes to multiple upstream providers via OAuth. Model ids carry
// a `provider/model` prefix (mirrors opencode). The default is the free Nous tier
// model from ~/.hermes/config.yaml (`model.default`). The remaining entries are
// representative models from the live Nous/copilot caches; a fully dynamic
// catalog (reading ~/.hermes/*cache*.json) is deferred — this static list keeps
// the picker correct and selectable without an extra runtime dependency.
export const HERMES_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'nous/stepfun/step-3.7-flash:free', label: 'Step 3.7 Flash (free)', description: 'nous — default free tier' },
    { value: 'nous/deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'nous' },
    { value: 'nous/glm-5.2', label: 'GLM 5.2', description: 'nous' },
    { value: 'nous/kimi-k2.5', label: 'Kimi K2.5', description: 'nous' },
    { value: 'nous/minimax-m3', label: 'MiniMax M3', description: 'nous' },
    { value: 'nous/qwen3-coder:480b', label: 'Qwen3 Coder 480B', description: 'nous' },
    { value: 'copilot/claude-opus-4.8', label: 'Claude Opus 4.8', description: 'copilot' },
    { value: 'copilot/claude-sonnet-4.6', label: 'Claude Sonnet 4.6', description: 'copilot' },
    { value: 'copilot/gpt-5.5', label: 'GPT-5.5', description: 'copilot' },
    { value: 'copilot/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', description: 'copilot' },
  ],
  DEFAULT: 'nous/stepfun/step-3.7-flash:free',
};

class HermesModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> { return HERMES_FALLBACK_MODELS; }
  async getCurrentActiveModel() { return buildDefaultProviderCurrentActiveModel(HERMES_FALLBACK_MODELS); }
  async changeActiveModel() { return notSupported('changeActiveModel'); }
}

class HermesMcp implements IProviderMcp {
  async listServers(): Promise<Record<McpScope, ProviderMcpServer[]>> {
    return { user: [], local: [], project: [] };
  }
  async listServersForScope(): Promise<ProviderMcpServer[]> { return []; }
  async upsertServer(_input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer> {
    return notSupported('upsertServer');
  }
  async removeServer() { return notSupported('removeServer'); }
}

class HermesSkills implements IProviderSkills {
  async listSkills(_options?: ProviderSkillListOptions): Promise<ProviderSkill[]> { return []; }
  async addSkills(_input: ProviderSkillCreateInput): Promise<ProviderSkill[]> {
    return notSupported('addSkills');
  }
  async removeSkill(_directoryName: string): Promise<ProviderSkill> {
    return notSupported('removeSkill');
  }
}

class HermesSessions implements IProviderSessions {
  normalizeMessage(_raw: unknown, _sessionId: string | null): NormalizedMessage[] { return []; }
  async fetchHistory(_sessionId: string, _options?: FetchHistoryOptions): Promise<FetchHistoryResult> {
    return notSupported('fetchHistory');
  }
}

class HermesSessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(): Promise<number> { return 0; }
  async synchronizeFile(): Promise<string | null> { return null; }
}

export class HermesProvider implements IProvider {
  readonly id = 'hermes' as const;
  readonly auth: IProviderAuth = new HermesProviderAuth();
  readonly models: IProviderModels = new HermesModels();
  readonly mcp: IProviderMcp = new HermesMcp();
  readonly skills: IProviderSkills = new HermesSkills();
  readonly sessions: IProviderSessions = new HermesSessions();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new HermesSessionSynchronizer();
}
