import { AppError } from '@/shared/utils.js';
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
  McpScope,
  ProviderMcpServer,
  ProviderModelsDefinition,
  ProviderSkill,
  ProviderSkillCreateInput,
  ProviderSkillListOptions,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';

import { VendorSessionsProvider } from '../../shared/vendor/vendor-sessions.provider.js';

import { HermesProviderAuth } from './hermes-auth.provider.js';
import { readHermesCachedModels, readHermesRuntimeConfig } from './hermes-runtime.js';

const notSupported = (method: string): never => {
  throw new AppError(`Hermes provider: ${method} is not yet implemented.`, {
    code: 'NOT_IMPLEMENTED',
    statusCode: 501,
  });
};

/**
 * The catalog is HERMES' OWN (B-403), not ours: the model ids for the provider
 * named in `~/.hermes/config.yaml`, read from hermes' live cache, bare and
 * unprefixed exactly as `-m` requires. The previous static list carried invented
 * `provider/model` ids that no endpoint accepts — see hermes-runtime.ts for the
 * measurements. An empty catalog is the honest answer when hermes' own files are
 * unreadable: the spawn then passes no `-m` at all and hermes uses its config,
 * which is the one path that cannot be wrong.
 */
export const HERMES_EMPTY_MODELS: ProviderModelsDefinition = { OPTIONS: [], DEFAULT: '' };

export async function buildHermesModelCatalog(): Promise<ProviderModelsDefinition> {
  const { provider, defaultModel } = await readHermesRuntimeConfig();
  const cached = await readHermesCachedModels(provider);

  const ids = [...new Set([...(defaultModel ? [defaultModel] : []), ...cached])];
  if (ids.length === 0) {
    return HERMES_EMPTY_MODELS;
  }

  return {
    OPTIONS: ids.map((value) => ({
      value,
      label: value,
      description: provider ?? undefined,
    })),
    DEFAULT: defaultModel ?? ids[0],
  };
}

class HermesModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> { return buildHermesModelCatalog(); }

  async getCurrentActiveModel() {
    const catalog = await buildHermesModelCatalog();
    return { model: catalog.DEFAULT };
  }

  // The per-session pin lives in nassaj's own provider-agnostic change store —
  // hermes has no active-model command of its own, so the service layer routes
  // around this refusal instead of surfacing a 501 to the picker (T-1198).
  async changeActiveModel() { return notSupported('changeActiveModel'); }
}

class HermesMcp implements IProviderMcp {
  /** Hermes exposes no MCP store; every write is refused before any path is built. */
  readonly writesPerUserConfig = false;

  /** No MCP surface at all — not merely a shared one. */
  readonly supportsMcp = false;

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

/**
 * History for hermes reads the transcript NASSAJ owns, not hermes' own store.
 *
 * B-599 — this facet used to return `[]` and throw 501, so a hermes conversation
 * opened blank: the session row existed, the sidebar listed it, and the messages
 * were nowhere nassaj could read. Hermes does keep its own `state.db`, but it
 * cannot answer "show me this conversation": `hermes -z` has no resume flag, so
 * every TURN is a separate hermes session under its own timestamp id, and the
 * conversation the user sees on screen exists only as nassaj's stitching of
 * those turns. Reconstructing it from hermes' store would mean guessing which
 * timestamps belong together — a heuristic standing in for a fact we can simply
 * record.
 *
 * So hermes joins kimi/deepseek/glm on the nassaj-owned JSONL transcript: the
 * run seam in `hermes-cli.js` appends each turn, and this class reads it back
 * through the shared vendor implementation unchanged. Hermes is a CLI rather
 * than an HTTP vendor, but the storage problem — a provider whose transcript we
 * cannot read back — is identical, and so is the answer.
 */
class HermesSessions extends VendorSessionsProvider {
  constructor() {
    super({ provider: 'hermes' });
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
