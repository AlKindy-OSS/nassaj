/**
 * claude-credentials.writer — T-866/B3: writes a user's Claude credential into
 * `<CLAUDE_CONFIG_DIR>/settings.json` — the exact location Claude Code itself
 * reads and claude-auth.provider.ts already checks (loadSettingsEnv). Two
 * credential shapes are managed, mirroring the CLI's own precedence:
 *   - a plain API key → `env.ANTHROPIC_API_KEY`;
 *   - a `claude setup-token` OAuth token (prefix `sk-ant-oat01-`, B-1075) →
 *     `env.CLAUDE_CODE_OAUTH_TOKEN`.
 * The two are mutually exclusive: writing one removes the other, so the CLI
 * never sees a stale credential of the opposite kind. CLAUDE_CONFIG_DIR is
 * resolved through the central isolation seam (resolveProviderEnv), so an
 * isolated user's credential lands in ~/.nassaj-users/<userId>/.claude/
 * settings.json and never the operator's.
 *
 * Writes MERGE: settings.json commonly carries theme/permissions/other env
 * entries — only the two managed keys are ever added/removed, everything else
 * is preserved. Writes are atomic (tmp+rename, 0600/0700); a corrupt file
 * degrades to "not configured" on read (and is replaced wholesale on write,
 * since an unparseable settings file is unusable to the CLI anyway).
 *
 * IRON RULE (commit beaee8f covers the spawn seam; this is the write-side
 * mirror): this writer must NEVER write any `*_BASE_URL` env key. The tripwire
 * below asserts, on every write, that every env key actually changed is one of
 * the two managed keys — so no code path (present or future) can smuggle a
 * base-URL override (or any other key) into settings.json through here.
 */

import os from 'node:os';
import path from 'node:path';

import {
  readJsonObjectOrEmpty,
  writeJsonObjectAtomic,
} from '@/modules/providers/shared/credentials/atomic-json-file.js';
import { SUBSCRIPTION_TOKEN_PREFIX } from '@/modules/providers/shared/credentials/subscription-token-guard.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import type {
  IProviderCredentialWriter,
  ProviderCredentialStatus,
  ProviderCredentialWriterCapability,
} from '@/shared/interfaces.js';
import { AppError, readObjectRecord, readOptionalString } from '@/shared/utils.js';

/** Settings env key for a plain Anthropic API key. */
const MANAGED_API_KEY = 'ANTHROPIC_API_KEY';
/** Settings env key for a `claude setup-token` OAuth token (B-1075). */
const MANAGED_OAUTH_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';
/** The exact set of env keys this writer is permitted to add or remove. */
const MANAGED_ENV_KEYS = [MANAGED_API_KEY, MANAGED_OAUTH_KEY] as const;
/** Prefix that marks a value as a `claude setup-token` OAuth token, not an API key. */
const OAUTH_SETUP_TOKEN_PREFIX = SUBSCRIPTION_TOKEN_PREFIX;

/**
 * IRON-RULE tripwire: refuses any write whose changed env keys include a
 * `*_BASE_URL` key or anything beyond the two managed credential keys. Exported
 * for direct test coverage (B3 acceptance).
 */
export function assertOnlyManagedEnvKeyChanged(changedKeys: readonly string[]): void {
  const managed: readonly string[] = MANAGED_ENV_KEYS;
  for (const key of changedKeys) {
    if (/_BASE_URL$/i.test(key)) {
      throw new Error(
        `IRON RULE violation: refusing to write env key "${key}" to Claude settings.json`,
      );
    }
    if (!managed.includes(key)) {
      throw new Error(
        `claude-credentials.writer attempted to change unmanaged env key "${key}" — refused`,
      );
    }
  }
}

/** The managed env key a value belongs under: OAuth token by prefix, else API key. */
function managedKeyFor(value: string): typeof MANAGED_API_KEY | typeof MANAGED_OAUTH_KEY {
  return value.startsWith(OAUTH_SETUP_TOKEN_PREFIX) ? MANAGED_OAUTH_KEY : MANAGED_API_KEY;
}

/** Env keys that differ (added, removed or modified) between two env records. */
function diffEnvKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]);
}

export class ClaudeCredentialsWriter implements IProviderCredentialWriter {
  getWriterCapability(): ProviderCredentialWriterCapability {
    // Single implicit target (the Anthropic API key) — no `targets` list.
    return { method: 'native_file' };
  }

  /** Claude has exactly one credential target; any explicit target is a 400. */
  private rejectTarget(target?: string): void {
    if (target !== undefined && target !== '') {
      throw new AppError(`Provider "claude" does not support credential targets.`, {
        code: 'INVALID_CREDENTIAL_TARGET',
        statusCode: 400,
      });
    }
  }

  /**
   * settings.json path inside the CALLER'S OWN resolved Claude config dir
   * (CLAUDE_CONFIG_DIR when isolated, operator ~/.claude when shared/anonymous).
   *
   * B-1251 — `honorGrants: false` is load-bearing, not a style choice. The
   * resolver defaults `honorGrants` to TRUE, which is right for a SPAWN (a
   * grantee's turn must run on the grantor's credential) and catastrophic for a
   * WRITE: member B holding a grant from A would have their personal `claude
   * setup-token` written into A's settings.json, erasing A's credential and
   * silently putting A — and every other grantee of A — on B's personal
   * subscription. A credential write is an act on one's OWN account, so this
   * writer always resolves the caller's own tree.
   *
   * The same path serves setApiKey, deleteApiKey and isConfigured, and all three
   * are deliberate: a DELETE must never remove the grantor's credential, and
   * STATUS must describe the tree the write/delete actually touches — otherwise
   * B sees "connected" (A's key) and a delete that changes nothing. It also puts
   * this writer back in agreement with claude-onboarding.service, which already
   * reports on the member's own tree (userConfigDir(userId, '.claude')).
   */
  private settingsFilePath(userId: string | number | null | undefined): string {
    const env = resolveProviderEnv(userId ?? null, 'claude', process.env, 'chat', {
      honorGrants: false,
    });
    const configDir = readOptionalString(env.CLAUDE_CONFIG_DIR)
      ?? path.join(os.homedir(), '.claude');
    return path.join(configDir, 'settings.json');
  }

  /** Merges a new env record into settings, enforcing the iron-rule tripwire. */
  private writeSettingsEnv(
    filePath: string,
    settings: Record<string, unknown>,
    previousEnv: Record<string, unknown>,
    nextEnv: Record<string, unknown>,
  ): void {
    assertOnlyManagedEnvKeyChanged(diffEnvKeys(previousEnv, nextEnv));
    const nextSettings: Record<string, unknown> = { ...settings };
    if (Object.keys(nextEnv).length > 0) {
      nextSettings.env = nextEnv;
    } else {
      delete nextSettings.env;
    }
    writeJsonObjectAtomic(filePath, nextSettings);
  }

  /**
   * Stores a Claude credential. A plain API key is written under
   * `ANTHROPIC_API_KEY`; a `claude setup-token` OAuth token (prefix
   * `sk-ant-oat01-`) under `CLAUDE_CODE_OAUTH_TOKEN`. Writing one removes the
   * other so the two never coexist. The secret value is never logged.
   */
  async setApiKey(
    userId: string | number | null | undefined,
    apiKey: string,
    target?: string,
  ): Promise<ProviderCredentialStatus> {
    this.rejectTarget(target);
    const value = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (value === '') {
      throw new AppError('API key is required and must not be empty.', {
        code: 'INVALID_API_KEY',
        statusCode: 400,
      });
    }
    const targetKey = managedKeyFor(value);
    const otherKey = targetKey === MANAGED_OAUTH_KEY ? MANAGED_API_KEY : MANAGED_OAUTH_KEY;
    const filePath = this.settingsFilePath(userId);
    const settings = readJsonObjectOrEmpty(filePath);
    const previousEnv = readObjectRecord(settings.env) ?? {};
    const nextEnv = { ...previousEnv, [targetKey]: value };
    delete nextEnv[otherKey]; // The two managed credentials are mutually exclusive.
    this.writeSettingsEnv(filePath, settings, previousEnv, nextEnv);
    return { provider: 'claude', configured: true };
  }

  /** Removes both managed credential keys (API key and OAuth token); other settings survive. */
  async deleteApiKey(
    userId: string | number | null | undefined,
    target?: string,
  ): Promise<ProviderCredentialStatus> {
    this.rejectTarget(target);
    const filePath = this.settingsFilePath(userId);
    const settings = readJsonObjectOrEmpty(filePath);
    const previousEnv = readObjectRecord(settings.env) ?? {};
    const nextEnv = { ...previousEnv };
    for (const key of MANAGED_ENV_KEYS) delete nextEnv[key];
    if (diffEnvKeys(previousEnv, nextEnv).length > 0) {
      this.writeSettingsEnv(filePath, settings, previousEnv, nextEnv);
    }
    return { provider: 'claude', configured: false };
  }

  /** Configured when either managed credential key (API key or OAuth token) is present. */
  async isConfigured(
    userId: string | number | null | undefined,
    target?: string,
  ): Promise<boolean> {
    this.rejectTarget(target);
    const settings = readJsonObjectOrEmpty(this.settingsFilePath(userId));
    const env = readObjectRecord(settings.env) ?? {};
    return MANAGED_ENV_KEYS.some((key) => readOptionalString(env[key]) !== undefined);
  }
}
