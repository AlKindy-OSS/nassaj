/**
 * T-2083 (ADR-152 A1 §3.5) — a chat turn refused with CREDENTIAL_NOT_LINKED
 * leaves its outbox entry failed WITH the refusal's payload, so the card can
 * say which account is not linked and offer the two actions. The server's
 * English sentence is not kept as the reason detail.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom (v1 localStorage path).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearOutbox,
  consumeOutboxIngressVerdict,
  getOutboxSnapshot,
  recordOutboxEntry,
  setOutboxBlobStore,
  setOutboxUser,
} from './messageOutbox';

beforeEach(() => {
  localStorage.clear();
  clearOutbox();
  setOutboxUser('member');
  setOutboxBlobStore({
    put: async () => undefined,
    getMany: async () => [],
    deleteMany: async () => undefined,
    clearAll: async () => undefined,
  });
});

const refusal = (credential?: Record<string, unknown>) => ({
  kind: 'complete', provider: 'claude', exitCode: 1, success: false, notStarted: true,
  code: 'CREDENTIAL_NOT_LINKED', error: 'Claude is not linked to your account.', clientMsgId: 'm1',
  ...(credential ? { credential } : {}),
});

describe('outbox: CREDENTIAL_NOT_LINKED', () => {
  it('stores the parsed refusal and drops the server sentence', () => {
    recordOutboxEntry({ id: 'm1', sessionId: null, projectId: 'p', text: 'hello' });
    consumeOutboxIngressVerdict(refusal({
      code: 'CREDENTIAL_NOT_LINKED', provider: 'claude', reason: 'grantor_not_linked',
      grantorUsername: 'ibrahim', actions: ['link_own', 'request_share'], settingsAnchor: 'agents/claude',
    }));
    const [entry] = getOutboxSnapshot();
    expect(entry).toMatchObject({
      status: 'failed',
      reasonCode: 'CREDENTIAL_NOT_LINKED',
      reasonDetail: null,
      credential: {
        provider: 'claude', reason: 'grantor_not_linked', grantorUsername: 'ibrahim', settingsAgent: 'claude',
      },
    });
  });

  it('code-only still records a renderable refusal', () => {
    recordOutboxEntry({ id: 'm1', sessionId: null, projectId: 'p', text: 'hello' });
    consumeOutboxIngressVerdict(refusal());
    expect(getOutboxSnapshot()[0].credential).toEqual({
      provider: null, reason: 'not_linked', grantorUsername: null, settingsAgent: null,
    });
  });

  it('any other failure carries no credential field', () => {
    recordOutboxEntry({ id: 'm1', sessionId: null, projectId: 'p', text: 'hello' });
    consumeOutboxIngressVerdict({ ...refusal(), code: 'spawn_failed' });
    const [entry] = getOutboxSnapshot();
    expect(entry.reasonCode).toBe('spawn_failed');
    expect(entry.credential ?? null).toBeNull();
  });
});
