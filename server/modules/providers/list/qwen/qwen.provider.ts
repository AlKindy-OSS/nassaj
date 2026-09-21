import path from 'node:path';

import {
  providerSecretsService,
  type QwenPlan,
} from '@/modules/providers/services/provider-secrets.service.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import { VendorMcpProvider } from '@/modules/providers/shared/vendor/vendor-mcp.provider.js';
import { VendorSessionSynchronizer } from '@/modules/providers/shared/vendor/vendor-session-synchronizer.provider.js';
import { VendorSessionsProvider } from '@/modules/providers/shared/vendor/vendor-sessions.provider.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import type {
  IProviderAuth,
  IProviderModels,
} from '@/shared/interfaces.js';
import type {
  ProviderModelsDefinition,
  ProviderSkillSource,
  ProviderAuthStatus,
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  isCliInstalled,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

/** Coding Plan models documented by Qwen Code's current authentication guide. */
export const QWEN_CODING_PLAN_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus' },
    { value: 'qwen3-coder-next', label: 'Qwen3 Coder Next' },
    { value: 'qwen3.7-plus', label: 'Qwen3.7 Plus' },
    { value: 'qwen3.6-plus', label: 'Qwen3.6 Plus' },
    { value: 'qwen3.5-plus', label: 'Qwen3.5 Plus' },
    { value: 'qwen3-max-2026-01-23', label: 'Qwen3 Max' },
    { value: 'glm-5', label: 'GLM-5' },
    { value: 'glm-4.7', label: 'GLM-4.7' },
    { value: 'kimi-k2.5', label: 'Kimi K2.5' },
    { value: 'MiniMax-M2.5', label: 'MiniMax M2.5' },
  ],
  DEFAULT: 'qwen3-coder-plus',
};

/** Token Plan catalog shipped by Qwen Code 0.21.11. */
export const QWEN_TOKEN_PLAN_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'qwen3.7-plus', label: 'Qwen3.7 Plus' },
    { value: 'qwen3.6-plus', label: 'Qwen3.6 Plus' },
    { value: 'qwen3.7-max', label: 'Qwen3.7 Max' },
    { value: 'qwen3.8-max-preview', label: 'Qwen3.8 Max Preview' },
    { value: 'qwen3.6-flash', label: 'Qwen3.6 Flash' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { value: 'deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash' },
    { value: 'deepseek-v3.2', label: 'DeepSeek V3.2' },
    { value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
    { value: 'kimi-k2.6', label: 'Kimi K2.6' },
    { value: 'kimi-k2.5', label: 'Kimi K2.5' },
    { value: 'glm-5.2', label: 'GLM-5.2' },
    { value: 'glm-5.1', label: 'GLM-5.1' },
    { value: 'glm-5', label: 'GLM-5' },
    { value: 'MiniMax-M2.5', label: 'MiniMax M2.5' },
  ],
  DEFAULT: 'qwen3.7-plus',
};

export function qwenModelsForPlan(plan: QwenPlan): ProviderModelsDefinition {
  return plan === 'token_plan' ? QWEN_TOKEN_PLAN_MODELS : QWEN_CODING_PLAN_MODELS;
}

class QwenModels implements IProviderModels {
  async getSupportedModels(userId?: string | number | null): Promise<ProviderModelsDefinition> {
    const plan = providerSecretsService.getQwenProfile(userId)?.plan ?? 'coding_plan';
    return qwenModelsForPlan(plan);
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(QWEN_CODING_PLAN_MODELS);
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('qwen', input);
  }
}

class QwenAuth implements IProviderAuth {
  isInstalled(): boolean {
    return isCliInstalled(process.env.QWEN_PATH?.trim() || 'qwen');
  }

  async getStatus(userId?: string | number | null): Promise<ProviderAuthStatus> {
    const installed = this.isInstalled();
    const profile = providerSecretsService.getQwenProfile(userId);
    const usable = installed && Boolean(profile);
    return {
      provider: 'qwen',
      installed,
      authenticated: usable,
      email: usable
        ? (profile?.plan === 'token_plan' ? 'Alibaba Token Plan' : 'Alibaba Coding Plan')
        : null,
      method: usable ? profile?.plan ?? null : null,
      error: !installed
        ? 'Qwen Code CLI is not installed'
        : profile ? undefined : 'Alibaba ModelStudio key is not configured',
    };
  }
}

class QwenSkills extends SkillsProvider {
  constructor() {
    super('qwen');
  }

  private homeFor(userId?: string | number | null): string {
    return resolveProviderEnv(userId ?? null, 'qwen', process.env).HOME ?? process.cwd();
  }

  protected async getSkillSources(
    workspacePath: string,
    userId?: string | number | null,
  ): Promise<ProviderSkillSource[]> {
    return [
      { scope: 'user', rootDir: path.join(this.homeFor(userId), '.qwen', 'skills'), commandPrefix: '/' },
      { scope: 'user', rootDir: path.join(this.homeFor(userId), '.agents', 'skills'), commandPrefix: '/' },
      { scope: 'project', rootDir: path.join(workspacePath, '.qwen', 'skills'), commandPrefix: '/' },
      { scope: 'project', rootDir: path.join(workspacePath, '.agents', 'skills'), commandPrefix: '/' },
    ];
  }

  protected async getGlobalSkillSource(userId?: string | number | null): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(this.homeFor(userId), '.qwen', 'skills'),
      commandPrefix: '/',
    };
  }
}

export class QwenProvider extends AbstractProvider {
  readonly models = new QwenModels();
  readonly auth = new QwenAuth();
  readonly mcp = new VendorMcpProvider('qwen');
  readonly skills = new QwenSkills();
  readonly sessions = new VendorSessionsProvider({ provider: 'qwen' });
  readonly sessionSynchronizer = new VendorSessionSynchronizer('qwen');

  constructor() {
    super('qwen');
  }
}
