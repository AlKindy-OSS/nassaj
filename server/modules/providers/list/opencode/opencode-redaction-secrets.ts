/**
 * opencode-redaction-secrets (ADR-200 §8, M-5, M-6) — the ONE place that lists
 * the literal secrets an OpenCode turn or session may carry, for redaction only.
 *
 * "Every key injected in the turn" is more than the sender's vendor slots:
 *   • the vendor slot keys (qwen, glm, kimi, deepseek) a member holds;
 *   • the opencode `auth.json` entries (anthropic, openai, glm, openrouter, and
 *     any OAuth token opencode stored) in that member's own data home;
 *   • under a credential grant, XDG_DATA_HOME follows the GRANTOR
 *     (resolve-provider-env.js, opencode case), so the grantor's auth.json and
 *     vendor keys enter the turn too;
 *   • on read, every session sender (ADR-173) and the owner of the data dir the
 *     history comes from, plus the auth.json in that very dir.
 *
 * Never returns a secret to a client and never logs one. A source that cannot
 * be read contributes nothing (redaction must not break a run or a read).
 */
import fsSync from 'node:fs';
import path from 'node:path';

import { messageAuthorsDb } from '@/modules/database/index.js';
import { providerSecretsService } from '@/modules/providers/services/provider-secrets.service.js';
import { resolveCredentialPrincipal } from '@/services/isolation/credential-principal.js';

import { resolveOpenCodeDataHomeForUser } from './opencode-home.js';

type MemberId = string | number;

/** String fields of an auth.json record that hold a credential. */
const AUTH_SECRET_FIELDS = ['key', 'access', 'refresh'] as const;

function isMemberId(value: unknown): value is MemberId {
  return (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value !== '');
}

/** Every credential string stored in `<dataHome>/auth.json`. */
export function readOpenCodeAuthSecrets(dataHome: string | null | undefined): string[] {
  if (!dataHome) return [];
  try {
    const parsed = JSON.parse(fsSync.readFileSync(path.join(dataHome, 'auth.json'), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    const secrets: string[] = [];
    for (const record of Object.values(parsed as Record<string, unknown>)) {
      if (!record || typeof record !== 'object') continue;
      for (const field of AUTH_SECRET_FIELDS) {
        const value = (record as Record<string, unknown>)[field];
        if (typeof value === 'string' && value !== '') secrets.push(value);
      }
    }
    return secrets;
  } catch {
    return [];
  }
}

/** A member's own vendor slot keys plus the auth.json in their OWN data home. */
function ownSecrets(userId: MemberId): string[] {
  let dataHome: string | null = null;
  try {
    dataHome = resolveOpenCodeDataHomeForUser(userId, { honorGrants: false });
  } catch {
    dataHome = null;
  }
  return [...providerSecretsService.getVendorRedactionSecrets(userId), ...readOpenCodeAuthSecrets(dataHome)];
}

/** The grantor whose opencode data home this member's turns run on, if any. */
function grantorOf(userId: MemberId): MemberId | null {
  try {
    const grantedBy = resolveCredentialPrincipal(userId, 'opencode').grantedBy as unknown;
    return isMemberId(grantedBy) && String(grantedBy) !== String(userId) ? grantedBy : null;
  } catch {
    return null;
  }
}

/** A member's secrets plus their grantor's (M-6 gap 1). */
function memberSecrets(userId: MemberId): string[] {
  const grantor = grantorOf(userId);
  return grantor === null ? ownSecrets(userId) : [...ownSecrets(userId), ...ownSecrets(grantor)];
}

function unique(secrets: string[]): string[] {
  return [...new Set(secrets)];
}

/**
 * Ingest: the secrets a sender's OpenCode turn may carry — their own keys and,
 * under a grant, the grantor's.
 */
export function collectOpenCodeTurnSecrets(senderId: unknown): string[] {
  return isMemberId(senderId) ? unique(memberSecrets(senderId)) : [];
}

function sessionAuthorIds(sessionId: string | null | undefined): number[] {
  if (!sessionId) return [];
  try {
    return messageAuthorsDb.listAuthorIds(sessionId);
  } catch {
    return [];
  }
}

/**
 * Read: the secrets of every sender recorded in the session, of every extra
 * member given (the data-dir owner), and the auth.json in `dataHome` itself.
 */
export function collectOpenCodeSessionSecrets(
  sessionId: string | null | undefined,
  options: { dataHome?: string | null; extraUserIds?: ReadonlyArray<unknown> } = {},
): string[] {
  const ids = new Map<string, MemberId>();
  for (const id of [...sessionAuthorIds(sessionId), ...(options.extraUserIds ?? [])]) {
    if (isMemberId(id)) ids.set(String(id), id);
  }
  const secrets = [...ids.values()].flatMap((id) => memberSecrets(id));
  return unique([...secrets, ...readOpenCodeAuthSecrets(options.dataHome)]);
}
