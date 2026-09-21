#!/usr/bin/env node
/**
 * rest-connector — one MCP server for every platform that publishes a REST API
 * and no MCP server (ADR-098 rev5).
 *
 * WHY ONE SERVER AND NOT ONE PER PLATFORM. Wafeq and Canva each got their own
 * file because each has real behaviour: Wafeq trims a 150 KB chart of accounts,
 * Canva refreshes a rotating grant. Geidea and Tamara have neither — they are a
 * base URL, an auth header, and a list of GET paths. A file each would be the
 * same 150 lines twice, and the second copy is where the drift starts.
 *
 * So the platform is DATA (`rest-specs.ts`) and this file is the engine. Adding
 * a REST platform becomes one object, which is the same promise the connector
 * catalog makes to the member, kept one level down.
 *
 *   node rest-connector.js <spec-id>
 *
 * Credentials arrive in the environment named by the spec, injected by the
 * connector distributor from the member's stored key or the operator's .env.
 *
 * READ-ONLY. Every spec here is GETs. A payment gateway tool that MOVES money is
 * not a feature to add quietly — it is a decision with an audit trail attached.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { REST_SPECS, type RestSpec } from './rest-specs.js';

const specId = process.argv[2] ?? '';
const found: RestSpec | undefined = REST_SPECS[specId];

if (!found) {
  process.stderr.write(
    `rest-connector: unknown platform "${specId}". Known: ${Object.keys(REST_SPECS).join(', ')}\n`,
  );
  process.exit(1);
}
const spec: RestSpec = found;

/** The auth header this platform expects, or a readable reason it cannot be built. */
function authHeader(): string {
  if (spec.auth.kind === 'bearer') {
    const token = process.env[spec.auth.env];
    if (!token) {
      throw new Error(
        `${spec.auth.env} غير مضبوط. ألصق المفتاح في صفحة الموصلات أو ضعه في ملف .env.`,
      );
    }
    return `Bearer ${token}`;
  }
  const user = process.env[spec.auth.userEnv];
  const pass = process.env[spec.auth.passEnv];
  if (!user || !pass) {
    throw new Error(
      `${spec.auth.userEnv} و${spec.auth.passEnv} مطلوبان معاً. ` +
        'ألصق كلمة مرور الواجهة في صفحة الموصلات وضع المفتاح العام في الحقل المرافق.',
    );
  }
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

async function request(path: string, query: URLSearchParams): Promise<unknown> {
  const header = authHeader();
  const base = (process.env[`${spec.envPrefix}_API_BASE`] ?? spec.baseUrl).replace(/\/$/, '');
  const url = `${base}${path}${query.toString() ? `?${query}` : ''}`;

  const response = await fetch(url, {
    headers: { Authorization: header, Accept: 'application/json' },
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `${spec.displayName} رفض الاعتماد (${response.status}). تأكّد أن المفتاح صحيح وأن الحساب يسمح بالوصول البرمجي.`,
    );
  }
  if (response.status === 404) {
    // Worth saying plainly: on these gateways a 404 usually means the RECORD is
    // absent, but it can also mean the path moved — and the reader is the only
    // one who knows which they asked for.
    throw new Error(`${spec.displayName} لم يجد المطلوب (404): ${url.replace(base, '')}`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `${spec.displayName} ردّ ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
    );
  }
  return response.json();
}

const server = new Server(
  { name: `nassaj-${spec.id}`, version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: spec.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties ?? {},
      required: tool.pathParams ?? [],
      additionalProperties: false,
    },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request_) => {
  const tool = spec.tools.find((candidate) => candidate.name === request_.params.name);
  if (!tool) throw new Error(`أداة غير معروفة: ${request_.params.name}`);

  const args = (request_.params.arguments ?? {}) as Record<string, unknown>;
  try {
    let path = tool.path;
    for (const name of tool.pathParams ?? []) {
      const value = args[name];
      if (typeof value !== 'string' || !value.trim()) throw new Error(`المعامل ${name} مطلوب.`);
      path = path.replace(`:${name}`, encodeURIComponent(value.trim()));
    }
    const query = new URLSearchParams();
    for (const name of tool.query ?? []) {
      const value = args[name];
      if (value !== undefined && value !== null && `${value}`.trim() !== '') {
        query.set(name, `${value}`.trim());
      }
    }
    const payload = await request(path, query);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
