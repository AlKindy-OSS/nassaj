#!/usr/bin/env node
/**
 * nassaj-wafeq — an MCP server nassaj ships and runs ITSELF (ADR-098 rev4).
 *
 * WHY NASSAJ SHIPS THIS INSTEAD OF POINTING AT A SERVER. The previous Wafeq row
 * pointed at `wafeq-mcp.example.com`, a separate deployed project. Three days
 * of measured failures came out of that one arrow: the URL needed a path nobody
 * had written down, the key it wanted was not the key the page asked for, and
 * the token that finally authenticated could not AUTHORISE — its tools listed
 * and every call answered "WAFEQ_API_KEY not available". Every layer was
 * somebody else's runtime, so every fix meant a container nassaj cannot reach.
 *
 * This file removes all of it. Wafeq publishes a REST API; nassaj talks to it
 * directly, in-process, with a key from the environment. There is no tunnel, no
 * container, no OAuth dance, no second deployment to keep alive — and when
 * something breaks, the whole path is in this repository.
 *
 * THE KEY COMES FROM THE ENVIRONMENT, and that is the whole configuration:
 *   WAFEQ_API_KEY   the key from app.wafeq.com → Developer (required)
 *   WAFEQ_API_BASE  override for the API root (default https://api.wafeq.com/v1)
 * nassaj injects the first from the member's connector when one is stored, and
 * otherwise the server inherits it from nassaj's own .env — so an operator who
 * puts one line in .env gets a working connector for the whole install.
 *
 * AUTHENTICATION IS `Api-Key`, NOT `Bearer`. Measured against the live API and
 * confirmed in wafeq-connect's own client. Sending Bearer yields a 401 that
 * reads exactly like a wrong key, which is how an afternoon disappears.
 *
 * READ-ONLY, DELIBERATELY. Every tool here is a GET. Wafeq is the accounting
 * record: a tool that creates or edits a document is a decision about financial
 * controls (who may draft, what limits apply, what is auditable), not a feature
 * to add because the API allows it. Adding writes later means adding those
 * controls first.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { wafeqAuthorizationValue } from '../../shared/connector-api-key-auth.js';

const API_BASE = (process.env.WAFEQ_API_BASE ?? 'https://api.wafeq.com/v1').replace(/\/$/, '');
const API_KEY = process.env.WAFEQ_API_KEY ?? '';

/** Wafeq's own ceiling behaviour is unknown above this; keep requests sane. */
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

/**
 * Fields kept when summarising a record.
 *
 * `/accounts/` alone answers 80–150 KB for ~136 accounts (measured in
 * wafeq-connect), which is a large fraction of a model's context spent on
 * columns nobody asked for. Summarising by default — with `full: true` to opt
 * out — keeps the common question cheap without hiding anything.
 */
const SUMMARY_FIELDS: Record<string, readonly string[]> = {
  '/accounts/': ['id', 'name', 'code', 'account_type', 'category', 'currency', 'is_archived'],
  '/invoices/': ['id', 'invoice_number', 'contact', 'status', 'invoice_date', 'due_date', 'total', 'currency'],
  '/bills/': ['id', 'bill_number', 'contact', 'status', 'bill_date', 'due_date', 'total', 'currency'],
  '/contacts/': ['id', 'name', 'email', 'phone', 'tax_registration_number', 'is_archived'],
  '/projects/': ['id', 'name', 'code', 'status', 'is_archived'],
  '/cost-centers/': ['id', 'name', 'code', 'is_archived'],
};

type ToolDef = {
  name: string;
  description: string;
  path: string;
  /** Extra query parameters this endpoint understands, beyond paging. */
  filters?: Array<{ name: string; description: string }>;
  /** Endpoints that answer with a single object rather than a page. */
  singular?: boolean;
};

const TOOLS: readonly ToolDef[] = [
  {
    name: 'wafeq_list_accounts',
    description:
      'دليل الحسابات (chart of accounts) في وافق: الاسم والرمز والنوع والتصنيف والعملة. ' +
      'استخدمها للإجابة عن «ما شجرة الحسابات» أو لإيجاد معرّف حساب قبل سؤال آخر.',
    path: '/accounts/',
    filters: [
      { name: 'account_type', description: 'تصفية بنوع الحساب (asset, liability, equity, income, expense).' },
      { name: 'category', description: 'تصفية بتصنيف الحساب كما يسمّيه وافق.' },
    ],
  },
  {
    name: 'wafeq_list_invoices',
    description: 'فواتير المبيعات: الرقم والعميل والحالة والتواريخ والإجمالي.',
    path: '/invoices/',
    filters: [
      { name: 'status', description: 'حالة الفاتورة (DRAFT, SENT, PAID …).' },
      { name: 'contact', description: 'معرّف جهة الاتصال (العميل).' },
    ],
  },
  {
    name: 'wafeq_list_bills',
    description: 'فواتير المشتريات (bills): المورّد والحالة والتواريخ والإجمالي.',
    path: '/bills/',
    filters: [
      { name: 'status', description: 'حالة الفاتورة.' },
      { name: 'contact', description: 'معرّف جهة الاتصال (المورّد).' },
    ],
  },
  {
    name: 'wafeq_list_contacts',
    description: 'العملاء والمورّدون: الاسم والبريد والهاتف والرقم الضريبي.',
    path: '/contacts/',
  },
  {
    name: 'wafeq_list_projects',
    description: 'المشاريع المعرَّفة في وافق — تُستخدم لتحليل الإنفاق لكل مشروع.',
    path: '/projects/',
  },
  {
    name: 'wafeq_list_cost_centers',
    description: 'مراكز التكلفة.',
    path: '/cost-centers/',
  },
  {
    name: 'wafeq_get_organization',
    description: 'بيانات المنشأة في وافق: الاسم والعملة الأساسية والإعدادات الضريبية.',
    path: '/organization/',
    singular: true,
  },
];

function inputSchemaFor(tool: ToolDef): Record<string, unknown> {
  const properties: Record<string, unknown> = tool.singular
    ? {}
    : {
        page: { type: 'number', description: 'رقم الصفحة (يبدأ من 1).', minimum: 1 },
        page_size: {
          type: 'number',
          description: `عدد السجلات في الصفحة (الافتراضي ${DEFAULT_PAGE_SIZE}، الأقصى ${MAX_PAGE_SIZE}).`,
          minimum: 1,
          maximum: MAX_PAGE_SIZE,
        },
        search: { type: 'string', description: 'بحث نصّي حرّ إن كان مدعوماً لهذه النقطة.' },
        full: {
          type: 'boolean',
          description: 'أعِد كل حقول السجل بدل الملخّص. يُنتج ردّاً أكبر بكثير.',
        },
      };

  for (const filter of tool.filters ?? []) {
    properties[filter.name] = { type: 'string', description: filter.description };
  }

  return { type: 'object', properties, additionalProperties: false };
}

/**
 * One GET against Wafeq.
 *
 * Errors are translated rather than passed through: a raw 401 body says nothing
 * about WHICH credential was wrong, and this server is reached by people who
 * have three different ones in play.
 */
async function wafeqGet(path: string, query: URLSearchParams): Promise<unknown> {
  if (!API_KEY) {
    throw new Error(
      'WAFEQ_API_KEY غير مضبوط. ضع مفتاح وافق في إعدادات الموصل أو في ملف .env الخاص بنسّاج.',
    );
  }

  const url = `${API_BASE}${path}${query.toString() ? `?${query}` : ''}`;
  const response = await fetch(url, {
    headers: {
      // Api-Key, NOT Bearer — measured; Bearer answers 401 like a bad key.
      Authorization: wafeqAuthorizationValue(API_KEY),
      Accept: 'application/json',
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `وافق رفض المفتاح (${response.status}). تأكّد أنه مفتاح API من app.wafeq.com → Developer ` +
        'وأن الباقة تسمح بالوصول البرمجي.',
    );
  }
  if (response.status === 429) {
    throw new Error('تجاوزتَ حدّ معدّل وافق (429). أعد المحاولة بعد قليل.');
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`وافق ردّ ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }

  return response.json();
}

/** Keeps a page's shape (count/next/results) while trimming each record. */
function summarise(path: string, payload: unknown, full: boolean): unknown {
  const fields = SUMMARY_FIELDS[path];
  if (full || !fields || payload === null || typeof payload !== 'object') {
    return payload;
  }

  const trim = (record: unknown): unknown => {
    if (record === null || typeof record !== 'object') return record;
    const source = record as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in source) out[field] = source[field];
    }
    // A record with none of the expected fields is returned whole rather than
    // as an empty object: a renamed API is a thing to SEE, not to silence.
    return Object.keys(out).length > 0 ? out : source;
  };

  const page = payload as Record<string, unknown>;
  if (Array.isArray(page.results)) {
    return { ...page, results: page.results.map(trim) };
  }
  return Array.isArray(payload) ? payload.map(trim) : trim(payload);
}

const server = new Server(
  { name: 'nassaj-wafeq', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: inputSchemaFor(tool),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
  if (!tool) {
    throw new Error(`أداة غير معروفة: ${request.params.name}`);
  }

  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  const query = new URLSearchParams();

  if (!tool.singular) {
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Number(args.page_size) || DEFAULT_PAGE_SIZE),
    );
    const page = Math.max(1, Number(args.page) || 1);
    query.set('page', String(page));
    query.set('page_size', String(pageSize));
    // Sent alongside page/page_size because some Wafeq endpoints read one pair
    // and some the other; wafeq-connect learned this the same way.
    query.set('limit', String(pageSize));
    query.set('offset', String((page - 1) * pageSize));
    if (typeof args.search === 'string' && args.search.trim()) {
      query.set('search', args.search.trim());
    }
  }

  for (const filter of tool.filters ?? []) {
    const value = args[filter.name];
    if (typeof value === 'string' && value.trim()) {
      query.set(filter.name, value.trim());
    }
  }

  try {
    const payload = await wafeqGet(tool.path, query);
    const shaped = summarise(tool.path, payload, args.full === true);
    return { content: [{ type: 'text', text: JSON.stringify(shaped, null, 2) }] };
  } catch (error) {
    // Reported as tool content rather than thrown so the model can read the
    // reason and tell the member, instead of surfacing "tool failed".
    return {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
