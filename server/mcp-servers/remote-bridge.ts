#!/usr/bin/env node
/**
 * remote-bridge — one stdio server that fronts ANY remote MCP server whose token
 * nassaj manages (ADR-098 rev5).
 *
 * WHY THIS EXISTS. Every official remote MCP server measured on 2026-08-05 —
 * Google's Workspace servers, Slack, Figma — refuses dynamic client registration
 * and hands out access tokens that expire. So each one needs exactly two things
 * nassaj already has: an app the operator registered, and a grant file per
 * member. What was missing was the piece in the middle: something that speaks
 * stdio to the engine, HTTP to the platform, and refreshes the token in between.
 *
 * `mcp-remote` is the tool that usually fills that gap, and it cannot be used
 * here: it insists on running its OWN browser flow against a localhost callback
 * (measured — `findExistingClientPort` throws for any other redirect), which is
 * the exact assumption that fails on a server a team reaches through a tunnel.
 *
 * WHAT IT DOES NOT DO. It has no tools of its own and no opinion about them:
 * every `tools/list` and `tools/call` belongs to the remote server. That is the
 * point — one file makes every future remote server linkable without a new
 * adapter, and none of them can be misrepresented here.
 *
 * Environment:
 *   NASSAJ_REMOTE_MCP_URL   the remote endpoint (required)
 *   NASSAJ_GRANT_FILE       this member's grant.json (required)
 *   NASSAJ_OAUTH_CLIENT_ID / NASSAJ_OAUTH_CLIENT_SECRET   for refresh
 *   NASSAJ_OAUTH_TOKEN_AUTH_METHOD   client_secret_post or client_secret_basic
 */

import fs from 'node:fs';
import process from 'node:process';
import readline from 'node:readline';

import {
  GrantRefreshError,
  assertGrantActive,
  refreshGrantSingleFlight,
  repairGrantPermissions,
  type StoredGrant,
  withGrantRequestLease,
} from '../modules/connectors/grant-file.js';

// Also accepted as argv[2] so the stored launch command NAMES the endpoint it
// fronts: `node remote-bridge.js https://…/mcp/v1` reads as what it is, and the
// same string is what the OAuth flow authorises.
const REMOTE_URL = process.env.NASSAJ_REMOTE_MCP_URL ?? process.argv[2] ?? '';
const GRANT_FILE = process.env.NASSAJ_GRANT_FILE ?? '';
const CLIENT_ID = process.env.NASSAJ_OAUTH_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.NASSAJ_OAUTH_CLIENT_SECRET ?? '';
const TOKEN_AUTH_METHOD = process.env.NASSAJ_OAUTH_TOKEN_AUTH_METHOD === 'client_secret_post'
  ? 'client_secret_post'
  : 'client_secret_basic';
const V2_USER_ID = Number(process.env.NASSAJ_OAUTH_V2_USER_ID ?? 0);
const V2_CONNECTOR_ID = process.env.NASSAJ_OAUTH_V2_CONNECTOR_ID ?? '';
const V2_SERVICE_ID = process.env.NASSAJ_OAUTH_V2_SERVICE_ID ?? '';
const V2_GRANT_ID = process.env.NASSAJ_OAUTH_V2_GRANT_ID ?? '';
const V2_SECRET_REF = process.env.NASSAJ_OAUTH_V2_SECRET_REF ?? '';
const V2_CONFIGURED = Number.isSafeInteger(V2_USER_ID) && V2_USER_ID > 0
  && Boolean(V2_CONNECTOR_ID && V2_SERVICE_ID && V2_GRANT_ID && V2_SECRET_REF);

const REFRESH_MARGIN_MS = 60_000;

/** The remote server's session, if it issued one at initialize. */
let sessionId: string | null = null;

/**
 * A misconfiguration is REPORTED, not fatal.
 *
 * Exiting would make the engine show a dead server with no explanation — the
 * member sees a missing tool and nothing to act on. Staying alive and answering
 * every request with the reason puts the sentence where they will actually read
 * it: in the conversation, at the moment they ask for the tool.
 */
const startupProblem = !REMOTE_URL
  ? 'remote-bridge: لم يُحدَّد عنوان الخادم البعيد (NASSAJ_REMOTE_MCP_URL).'
  : !GRANT_FILE && !V2_CONFIGURED
    ? 'remote-bridge: لم يُحدَّد ملف المنحة (NASSAJ_GRANT_FILE) — أعد توزيع الموصل.'
    : null;

async function accessToken(): Promise<string> {
  if (startupProblem) throw new Error(startupProblem);
  if (V2_CONFIGURED) {
    const { withProductionOAuthTokenBundle } = await import(
      '../modules/connectors/connector-user-grant.production.js'
    );
    return withProductionOAuthTokenBundle({
      connectorId: V2_CONNECTOR_ID, userId: V2_USER_ID, serviceId: V2_SERVICE_ID,
      grantId: V2_GRANT_ID, secretRef: V2_SECRET_REF,
      consume: bundle => {
        const parsed = JSON.parse(bundle.toString('utf8')) as {
          accessToken?: unknown; expiresAt?: unknown;
        };
        if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) {
          throw new Error('مادة OAuth المركزية غير صالحة — أعد ربط الحساب.');
        }
        if (typeof parsed.expiresAt === 'number' && parsed.expiresAt <= Date.now()) {
          throw new Error('انتهت مادة OAuth المركزية — جدّد الربط من صفحة الموصلات.');
        }
        return parsed.accessToken;
      },
    });
  }
  if (!fs.existsSync(GRANT_FILE)) {
    throw new Error('لم يُربط هذا الحساب بعد — افتح الإعدادات ← الموصلات واضغط «اربط الحساب».');
  }
  assertGrantActive(GRANT_FILE);
  repairGrantPermissions(GRANT_FILE);
  const grant = JSON.parse(fs.readFileSync(GRANT_FILE, 'utf8')) as StoredGrant;
  if (grant.expires_at - REFRESH_MARGIN_MS > Date.now()) {
    return grant.access_token;
  }
  if (!grant.refresh_token) {
    throw new Error('انتهت صلاحية الربط ولا يوجد رمز تجديد — أعد الربط من صفحة الموصلات.');
  }

  const next = await refreshGrantSingleFlight({
    file: GRANT_FILE,
    needsRefresh: (current) => current.expires_at - REFRESH_MARGIN_MS <= Date.now(),
    refresh: async (current) => {
      if (!current.refresh_token) {
        throw new GrantRefreshError(
          'انتهت صلاحية الربط ولا يوجد رمز تجديد — أعد الربط من صفحة الموصلات.',
          false,
        );
      }
      const clientId = CLIENT_ID || current.client_id || '';
      const clientSecret = CLIENT_SECRET || current.client_secret || '';
      const tokenAuthMethod = current.token_auth_method ?? TOKEN_AUTH_METHOD;
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refresh_token,
        client_id: clientId,
        ...(clientSecret && tokenAuthMethod === 'client_secret_post'
          ? { client_secret: clientSecret }
          : {}),
      });
      const response = await fetch(current.token_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(clientSecret && tokenAuthMethod === 'client_secret_basic'
            ? {
                Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
              }
            : {}),
        },
        body: body.toString(),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new GrantRefreshError(
          `تعذّر تأكيد نتيجة تجديد الربط (${response.status}) — أعد الربط من صفحة الموصلات.${
            detail ? ` التفصيل: ${detail.slice(0, 200)}` : ''
          }`,
          // Once the request left nassaj, even a 5xx/502 can mean a rotating
          // token was consumed before an upstream proxy produced the error.
          // No provider-specific contract currently proves a safe retry.
          true,
        );
      }
      const refreshed = (await response.json()) as {
        access_token?: unknown;
        refresh_token?: unknown;
        expires_in?: unknown;
      };
      if (typeof refreshed.access_token !== 'string' || !refreshed.access_token) {
        throw new GrantRefreshError(
          'استجاب مزوّد OAuth بنجاح دون رمز وصول؛ نتيجة التجديد غير مؤكدة وتلزم إعادة الربط.',
          true,
        );
      }
      return {
        access_token: refreshed.access_token,
        refresh_token:
          typeof refreshed.refresh_token === 'string' && refreshed.refresh_token
            ? refreshed.refresh_token
            : current.refresh_token,
        expires_at:
          Date.now() + (typeof refreshed.expires_in === 'number' ? refreshed.expires_in : 3600) * 1000,
        token_url: current.token_url,
        ...(current.scope !== undefined ? { scope: current.scope } : {}),
        ...(current.client_id ? { client_id: current.client_id } : {}),
        ...(current.client_secret ? { client_secret: current.client_secret } : {}),
        ...(current.token_auth_method ? { token_auth_method: current.token_auth_method } : {}),
      };
    },
  });
  return next.access_token;
}

/**
 * Forwards one JSON-RPC message and returns the remote's reply.
 *
 * Streamable HTTP may answer with plain JSON or with an SSE stream carrying the
 * same object; both are handled because different platforms pick differently for
 * the same request (Google streams, Canva does not).
 */
async function forward(message: unknown): Promise<unknown | null> {
  return withGrantRequestLease(GRANT_FILE, async () => {
    const token = await accessToken();
    const response = await fetch(REMOTE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(message),
    });

    const issued = response.headers.get('mcp-session-id');
    if (issued) sessionId = issued;

    if (response.status === 202) return null; // notification accepted
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`الخادم البعيد ردّ ${response.status}: ${text.slice(0, 200)}`);
    }
    if (!text.trim()) return null;

    if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload) return JSON.parse(payload);
        }
      }
      return null;
    }
    return JSON.parse(text);
  });
}

const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message: { id?: unknown; method?: string };
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  void forward(message)
    .then((reply) => {
      if (reply !== null) out(reply);
    })
    .catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      // A request gets an error REPLY; a notification has no id and gets
      // silence, because inventing a response for one breaks the client.
      if (message.id !== undefined && message.id !== null) {
        out({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: text } });
      } else {
        process.stderr.write(`${text}\n`);
      }
    });
});
