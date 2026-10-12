/**
 * harness-credential-inventory — ADR-200 S4: what credentials sit in ONE
 * member's own Claude or Codex tree, and which of them the CLI actually runs on.
 *
 * Read-only. It resolves the caller's OWN tree (`honorGrants: false`, as the
 * writers do, B-1251): a link mode belongs to the account that owns the files,
 * and a grantee's view of a grantor's tree is the grantor's business.
 *
 * The raw values it returns (`managedKey`, `subscriptionIdentity`) never leave
 * the server: the link-mode service only fingerprints or compares them.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hasCodexOAuthTokens, resolveCodexEffectiveAuth } from '@/modules/providers/list/codex/codex-auth.provider.js';
import { operatorCodexHome } from '@/modules/providers/list/codex/codex-home.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

export type LinkHarness = 'claude' | 'codex';
export type EffectiveLinkMode = 'api_key' | 'subscription' | 'none';

export type HarnessCredentialInventory = {
  harness: LinkHarness;
  /** The key nassaj's writer manages (settings `ANTHROPIC_API_KEY`, auth.json `OPENAI_API_KEY`). */
  managedKey: string | null;
  /** A key from a source the writer cannot remove (spawn env, `ANTHROPIC_AUTH_TOKEN`). */
  unmanagedKeySource: string | null;
  /** Whether a subscription credential is present at all. */
  hasSubscription: boolean;
  /** Stable material identifying the current subscription login, for fresh-login detection. */
  subscriptionIdentity: string | null;
  /** The credential the CLI runs on under its own precedence. */
  effective: EffectiveLinkMode;
};

type OwnEnv = NodeJS.ProcessEnv;

function ownEnv(userId: string | number | null | undefined, harness: LinkHarness): OwnEnv {
  return resolveProviderEnv(userId ?? null, harness, process.env, 'chat', { honorGrants: false });
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  try {
    return readObjectRecord(JSON.parse(fs.readFileSync(filePath, 'utf8'))) ?? {};
  } catch {
    return {};
  }
}

/** `.credentials.json` login identity: the refresh token outlives access-token rotation. */
function readClaudeOauthIdentity(configDir: string): string | null {
  const creds = readJsonRecord(path.join(configDir, '.credentials.json'));
  const oauth = readObjectRecord(creds.claudeAiOauth) ?? {};
  if (!readOptionalString(oauth.accessToken)) return null;
  return readOptionalString(oauth.refreshToken) ?? readOptionalString(oauth.accessToken) ?? null;
}

/**
 * Claude precedence, MEASURED on the wire (claude-auth.precedence.header-echo
 * test): any `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, from the spawn env
 * or from settings.env, beats any OAuth credential (env or settings
 * `CLAUDE_CODE_OAUTH_TOKEN`, then `.credentials.json`). Exported for that test.
 */
export function readClaudeInventoryFromEnv(env: OwnEnv): HarnessCredentialInventory {
  const configDir = readOptionalString(env.CLAUDE_CONFIG_DIR) ?? path.join(os.homedir(), '.claude');
  const settingsEnv = readObjectRecord(readJsonRecord(path.join(configDir, 'settings.json')).env) ?? {};
  const managedKey = readOptionalString(settingsEnv.ANTHROPIC_API_KEY) ?? null;
  const setupToken = readOptionalString(settingsEnv.CLAUDE_CODE_OAUTH_TOKEN) ?? null;
  const fileIdentity = readClaudeOauthIdentity(configDir);
  const envSource = (['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const)
    .find((name) => readOptionalString(env[name]));
  const unmanagedKeySource = envSource
    ? `env:${envSource}`
    : readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN) ? 'settings:ANTHROPIC_AUTH_TOKEN' : null;
  const envOauth = readOptionalString(env.CLAUDE_CODE_OAUTH_TOKEN) ?? null;
  const subscriptionIdentity = envOauth ?? setupToken ?? fileIdentity;

  let effective: EffectiveLinkMode = 'none';
  if (managedKey || unmanagedKeySource) effective = 'api_key';
  else if (subscriptionIdentity) effective = 'subscription';

  return {
    harness: 'claude',
    managedKey,
    unmanagedKeySource,
    hasSubscription: subscriptionIdentity !== null,
    subscriptionIdentity,
    effective,
  };
}

/** Codex: auth.json under the caller's own CODEX_HOME, precedence per S3. */
function readCodexInventory(env: OwnEnv): HarnessCredentialInventory {
  const codexHome = readOptionalString(env.CODEX_HOME) ?? operatorCodexHome();
  const auth = readJsonRecord(path.join(codexHome, 'auth.json'));
  const tokens = readObjectRecord(auth.tokens) ?? {};
  const hasSubscription = hasCodexOAuthTokens(auth);
  const subscriptionIdentity = hasSubscription
    ? readOptionalString(tokens.refresh_token)
      ?? readOptionalString(tokens.account_id)
      ?? readOptionalString(tokens.id_token)
      ?? readOptionalString(tokens.access_token)
      ?? null
    : null;
  return {
    harness: 'codex',
    managedKey: readOptionalString(auth.OPENAI_API_KEY) ?? null,
    unmanagedKeySource: null,
    hasSubscription,
    subscriptionIdentity,
    effective: resolveCodexEffectiveAuth(auth),
  };
}

/** Reads the caller's own credential inventory for one link-mode harness. */
export function readHarnessCredentialInventory(
  userId: string | number | null | undefined,
  harness: LinkHarness,
): HarnessCredentialInventory {
  const env = ownEnv(userId, harness);
  return harness === 'claude' ? readClaudeInventoryFromEnv(env) : readCodexInventory(env);
}
