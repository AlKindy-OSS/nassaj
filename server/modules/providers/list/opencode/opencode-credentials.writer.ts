/**
 * opencode-credentials.writer — T-866/B2: writes a user's API key into
 * opencode's OWN auth store, `<dataHome>/auth.json`, where `dataHome` is
 * resolved through the central isolation seam (resolveOpenCodeDataHomeForUser →
 * resolveProviderEnv). For a signed-in user that is always their own
 * `~/.nassaj-users/<userId>/.local/share/opencode/auth.json` (ADR-152 A1).
 *
 * auth.json record shape is opencode's native `{ "<target>": { "type": "api",
 * "key": "..." } }`. Writes MERGE AT FILE LEVEL: only the requested target is
 * touched, every other provider entry is preserved byte-for-byte; deletes remove
 * the one target only. Writes are atomic (tmp+rename, 0600/0700) and a corrupt
 * file degrades to "not configured". The key value is never logged or echoed.
 *
 * Within a target the write REPLACES, which is intended for a key we stored and
 * destructive for a login we did not — see `assertNotOverwritingLogin` (B-377).
 */

import path from 'node:path';

import {
  readJsonObjectOrEmpty,
  writeJsonObjectAtomic,
} from '@/modules/providers/shared/credentials/atomic-json-file.js';
import { assertNotClaudeSubscriptionToken } from '@/modules/providers/shared/credentials/subscription-token-guard.js';
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

/**
 * B-377 — refuses to replace a record this app did not create.
 *
 * The write above merges at FILE level (other providers survive) but ASSIGNS at
 * TARGET level, so `auth[target] = {type:'api',...}` overwrites whatever stood
 * there. For a stored API key that is the intended "replace it by saving a new
 * one". For an `{"type":"oauth"}` record it is destruction: opencode's own
 * browser login carries a refresh token this app never held and cannot mint
 * again, so one paste silently signs the user out of a vendor with no way back.
 *
 * The existing tests only ever proved a DIFFERENT target survives, which is the
 * file-level property — the same-target case had no coverage at all, and the
 * header's "Writes MERGE" read as though it did.
 *
 * Fail-closed by shape, not by allow-list: anything present that is not
 * `type: 'api'` is refused, so an auth kind opencode adds later is protected
 * without an edit here. The error is a 409 because the caller can resolve it —
 * sign out inside opencode, then store a key.
 */
function assertNotOverwritingLogin(existing: unknown, target: string): void {
  const record = readObjectRecord(existing);
  if (!record) {
    return;
  }
  const type = readOptionalString(record.type);
  if (type !== undefined && type !== 'api') {
    throw new AppError(
      `The "${target}" entry in opencode is a ${type} login, not an API key. `
      + 'Sign out of it inside opencode first — nassaj will not overwrite a login it cannot restore.',
      { code: 'CREDENTIAL_IS_LOGIN', statusCode: 409 },
    );
  }
}

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

  /**
   * auth.json path inside the user's resolved opencode data home.
   *
   * Every write lands in the REQUESTER's own tree, whatever their role: opencode
   * is always isolated (ADR-152 A1), so no member's key is ever written into a
   * file another member's spawn reads, and no role may write another's tree.
   *
   * ── B-1251 (`honorGrants: false`) ─────────────────────────────────────────
   *
   * `resolveOpenCodeDataHomeForUser` defaults to honoring credential grants,
   * which is right for a SPAWN (a grantee's turn runs on the grantor's auth.json
   * through a grant home) and wrong for every act here. A member holding a grant
   * would otherwise write their personal vendor key into the GRANTOR's
   * auth.json — overwriting the grantor's own entry for that target — and
   * "remove my key" would remove the grantor's. Reads follow the same tree so
   * the status a member sees describes the file their save and delete touch.
   */
  private authFilePath(userId: string | number | null | undefined): string {
    return path.join(
      resolveOpenCodeDataHomeForUser(userId ?? null, { honorGrants: false }),
      'auth.json',
    );
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
    // B-1252: a personal Claude subscription token is not an API key and must
    // never be written into opencode's auth.json (its `anthropic` target most of
    // all). Refused BEFORE any path resolution or file read, so a rejected paste
    // leaves no trace at all.
    assertNotClaudeSubscriptionToken(apiKey, 'opencode');
    const resolvedTarget = this.resolveTarget(target);
    const filePath = this.authFilePath(userId);
    // Merge: read-modify-write so entries for OTHER opencode providers survive.
    const auth = readJsonObjectOrEmpty(filePath);
    assertNotOverwritingLogin(auth[resolvedTarget], resolvedTarget);
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
      // Same guard as the write path, and for a sharper reason: "remove the key
      // I stored" must not silently sign the user out of a browser login this
      // app never created and cannot recreate.
      assertNotOverwritingLogin(auth[resolvedTarget], resolvedTarget);
      delete auth[resolvedTarget];
      // Only rewrite when something changed — never create a file on delete.
      writeJsonObjectAtomic(filePath, auth);
    }
    return { provider: 'opencode', configured: false };
  }

  /**
   * ADR-200 S6: the target's API key, or null, for the fan-out ownership check
   * and re-read verify. A login record (`type` other than `api`) reads as null:
   * it is never a key, and the write and delete paths refuse to touch it.
   */
  async readApiKey(
    userId: string | number | null | undefined,
    target?: string,
  ): Promise<string | null> {
    const resolvedTarget = this.resolveTarget(target);
    const record = readObjectRecord(readJsonObjectOrEmpty(this.authFilePath(userId))[resolvedTarget]);
    return record?.type === 'api' ? readOptionalString(record.key) ?? null : null;
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
