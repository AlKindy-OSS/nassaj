/**
 * T-1946 — POST /api/agent refuses the API key of a linked member whose last
 * SSO sign-in is older than the owner's window with 401 and
 * `code: 'api_key_sso_attestation_expired'`, on the header path, the SSE-ticket
 * mint and the SSE-ticket path (with or without the header); an unknown or
 * deleted key keeps the generic code-less 401, and a fresh key passes. Launchers are mocked
 * as recorders, so nothing is spawned.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it, mock } from 'node:test';

import express from 'express';

const launched: string[] = [];
const recorder = (name: string) => async () => { launched.push(name); };

mock.module('@/claude-sdk.js', {
  namedExports: {
    queryClaudeSDK: recorder('claude'),
    abortClaudeSDKSession: async () => false,
    isClaudeSDKSessionActive: () => false,
  },
});
mock.module('@/cursor-cli.js', { namedExports: { spawnCursor: recorder('cursor') } });
mock.module('@/kimi-agent-cli.js', { namedExports: { spawnKimiAgent: recorder('kimi') } });
mock.module('@/openai-codex.js', { namedExports: { queryCodex: recorder('codex') } });
mock.module('@/opencode-cli.js', { namedExports: { spawnOpenCode: recorder('opencode') } });

const {
  apiKeysDb, closeConnection, getConnection, initializeDatabase, userDb, userIdentitiesDb,
} = await import('@/modules/database/index.js');
const { writeDisabledRecordOn } = await import('@/modules/database/repositories/sso-oidc-config.js');
const { setExternalApiEnabled } = await import('@/services/external-api-config.js');
const { default: agentRouter } = await import('./agent.js');

const DAY_MS = 24 * 60 * 60 * 1000;

let server: Server;
let baseUrl = '';
let staleKey = '';
let freshKey = '';
let ticketKey = '';
let ticketLink = 0;
let ticketUserId = 0;

before(async () => {
  closeConnection();
  await initializeDatabase();
  // ADR-194 S8 Q1: these tests pin the plain T-1946 window, which applies when SSO
  // is owner-disabled; the refusal while SSO is enforced but unavailable is in the
  // D1 matrices (sso-config.service and sso-credential-matrix tests).
  writeDisabledRecordOn(getConnection(), 'owner', Date.now());
  setExternalApiEnabled(true);
  const stale = userDb.createUser('agent-window-stale', 'hash', 'user');
  const staleLink = userIdentitiesDb.link(stale.id, 'https://idp.example', 'sub-agent-stale');
  userIdentitiesDb.markAttested(staleLink, stale.id, Date.now() - 8 * DAY_MS);
  staleKey = apiKeysDb.createApiKey(stale.id, 'stale').apiKey;
  const fresh = userDb.createUser('agent-window-fresh', 'hash', 'user');
  const freshLink = userIdentitiesDb.link(fresh.id, 'https://idp.example', 'sub-agent-fresh');
  userIdentitiesDb.markAttested(freshLink, fresh.id, Date.now() - DAY_MS);
  freshKey = apiKeysDb.createApiKey(fresh.id, 'fresh').apiKey;
  const ticketUser = userDb.createUser('agent-window-ticket', 'hash', 'admin');
  ticketUserId = ticketUser.id;
  ticketLink = userIdentitiesDb.link(ticketUser.id, 'https://idp.example', 'sub-agent-ticket');
  userIdentitiesDb.markAttested(ticketLink, ticketUser.id, Date.now() - DAY_MS);
  ticketKey = apiKeysDb.createApiKey(ticketUser.id, 'ticket').apiKey;

  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
});

async function agent(apiKey: string): Promise<{ status: number; body: { error?: string; code?: string } }> {
  const response = await fetch(`${baseUrl}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ projectPath: process.cwd(), message: 'hi', provider: 'nonsense', stream: false }),
  });
  return { status: response.status, body: await response.json() as { error?: string; code?: string } };
}

async function mintTicket(apiKey: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/agent/sse-ticket`, {
    method: 'POST', headers: { 'x-api-key': apiKey },
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function agentWithTicket(ticket: string, apiKey?: string) {
  const response = await fetch(`${baseUrl}/api/agent?sseTicket=${encodeURIComponent(ticket)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'text/event-stream',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    body: JSON.stringify({ projectPath: process.cwd(), message: 'hi', provider: 'nonsense' }),
  });
  return { status: response.status, body: await response.json() as { error?: string; code?: string } };
}

const setTicketAttestation = (agoMs: number) =>
  userIdentitiesDb.markAttested(ticketLink, ticketUserId, Date.now() - agoMs);

describe('POST /api/agent API key SSO window', () => {
  it('refuses a stale linked member with api_key_sso_attestation_expired', async () => {
    const res = await agent(staleKey);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'api_key_sso_attestation_expired');
    assert.deepEqual(launched, []);
  });

  it('keeps the generic 401 for an unknown key', async () => {
    const res = await agent(`ck_${'0'.repeat(64)}`);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'Invalid or inactive API key' });
  });

  it('lets a fresh linked member through authentication', async () => {
    const res = await agent(freshKey);
    assert.equal(res.status, 400, 'reaches provider validation, past authentication');
    assert.equal(res.body.code, undefined);
    assert.deepEqual(launched, []);
  });

  it('refuses minting an SSE ticket for a stale linked member with the code', async () => {
    const res = await mintTicket(staleKey);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'api_key_sso_attestation_expired');
  });

  it('a ticket outliving the window returns the code without the header (linked admin)', async () => {
    setTicketAttestation(DAY_MS);
    const minted = await mintTicket(ticketKey);
    assert.equal(minted.status, 201);
    setTicketAttestation(8 * DAY_MS);
    const res = await agentWithTicket(String(minted.body.ticket));
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'api_key_sso_attestation_expired');
    assert.deepEqual(launched, []);
  });

  it('a ticket outliving the window returns the code with the header too', async () => {
    setTicketAttestation(DAY_MS);
    const minted = await mintTicket(ticketKey);
    assert.equal(minted.status, 201);
    setTicketAttestation(8 * DAY_MS);
    const res = await agentWithTicket(String(minted.body.ticket), ticketKey);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'api_key_sso_attestation_expired');
  });

  it('a ticket whose key was deleted keeps the generic 401', async () => {
    setTicketAttestation(DAY_MS);
    const minted = await mintTicket(ticketKey);
    assert.equal(minted.status, 201);
    for (const row of apiKeysDb.getApiKeys(ticketUserId)) apiKeysDb.deleteApiKey(ticketUserId, row.id);
    const res = await agentWithTicket(String(minted.body.ticket));
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'Invalid or inactive API key' });
  });

  it('a fresh ticket passes authentication', async () => {
    ticketKey = apiKeysDb.createApiKey(ticketUserId, 'ticket-2').apiKey;
    setTicketAttestation(DAY_MS);
    const minted = await mintTicket(ticketKey);
    assert.equal(minted.status, 201);
    const res = await agentWithTicket(String(minted.body.ticket));
    assert.equal(res.status, 400, 'reaches provider validation, past authentication');
  });
});
