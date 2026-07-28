/**
 * claude-credentials.writer — T-866/B3: writes a user's Anthropic API key into
 * `<CLAUDE_CONFIG_DIR>/settings.json` under `env.ANTHROPIC_API_KEY` — the exact
 * location Claude Code itself reads and claude-auth.provider.ts already checks
 * (loadSettingsEnv → 'api_key'). CLAUDE_CONFIG_DIR is resolved through the
 * central isolation seam (resolveProviderEnv), so an isolated user's key lands
 * in ~/.nassaj-users/<userId>/.claude/settings.json and never the operator's.
 *
 * Writes MERGE: settings.json commonly carries theme/permissions/other env
 * entries — only `env.ANTHROPIC_API_KEY` is ever added/removed, everything
 * else is preserved. Writes are atomic (tmp+rename, 0600/0700); a corrupt file
 * degrades to "not configured" on read (and is replaced wholesale on write,
 * since an unparseable settings file is unusable to the CLI anyway).
 *
 * IRON RULE (commit beaee8f covers the spawn seam; this is the write-side
 * mirror): this writer must NEVER write any `*_BASE_URL` env key. The tripwire
 * below asserts, on every write, that the set of env keys actually changed is
 * exactly the one key this writer manages — so no code path (present or
 * future) can smuggle a base-URL override into settings.json through here.
 */

import os from 'node:os';
import path from 'node:path';

import {
  readJsonObjectOrEmpty,
  writeJsonObjectAtomic,
} from '@/modules/providers/shared/credentials/atomic-json-file.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import type {
  IProviderCredentialWriter,
  ProviderCredentialStatus,
  ProviderCredentialWriterCapability,
} from '@/shared/interfaces.js';
import { AppError, readObjectRecord, readOptionalString } from '@/shared/utils.js';

/** The single settings env key this writer manages. */
const MANAGED_ENV_KEY = 'ANTHROPIC_API_KEY';

/**
 * IRON-RULE tripwire: refuses any write whose changed env keys include a
 * `*_BASE_URL` key or anything beyond the single managed key. Exported for
 * direct test coverage (B3 acceptance).
 */
export function assertOnlyManagedEnvKeyChanged(changedKeys: readonly string[]): void {
  for (const key of changedKeys) {
    if (/_BASE_URL$/i.test(key)) {
      throw new Error(
        `IRON RULE violation: refusing to write env key "${key}" to Claude settings.json`,
      );
    }
    if (key !== MANAGED_ENV_KEY) {
      throw new Error(
        `claude-credentials.writer attempted to change unmanaged env key "${key}" — refused`,
      );
    }
  }
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
   * settings.json path inside the user's resolved Claude config dir — the same
   * resolution claude-auth.provider.ts uses (CLAUDE_CONFIG_DIR when isolated,
   * operator ~/.claude when shared/anonymous).
   */
  private settingsFilePath(userId: string | number | null | undefined): string {
    const env = resolveProviderEnv(userId ?? null, 'claude', process.env);
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

  async setApiKey(
    userId: string | number | null | undefined,
    apiKey: string,
    target?: string,
  ): Promise<ProviderCredentialStatus> {
    this.rejectTarget(target);
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new AppError('API key is required and must not be empty.', {
        code: 'INVALID_API_KEY',
        statusCode: 400,
      });
    }
    const filePath = this.settingsFilePath(userId);
    const settings = readJsonObjectOrEmpty(filePath);
    const previousEnv = readObjectRecord(settings.env) ?? {};
    const nextEnv = { ...previousEnv, [MANAGED_ENV_KEY]: apiKey.trim() };
    this.writeSettingsEnv(filePath, settings, previousEnv, nextEnv);
    return { provider: 'claude', configured: true };
  }

  async deleteApiKey(
    userId: string | number | null | undefined,
    target?: string,
  ): Promise<ProviderCredentialStatus> {
    this.rejectTarget(target);
    const filePath = this.settingsFilePath(userId);
    const settings = readJsonObjectOrEmpty(filePath);
    const previousEnv = readObjectRecord(settings.env) ?? {};
    if (Object.prototype.hasOwnProperty.call(previousEnv, MANAGED_ENV_KEY)) {
      const nextEnv = { ...previousEnv };
      delete nextEnv[MANAGED_ENV_KEY];
      this.writeSettingsEnv(filePath, settings, previousEnv, nextEnv);
    }
    return { provider: 'claude', configured: false };
  }

  async isConfigured(
    userId: string | number | null | undefined,
    target?: string,
  ): Promise<boolean> {
    this.rejectTarget(target);
    const settings = readJsonObjectOrEmpty(this.settingsFilePath(userId));
    const env = readObjectRecord(settings.env) ?? {};
    return readOptionalString(env[MANAGED_ENV_KEY]) !== undefined;
  }
}
