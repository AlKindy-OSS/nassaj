import { isProviderGloballyDisabled } from '../../../shared/disabledProviders';
import { SESSION_BUCKET_PROVIDERS } from '../../../shared/sessionBuckets';
import type { AgentProvider, SettingsDeepLink } from '../settings/types/types';

/**
 * CREDENTIAL_NOT_LINKED (ADR-152 A1 §3.5, T-2083): a model run was refused
 * before any process started because the member has no credential of their own
 * for that provider and no usable grant. The refusal reaches the UI on several
 * surfaces with two shapes:
 *
 *   • code + `credential` at the root — chat WS `complete`, `/btw` `btw-error`,
 *     `message-fork-error`, REST `/api/agent` 409;
 *   • the payload spread into `error` — `POST /api/workflow-supervisor/launch`.
 *
 * Any of them may arrive with the code alone (an older or degraded sender), so
 * the reader always yields a renderable value for the code.
 */
export const CREDENTIAL_NOT_LINKED = 'CREDENTIAL_NOT_LINKED';

export type CredentialNotLinkedReason = 'not_linked' | 'grantor_not_linked';

export type CredentialNotLinkedInfo = {
  /** UI provider id of the credential that is missing; `null` when not named. */
  provider: string | null;
  reason: CredentialNotLinkedReason;
  /** Only for `grantor_not_linked`: the member whose shared credential is gone. */
  grantorUsername: string | null;
  /** The agent page the server points at (`settingsAnchor: 'agents/<id>'`). */
  settingsAgent: AgentProvider | null;
};

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_USERNAME = 64;
const AGENTS: ReadonlySet<string> = new Set(SESSION_BUCKET_PROVIDERS);

type Bag = Record<string, unknown>;
const asBag = (value: unknown): Bag | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Bag : null
);

/** The object carrying the payload fields, or null when `source` is not this refusal. */
function payloadOf(source: unknown): Bag | null {
  const root = asBag(source);
  if (!root) return null;
  const nested = asBag(root.error);
  if (root.code === CREDENTIAL_NOT_LINKED) return asBag(root.credential) ?? {};
  if (nested?.code === CREDENTIAL_NOT_LINKED) return asBag(nested.credential) ?? nested;
  return null;
}

function readUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_USERNAME ? trimmed : null;
}

function readAnchorAgent(value: unknown): AgentProvider | null {
  if (typeof value !== 'string') return null;
  const match = /^agents\/([a-z][a-z0-9-]{0,31})$/.exec(value);
  return match && AGENTS.has(match[1]) ? match[1] as AgentProvider : null;
}

/** The refusal in renderable form, or `null` when `source` carries another code. */
export function readCredentialNotLinked(source: unknown): CredentialNotLinkedInfo | null {
  const payload = payloadOf(source);
  if (!payload) return null;
  const provider = typeof payload.provider === 'string' && PROVIDER_ID.test(payload.provider)
    ? payload.provider : null;
  const grantorUsername = payload.reason === 'grantor_not_linked'
    ? readUsername(payload.grantorUsername) : null;
  const anchorAgent = readAnchorAgent(payload.settingsAnchor);
  return {
    provider,
    reason: grantorUsername ? 'grantor_not_linked' : 'not_linked',
    grantorUsername,
    settingsAgent: anchorAgent ?? (provider && AGENTS.has(provider) ? provider as AgentProvider : null),
  };
}

export type CredentialDestinations = {
  linkOwn: SettingsDeepLink;
  /** `null` when the provider has no grant section to open (no agent page). */
  requestShare: SettingsDeepLink | null;
};

/**
 * Where "link my account" and "ask a member to share" lead. The grant section
 * lives on the agent's Account tab; a provider whose agent page is hidden (a
 * hosted engine such as GLM) is linked on the vendors page and offers no share
 * path, since the UI has nowhere to show one.
 */
export function resolveCredentialDestinations(info: CredentialNotLinkedInfo): CredentialDestinations {
  const agent = info.settingsAgent;
  if (agent && isProviderGloballyDisabled(agent)) {
    return { linkOwn: { tab: 'vendors' }, requestShare: null };
  }
  const account: SettingsDeepLink = agent
    ? { tab: 'agents', agent, category: 'account' }
    : { tab: 'agents', category: 'account' };
  return { linkOwn: account, requestShare: { ...account, section: 'credential-grants' } };
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
  agy: 'Antigravity',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  qwen: 'Qwen',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  hermes: 'Hermes',
  sakana: 'Sakana',
};

/** Brand name for a provider id (identical in every locale); `null` stays `null`. */
export function credentialProviderName(provider: string | null): string | null {
  if (!provider) return null;
  return PROVIDER_NAMES[provider] ?? provider;
}
