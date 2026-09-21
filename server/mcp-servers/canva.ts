#!/usr/bin/env node
/**
 * nassaj-canva — Canva Connect, reached directly by a server nassaj ships.
 *
 * WHY NOT `mcp.canva.com`. Measured twice on 2026-08-05, from two hostnames:
 * Canva's MCP endpoint funnels every dynamically registered client into ONE
 * Canva-owned Connect app (`OC-AZb1vOWcedZR`) and therefore refuses any redirect
 * that is not localhost — `400 Invalid redirect URI. It must be from an allowed
 * host.` That design assumes the MCP client runs on the approver's own laptop.
 * nassaj is a server a team reaches through a tunnel, so that assumption cannot
 * hold here, and no amount of hostname rewriting changes it.
 *
 * WHAT REPLACES IT. The operator registers ONE Canva app (five minutes, once)
 * whose redirect is their own nassaj origin. nassaj runs the authorization-code
 * + PKCE flow against Connect itself, writes the grant into the member's auth
 * directory, and this server reads it. Every member links their own Canva
 * account through the operator's app — the normal shape of an OAuth integration.
 *
 * THIS SERVER REFRESHES ITS OWN GRANT. Canva's access tokens are short-lived and
 * its refresh tokens ROTATE: each one works once, and the replacement arrives in
 * the refresh response. So the file is rewritten on every refresh, and a stale
 * copy is worthless — which is also why two members must never share one file.
 *
 * Environment (all injected by the connector distributor):
 *   NASSAJ_GRANT_FILE              path to this member's grant.json
 *   NASSAJ_OAUTH_CANVA_CLIENT_ID   the operator's app
 *   NASSAJ_OAUTH_CANVA_CLIENT_SECRET
 *
 * READ-ONLY, like the Wafeq server and for the same reason: creating or editing
 * a member's designs is a decision about their account, not a feature to enable
 * because the scope list allows it.
 */

import fs from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  GrantRefreshError,
  assertGrantActive,
  refreshGrantSingleFlight,
  repairGrantPermissions,
  type StoredGrant,
  withGrantRequestLease,
} from '../modules/connectors/grant-file.js';

const API_BASE = (process.env.CANVA_API_BASE ?? 'https://api.canva.com/rest/v1').replace(/\/$/, '');
const GRANT_FILE = process.env.NASSAJ_GRANT_FILE ?? '';
const CLIENT_ID = process.env.NASSAJ_OAUTH_CANVA_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.NASSAJ_OAUTH_CANVA_CLIENT_SECRET ?? '';
const V2_USER_ID = Number(process.env.NASSAJ_OAUTH_V2_USER_ID ?? 0);
const V2_CONNECTOR_ID = process.env.NASSAJ_OAUTH_V2_CONNECTOR_ID ?? '';
const V2_SERVICE_ID = process.env.NASSAJ_OAUTH_V2_SERVICE_ID ?? '';
const V2_GRANT_ID = process.env.NASSAJ_OAUTH_V2_GRANT_ID ?? '';
const V2_SECRET_REF = process.env.NASSAJ_OAUTH_V2_SECRET_REF ?? '';
const V2_CONFIGURED = Number.isSafeInteger(V2_USER_ID) && V2_USER_ID > 0
  && Boolean(V2_CONNECTOR_ID && V2_SERVICE_ID && V2_GRANT_ID && V2_SECRET_REF);

/** Refresh this long before expiry rather than after a 401 costs a round trip. */
const REFRESH_MARGIN_MS = 60_000;

function readGrant(): StoredGrant {
  if (!GRANT_FILE || !fs.existsSync(GRANT_FILE)) {
    throw new Error(
      'لم يُربط حساب Canva بعد. افتح الإعدادات ← الموصلات واضغط «اربط الحساب».',
    );
  }
  assertGrantActive(GRANT_FILE);
  repairGrantPermissions(GRANT_FILE);
  return JSON.parse(fs.readFileSync(GRANT_FILE, 'utf8')) as StoredGrant;
}

/**
 * A live access token, refreshing first when the stored one is spent.
 *
 * The rotated refresh token is written back BEFORE the call that uses the new
 * access token, so a crash mid-call cannot leave the file holding a refresh
 * token Canva has already invalidated — that state is unrecoverable without the
 * member linking again.
 */
async function accessToken(): Promise<string> {
  if (V2_CONFIGURED) {
    const { withProductionOAuthTokenBundle } = await import(
      '../modules/connectors/connector-user-grant.production.js'
    );
    return withProductionOAuthTokenBundle({
      connectorId: V2_CONNECTOR_ID, userId: V2_USER_ID, serviceId: V2_SERVICE_ID,
      grantId: V2_GRANT_ID, secretRef: V2_SECRET_REF,
      consume: bytes => {
        const bundle = JSON.parse(bytes.toString('utf8')) as {
          accessToken?: unknown; expiresAt?: unknown;
        };
        if (typeof bundle.accessToken !== 'string' || bundle.accessToken.length === 0) {
          throw new Error('مادة OAuth المركزية لـCanva غير صالحة — أعد الربط.');
        }
        if (typeof bundle.expiresAt === 'number' && bundle.expiresAt <= Date.now()) {
          throw new Error('انتهت مادة OAuth المركزية لـCanva — جدّد الربط.');
        }
        return bundle.accessToken;
      },
    });
  }
  const grant = readGrant();
  if (grant.expires_at - REFRESH_MARGIN_MS > Date.now()) {
    return grant.access_token;
  }
  if (!grant.refresh_token) {
    throw new Error('انتهت صلاحية ربط Canva ولا يوجد رمز تجديد — أعد الربط من صفحة الموصلات.');
  }
  if (!CLIENT_ID) {
    throw new Error(
      'تعذّر تجديد ربط Canva: تطبيق المشغّل غير مضبوط (NASSAJ_OAUTH_CANVA_CLIENT_ID).',
    );
  }

  const next = await refreshGrantSingleFlight({
    file: GRANT_FILE,
    needsRefresh: (current) => current.expires_at - REFRESH_MARGIN_MS <= Date.now(),
    refresh: async (current) => {
      if (!current.refresh_token) {
        throw new GrantRefreshError(
          'انتهت صلاحية ربط Canva ولا يوجد رمز تجديد — أعد الربط من صفحة الموصلات.',
          false,
        );
      }
      const response = await fetch(current.token_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: current.refresh_token,
        }).toString(),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new GrantRefreshError(
          `تعذّر تأكيد نتيجة تجديد ربط Canva (${response.status}). أعد الربط من صفحة الموصلات.` +
            (detail ? ` التفصيل: ${detail.slice(0, 200)}` : ''),
          // Canva rotates refresh tokens. A non-2xx received after sending the
          // request cannot prove an upstream did not consume the old token.
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
          'استجاب Canva دون رمز وصول؛ نتيجة تدوير الرمز غير مؤكدة وتلزم إعادة الربط.',
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

async function canvaGet(path: string, query: URLSearchParams): Promise<unknown> {
  return withGrantRequestLease(GRANT_FILE, async () => {
    const token = await accessToken();
    const url = `${API_BASE}${path}${query.toString() ? `?${query}` : ''}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Canva رفض الطلب (${response.status}). قد يكون الربط سُحب من إعدادات حسابك في Canva — أعد الربط.`,
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Canva ردّ ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    return response.json();
  });
}

type ToolDef = {
  name: string;
  description: string;
  /** Built from the arguments; `:id` segments are substituted. */
  path: string;
  required?: string[];
  properties?: Record<string, unknown>;
  /** Query parameters passed straight through when present. */
  query?: string[];
};

const TOOLS: readonly ToolDef[] = [
  {
    name: 'canva_get_profile',
    description: 'حساب Canva المربوط: الاسم ومعرّف المستخدم — للتأكد من أي حساب يعمل نسّاج.',
    path: '/users/me',
  },
  {
    name: 'canva_list_designs',
    description:
      'تصاميم الحساب، مع بحث نصّي اختياري. تُعيد المعرّف والعنوان وروابط العرض وتواريخ التعديل.',
    path: '/designs',
    properties: {
      query: { type: 'string', description: 'بحث في عناوين التصاميم.' },
      ownership: {
        type: 'string',
        description: 'any | owned | shared — الافتراضي any.',
      },
      sort_by: { type: 'string', description: 'relevance | modified_descending | title_ascending …' },
      continuation: { type: 'string', description: 'رمز الصفحة التالية من ردّ سابق.' },
    },
    query: ['query', 'ownership', 'sort_by', 'continuation'],
  },
  {
    name: 'canva_get_design',
    description: 'تفاصيل تصميم واحد بمعرّفه.',
    path: '/designs/:design_id',
    required: ['design_id'],
    properties: { design_id: { type: 'string', description: 'معرّف التصميم.' } },
  },
  {
    name: 'canva_list_folder_items',
    description:
      'محتويات مجلد: التصاميم والمجلدات والأصول داخله. استخدم "root" للمجلد الجذر للحساب.',
    path: '/folders/:folder_id/items',
    required: ['folder_id'],
    properties: {
      folder_id: { type: 'string', description: 'معرّف المجلد أو "root".' },
      item_types: { type: 'string', description: 'تصفية: design أو folder أو image.' },
      continuation: { type: 'string', description: 'رمز الصفحة التالية.' },
    },
    query: ['item_types', 'continuation'],
  },
  {
    name: 'canva_get_folder',
    description: 'بيانات مجلد واحد بمعرّفه.',
    path: '/folders/:folder_id',
    required: ['folder_id'],
    properties: { folder_id: { type: 'string', description: 'معرّف المجلد.' } },
  },
  {
    name: 'canva_list_brand_templates',
    description: 'قوالب العلامة المتاحة للحساب (تتطلب اشتراك Canva مؤسسي).',
    path: '/brand-templates',
    properties: {
      query: { type: 'string', description: 'بحث في عناوين القوالب.' },
      continuation: { type: 'string', description: 'رمز الصفحة التالية.' },
    },
    query: ['query', 'continuation'],
  },
  {
    name: 'canva_get_asset',
    description: 'بيانات أصل (صورة أو ملف) بمعرّفه.',
    path: '/assets/:asset_id',
    required: ['asset_id'],
    properties: { asset_id: { type: 'string', description: 'معرّف الأصل.' } },
  },
];

const server = new Server(
  { name: 'nassaj-canva', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties ?? {},
      required: tool.required ?? [],
      additionalProperties: false,
    },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
  if (!tool) {
    throw new Error(`أداة غير معروفة: ${request.params.name}`);
  }

  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    let path = tool.path;
    for (const name of tool.required ?? []) {
      const value = args[name];
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`المعامل ${name} مطلوب.`);
      }
      path = path.replace(`:${name}`, encodeURIComponent(value.trim()));
    }

    const query = new URLSearchParams();
    for (const name of tool.query ?? []) {
      const value = args[name];
      if (typeof value === 'string' && value.trim()) query.set(name, value.trim());
    }

    const payload = await canvaGet(path, query);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    // Reported as content, not thrown: the member needs to read "link Canva
    // first", not "tool failed".
    return {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
