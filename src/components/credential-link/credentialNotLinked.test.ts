/**
 * credentialNotLinked — reading the CREDENTIAL_NOT_LINKED refusal (ADR-152 A1
 * §3.5, T-2083) from every surface that carries it, and where its two actions
 * lead.
 *
 * RUNNER: vitest (`npm run test:client`).
 */
import { describe, expect, it } from 'vitest';

import {
  credentialProviderName,
  readCredentialNotLinked,
  resolveCredentialDestinations,
} from './credentialNotLinked';

const payload = {
  code: 'CREDENTIAL_NOT_LINKED',
  provider: 'claude',
  reason: 'not_linked',
  actions: ['link_own', 'request_share'],
  settingsAnchor: 'agents/claude',
  messageAr: 'نص الخادم',
};

describe('readCredentialNotLinked', () => {
  it('reads the chat WS complete frame', () => {
    const info = readCredentialNotLinked({
      kind: 'complete', success: false, notStarted: true,
      code: 'CREDENTIAL_NOT_LINKED', credential: payload, error: 'Claude is not linked',
    });
    expect(info).toEqual({
      provider: 'claude', reason: 'not_linked', grantorUsername: null, settingsAgent: 'claude',
    });
  });

  it('reads /btw, fork and REST /api/agent shapes (code + credential at the root)', () => {
    for (const frame of [
      { type: 'btw-error', code: 'CREDENTIAL_NOT_LINKED', credential: payload, message: 'x' },
      { type: 'message-fork-error', code: 'CREDENTIAL_NOT_LINKED', credential: payload },
      { error: 'Claude is not linked', code: 'CREDENTIAL_NOT_LINKED', credential: payload },
    ]) {
      expect(readCredentialNotLinked(frame)?.provider).toBe('claude');
    }
  });

  it('reads the workflow-supervisor launch shape (payload inside error)', () => {
    const info = readCredentialNotLinked({
      success: false,
      error: { ...payload, provider: 'antigravity', settingsAnchor: 'agents/antigravity', message: 'm' },
    });
    expect(info?.provider).toBe('antigravity');
    expect(info?.settingsAgent).toBe('antigravity');
  });

  it('names the grantor only for grantor_not_linked', () => {
    const info = readCredentialNotLinked({
      code: 'CREDENTIAL_NOT_LINKED',
      credential: { ...payload, reason: 'grantor_not_linked', grantorUsername: 'ibrahim' },
    });
    expect(info).toMatchObject({ reason: 'grantor_not_linked', grantorUsername: 'ibrahim' });

    const stray = readCredentialNotLinked({
      code: 'CREDENTIAL_NOT_LINKED', credential: { ...payload, grantorUsername: 'ibrahim' },
    });
    expect(stray?.grantorUsername).toBeNull();
  });

  it('a grantor reason without a username degrades to not_linked', () => {
    const info = readCredentialNotLinked({
      code: 'CREDENTIAL_NOT_LINKED', credential: { ...payload, reason: 'grantor_not_linked' },
    });
    expect(info?.reason).toBe('not_linked');
  });

  it('handles the code-only case', () => {
    expect(readCredentialNotLinked({ type: 'btw-error', code: 'CREDENTIAL_NOT_LINKED' })).toEqual({
      provider: null, reason: 'not_linked', grantorUsername: null, settingsAgent: null,
    });
  });

  it('names the credential actually missing (claude on a glm engine reports glm)', () => {
    const info = readCredentialNotLinked({
      code: 'CREDENTIAL_NOT_LINKED',
      credential: { ...payload, provider: 'glm', settingsAnchor: 'agents/glm' },
    });
    expect(info?.provider).toBe('glm');
  });

  it('rejects anything that is not this code, and malformed fields', () => {
    expect(readCredentialNotLinked({ code: 'session_busy', credential: payload })).toBeNull();
    expect(readCredentialNotLinked(null)).toBeNull();
    expect(readCredentialNotLinked('CREDENTIAL_NOT_LINKED')).toBeNull();
    const hostile = readCredentialNotLinked({
      code: 'CREDENTIAL_NOT_LINKED',
      credential: {
        provider: '<script>', reason: 'grantor_not_linked', grantorUsername: 'x'.repeat(200),
        settingsAnchor: 'javascript:alert(1)',
      },
    });
    expect(hostile).toEqual({
      provider: null, reason: 'not_linked', grantorUsername: null, settingsAgent: null,
    });
  });
});

describe('resolveCredentialDestinations', () => {
  it('opens the agent account, and the grants section for a share request', () => {
    const info = readCredentialNotLinked({ code: 'CREDENTIAL_NOT_LINKED', credential: payload });
    expect(resolveCredentialDestinations(info!)).toEqual({
      linkOwn: { tab: 'agents', agent: 'claude', category: 'account' },
      requestShare: { tab: 'agents', agent: 'claude', category: 'account', section: 'credential-grants' },
    });
  });

  it('code-only: the agents page on its default agent', () => {
    const info = readCredentialNotLinked({ code: 'CREDENTIAL_NOT_LINKED' });
    expect(resolveCredentialDestinations(info!)).toEqual({
      linkOwn: { tab: 'agents', category: 'account' },
      requestShare: { tab: 'agents', category: 'account', section: 'credential-grants' },
    });
  });

  it('a provider with no agent page (glm) links on the vendors page and has no grant path', () => {
    const info = readCredentialNotLinked({
      code: 'CREDENTIAL_NOT_LINKED',
      credential: { ...payload, provider: 'glm', settingsAnchor: 'agents/glm' },
    });
    expect(resolveCredentialDestinations(info!)).toEqual({
      linkOwn: { tab: 'vendors' },
      requestShare: null,
    });
  });
});

describe('credentialProviderName', () => {
  it('maps UI and isolation ids to brand names', () => {
    expect(credentialProviderName('claude')).toBe('Claude');
    expect(credentialProviderName('antigravity')).toBe('Antigravity');
    expect(credentialProviderName('agy')).toBe('Antigravity');
    expect(credentialProviderName('glm')).toBe('GLM');
    expect(credentialProviderName('opencode')).toBe('OpenCode');
    expect(credentialProviderName(null)).toBeNull();
    expect(credentialProviderName('unheard-of')).toBe('unheard-of');
  });
});
