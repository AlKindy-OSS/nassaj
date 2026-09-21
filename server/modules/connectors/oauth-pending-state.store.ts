/** Durable, AEAD-encrypted, database-coordinated OAuth callback state. */
import crypto from 'node:crypto';

import {
  connectorOAuthPendingDb,
  type OAuthPendingEnvelope,
} from '@/modules/database/index.js';
import { getProviderSecretsKey } from '@/services/isolation/provider-secrets-key-manager.js';

export const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

export type OAuthPendingLink = {
  userId: number;
  connectorId: string;
  remoteUrl: string;
  redirectUri: string;
  codeVerifier: string;
  clientInfo: {
    client_id: string;
    client_secret?: string;
    redirect_uris: string[];
    [key: string]: unknown;
  };
  tokenEndpoint: string;
  includeResource: boolean;
  useBasicClientAuth: boolean;
  startedAt: number;
};

type PendingRepository = {
  put(envelope: OAuthPendingEnvelope): void;
  consume(stateHash: string, now: number): OAuthPendingEnvelope | null;
  sweep(now: number): number;
  count(now: number): number;
};

export type OAuthPendingStateStore = {
  put(state: string, link: OAuthPendingLink): void;
  consume(state: string): OAuthPendingLink | null;
  count(): number;
  sweep(): void;
};

function stateDigest(state: string): string {
  return crypto.createHash('sha256').update(state).digest('hex');
}

function deriveKey(source: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256', source, Buffer.alloc(0), Buffer.from('nassaj/oauth-pending-state/v1'), 32,
  ));
}

function aad(stateHash: string, expiresAt: number): Buffer {
  return Buffer.from(`nassaj:oauth-pending:v1:${stateHash}:${expiresAt}`, 'utf8');
}

function validHttps(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function validLink(value: unknown): value is OAuthPendingLink {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const link = value as Partial<OAuthPendingLink>;
  return Number.isSafeInteger(link.userId) && Number(link.userId) > 0
    && typeof link.connectorId === 'string' && link.connectorId.length > 0
    && validHttps(link.remoteUrl) && validHttps(link.redirectUri)
    && typeof link.codeVerifier === 'string' && link.codeVerifier.length >= 43
    && validHttps(link.tokenEndpoint)
    && typeof link.startedAt === 'number' && Number.isFinite(link.startedAt)
    && typeof link.includeResource === 'boolean'
    && typeof link.useBasicClientAuth === 'boolean'
    && !!link.clientInfo && typeof link.clientInfo.client_id === 'string'
    && Array.isArray(link.clientInfo.redirect_uris)
    && link.clientInfo.redirect_uris.every(validHttps);
}

/** Factory supports independent DB connections for transactional race tests. */
export function createOAuthPendingStateStore(input: {
  repository: PendingRepository;
  ttlMs?: number;
  now?: () => number;
  encryptionKey?: Buffer;
}): OAuthPendingStateStore {
  const ttlMs = input.ttlMs ?? OAUTH_PENDING_TTL_MS;
  const now = input.now ?? Date.now;
  const encryptionKey = deriveKey(input.encryptionKey ?? getProviderSecretsKey());

  return {
    put(state, link) {
      input.repository.sweep(now());
      const stateHash = stateDigest(state);
      const expiresAt = link.startedAt + ttlMs;
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, nonce);
      cipher.setAAD(aad(stateHash, expiresAt));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(link), 'utf8'), cipher.final()]);
      input.repository.put({
        stateHash,
        keyVersion: 1,
        nonce,
        ciphertext,
        tag: cipher.getAuthTag(),
        expiresAt,
        createdAt: now(),
      });
    },

    consume(state) {
      const stateHash = stateDigest(state);
      const envelope = input.repository.consume(stateHash, now());
      if (!envelope || envelope.keyVersion !== 1 || envelope.expiresAt <= now()) return null;
      if (envelope.nonce.length !== 12 || envelope.tag.length !== 16 || envelope.ciphertext.length === 0) {
        return null;
      }
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, envelope.nonce);
        decipher.setAAD(aad(stateHash, envelope.expiresAt));
        decipher.setAuthTag(envelope.tag);
        const plaintext = Buffer.concat([
          decipher.update(envelope.ciphertext), decipher.final(),
        ]).toString('utf8');
        const link = JSON.parse(plaintext) as unknown;
        return validLink(link) ? link : null;
      } catch {
        return null;
      }
    },

    count: () => input.repository.count(now()),
    sweep: () => { input.repository.sweep(now()); },
  };
}

let defaultStore: OAuthPendingStateStore | null = null;

/** Uses the application DB; conditional UPDATE is the cross-worker consume fence. */
export function oauthPendingStateStore(): OAuthPendingStateStore {
  defaultStore ??= createOAuthPendingStateStore({ repository: connectorOAuthPendingDb });
  return defaultStore;
}
