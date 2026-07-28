/**
 * opencode-credentials.writer — T-866/B2: writes a user's API key into
 * opencode's OWN auth store, `<dataHome>/auth.json`, where `dataHome` is
 * resolved through the central isolation seam (resolveOpenCodeDataHomeForUser →
 * resolveProviderEnv). Under isolation that is
 * `~/.nassaj-users/<userId>/.local/share/opencode/auth.json`; in shared mode it
 * is the operator's dir (the api-key routes gate shared writes to admin/owner).
 *
 * auth.json record shape is opencode's native `{ "<target>": { "type": "api",
 * "key": "..." } }`. Writes MERGE: only the requested target is touched, every
 * other provider entry in the file is preserved byte-for-byte; deletes remove
 * the one target only. Writes are atomic (tmp+rename, 0600/0700) and a corrupt
 * file degrades to "not configured". The key value is never logged or echoed.
 */

import path from 'node:path';

import {
  readJsonObjectOrEmpty,
  writeJsonObjectAtomic,
} from '@/modules/providers/shared/credentials/atomic-json-file.js';
import type {
  IProviderCredentialWriter,
  ProviderCredentialStatus,
  ProviderCredentialWriterCapability,
} from '@/shared/interfaces.js';
import { AppError, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { resolveOpenCodeDataHomeForUser } from './opencode-home.js';

/**
 * Internal targets this writer accepts — the opencode provider ids whose keys
 * we support configuring from the app. 'anthropic' is the default target.
 *
 * 'glm' (GL-1 / ADR-062, OCC-2 mode (a)) is the id of opencode's *custom*
 * provider that carries GLM via api.z.ai — on the OpenAI-compatible coding-plan
 * wire since B-221 (2026-07-27); see OPENCODE_GLM_NPM in
 * services/isolation/opencode-config-material.js. It is deliberately NOT
 * 'anthropic' — that id collides with opencode's built-in provider. Its key is
 * written as an ordinary `{ glm: { type: 'api', key } }` entry into the very
 * same per-user, cage-covered `<dataHome>/auth.json`; no new file is created.
 * The target name is unchanged by the wire switch, so existing keys keep working.
 */
export const OPENCODE_CREDENTIAL_TARGETS = Object.freeze([
  'anthropic',
  'openai',
  'openrouter',
  'glm',
]);

const DEFAULT_TARGET = 'anthropic';

export class OpenCodeCredentialsWriter implements IProviderCredentialWriter {
  getWriterCapability(): ProviderCredentialWriterCapability {
    return { method: 'native_file', targets: OPENCODE_CREDENTIAL_TARGETS };
  }

  /** Validates and defaults the target; unknown targets are a 400. */
  private resolveTarget(target?: string): string {
    if (target === undefined || target === '') {
      return DEFAULT_TARGET;
    }
    if (!OPENCODE_CREDENTIAL_TARGETS.includes(target)) {
      throw new AppError(`Unsupported opencode credential target "${target}".`, {
        code: 'INVALID_CREDENTIAL_TARGET',
        statusCode: 400,
      });
    }
    return target;
  }

  /** auth.json path inside the user's resolved opencode data home. */
  private authFilePath(userId: string | number | null | undefined): string {
    return path.join(resolveOpenCodeDataHomeForUser(userId ?? null), 'auth.json');
  }

  async setApiKey(
    userId: string | number | null | undefined,
    apiKey: string,
    target?: string,
  ): Promise<ProviderCredentialStatus> {
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new AppError('API key is required and must not be empty.', {
        code: 'INVALID_API_KEY',
        statusCode: 400,
      });
    }
    const resolvedTarget = this.resolveTarget(target);
    const filePath = this.authFilePath(userId);
    // Merge: read-modify-write so entries for OTHER opencode providers survive.
    const auth = readJsonObjectOrEmpty(filePath);
    auth[resolvedTarget] = { type: 'api', key: apiKey.trim() };
    writeJsonObjectAtomic(filePath, auth);
    return { provider: 'opencode', configured: true };
  }

  async deleteApiKey(
    userId: string | number | null | undefined,
    target?: string,
  ): Promise<ProviderCredentialStatus> {
    const resolvedTarget = this.resolveTarget(target);
    const filePath = this.authFilePath(userId);
    const auth = readJsonObjectOrEmpty(filePath);
    if (Object.prototype.hasOwnProperty.call(auth, resolvedTarget)) {
      delete auth[resolvedTarget];
      // Only rewrite when something changed — never create a file on delete.
      writeJsonObjectAtomic(filePath, auth);
    }
    return { provider: 'opencode', configured: false };
  }

  async isConfigured(
    userId: string | number | null | undefined,
    target?: string,
  ): Promise<boolean> {
    const resolvedTarget = this.resolveTarget(target);
    const auth = readJsonObjectOrEmpty(this.authFilePath(userId));
    const record = readObjectRecord(auth[resolvedTarget]);
    return readOptionalString(record?.key) !== undefined;
  }
}
