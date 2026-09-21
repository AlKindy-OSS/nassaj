/**
 * rest-specs — the REST platforms nassaj reaches without any third-party code.
 *
 * WHAT A SPEC IS ALLOWED TO CLAIM. Only what its documentation states. A path
 * invented from a naming pattern is the failure this catalog already paid for
 * twice (a URL missing `/mcp`, a key that was not the key). Where a path is
 * documented but has not yet been exercised with a live credential, it is
 * marked below — and the first real call is the test.
 */

export type RestTool = {
  name: string;
  description: string;
  /** `:name` segments are filled from `pathParams`. */
  path: string;
  pathParams?: string[];
  query?: string[];
  properties?: Record<string, unknown>;
};

export type RestSpec = {
  id: string;
  displayName: string;
  baseUrl: string;
  /** Prefix for the `<PREFIX>_API_BASE` override, so sandboxes are reachable. */
  envPrefix: string;
  auth:
    | { kind: 'bearer'; env: string }
    | { kind: 'basic'; userEnv: string; passEnv: string };
  tools: readonly RestTool[];
};

/**
 * Tamara — buy-now-pay-later, Saudi. Authentication is a merchant API token as a
 * bearer (docs.tamara.co), and `GET /orders/{order_id}` is the documented
 * read. The sandbox lives at api-sandbox.tamara.co; point TAMARA_API_BASE there
 * to try a token without touching production data.
 */
const tamara: RestSpec = {
  id: 'tamara',
  displayName: 'تمارا',
  baseUrl: 'https://api.tamara.co',
  envPrefix: 'TAMARA',
  auth: { kind: 'bearer', env: 'TAMARA_API_TOKEN' },
  tools: [
    {
      name: 'tamara_get_order',
      description:
        'تفاصيل طلب تمارا بمعرّفه (order_id): الحالة والمبلغ والعميل وسجلّ المدفوعات.',
      path: '/orders/:order_id',
      pathParams: ['order_id'],
      properties: { order_id: { type: 'string', description: 'معرّف الطلب من تمارا.' } },
    },
    {
      name: 'tamara_get_order_by_reference',
      description: 'تفاصيل طلب تمارا برقم مرجعك أنت (order_reference_id) بدل معرّف تمارا.',
      path: '/merchants/orders/reference-id/:order_reference_id',
      pathParams: ['order_reference_id'],
      properties: {
        order_reference_id: { type: 'string', description: 'رقم الطلب في متجرك.' },
      },
    },
  ],
};

/**
 * Geidea — payment gateway, Saudi/Egypt. Authentication is HTTP Basic with the
 * merchant public key as the username and the API password as the password
 * (docs.geidea.net). The public key is configuration, not a secret, which is why
 * it travels in `extraEnv` while only the password is stored encrypted.
 *
 * ⚠️ PATHS NOT YET EXERCISED WITH A LIVE KEY. `api.merchant.geidea.net` answers
 * 401 on every path — including ones that do not exist — so probing without a
 * credential cannot confirm them (measured 2026-08-05). The first call with a
 * real key is the test; if a path is wrong it fails loudly with a 404 naming the
 * path, which is the correction, not a mystery.
 */
const geidea: RestSpec = {
  id: 'geidea',
  displayName: 'جيديا',
  baseUrl: 'https://api.merchant.geidea.net',
  envPrefix: 'GEIDEA',
  auth: { kind: 'basic', userEnv: 'GEIDEA_PUBLIC_KEY', passEnv: 'GEIDEA_API_PASSWORD' },
  tools: [
    {
      name: 'geidea_get_order',
      description: 'تفاصيل عملية أو طلب في جيديا بمعرّفه.',
      path: '/pgw/api/v2/direct/order/:order_id',
      pathParams: ['order_id'],
      properties: { order_id: { type: 'string', description: 'معرّف الطلب في جيديا.' } },
    },
    {
      name: 'geidea_search_orders',
      description: 'بحث في العمليات والطلبات بحدود زمنية وحالة.',
      path: '/pgw/api/v2/direct/order/search',
      query: ['fromDate', 'toDate', 'status', 'skip', 'take'],
      properties: {
        fromDate: { type: 'string', description: 'تاريخ البداية (YYYY-MM-DD).' },
        toDate: { type: 'string', description: 'تاريخ النهاية (YYYY-MM-DD).' },
        status: { type: 'string', description: 'حالة العملية.' },
        skip: { type: 'number', description: 'تخطّي عدداً من النتائج.' },
        take: { type: 'number', description: 'عدد النتائج (افتراضي حسب جيديا).' },
      },
    },
  ],
};

export const REST_SPECS: Record<string, RestSpec> = { tamara, geidea };
