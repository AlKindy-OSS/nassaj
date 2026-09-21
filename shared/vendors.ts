/**
 * vendors.ts — the VENDOR axis (ADR-085), the entity nassaj was missing.
 *
 * ADR-073 split one flat provider list into two orthogonal axes, body and
 * engine. That was right and still incomplete: one word, `kimi`, names THREE
 * different things in this codebase —
 *
 *   • the **vendor**  — Moonshot, the company that issues the credential,
 *                       revokes it, and sends the bill;
 *   • the **body**    — the Kimi CLI, a harness that runs tools;
 *   • the **engine**  — `api.moonshot.ai`, an endpoint that emits tokens.
 *
 * A credential belongs to the FIRST of those and to neither of the others. That
 * single missing row is what made "why does my key show up in two places?" look
 * like a bug: the Moonshot key is one record, read by the Kimi body AND by the
 * Kimi engine under the Claude body. Nothing was duplicated — the model simply
 * had no name for the thing they share.
 *
 * WHAT THIS FILE IS AND IS NOT. It is a DESCRIPTION of who reads which secret,
 * used to render one honest "used by" line and to decide where the single write
 * surface lives. It is NOT an authorization or capability oracle: whether a
 * write is permitted, and by what method, stays with the live backend
 * descriptor (`GET /:provider/api-key/capability`), because that answer depends
 * on runtime policy (`requiresElevatedRole` → `isProviderIsolated`) which no
 * static table can know. A declaration that promises what it cannot enforce is
 * the failure this project already paid for once.
 *
 * WHY `shared/`: same reason as `engineProviders.ts` and `bodyEngineMatrix.ts` —
 * it is compiled into BOTH bundles, so client and server cannot drift about who
 * consumes what.
 */

/** How a vendor authenticates us. */
export type VendorCredentialKind =
  /** A static key we store and inject. The only kind an ENGINE can ever use. */
  | 'api_key'
  /** A browser login owned by the vendor's own CLI; we never hold the token. */
  | 'subscription_oauth'
  /** Both paths exist: the agent's own login, and an API key as an alternative. */
  | 'both';

/** Where a vendor's credential physically lives once stored. */
export type VendorCredentialStore =
  /** Our encrypted per-user store (`provider-secrets-store.js`). */
  | 'aes'
  /** A file the vendor's own CLI owns, written through its credential writer. */
  | 'cli_file'
  /** The vendor's CLI holds it after its own login; nassaj stores nothing. */
  | 'vendor_cli';

/**
 * One place that reads this vendor's credential. This is the "used by" line —
 * and the reason it is data rather than prose: every entry below was verified
 * against the code path that actually reads the secret at spawn time.
 */
export type VendorConsumer = {
  /**
   * `body` = a harness authenticating to its own vendor; `engine` = an endpoint
   * driving another body; `tool` = something that spends the key without being
   * either — it is not a run configuration at all.
   *
   * B-363 — `tool` was missing, and its absence made the "used by" line LIE. The
   * `delegate_to_vendor` MCP tool is registered on every Claude spawn and calls
   * kimi/deepseek/glm directly with the user's stored key
   * (`vendor-delegate-mcp.js`), so three of nine vendor rows under-reported who
   * reads their secret. A line that promises to enumerate EVERY reader is worse
   * than no line when it is incomplete: it is read as an exhaustive answer.
   * Three consecutive reviews missed this, which is why the reverse test in
   * `vendors.test.ts` now fails if a key reader exists with no consumer row.
   */
  axis: 'body' | 'engine' | 'tool';
  /** The body this consumer runs as (for `engine`, the body being driven). */
  body: string;
  /** The engine id, for engine consumers. */
  engine?: string;
  /** Short label suffix shown in the "used by" line. */
  labelKey: string;
  labelDefault: string;
};

export type Vendor = {
  id: string;
  /** Brand name, identical in every locale. */
  name: string;
  /**
   * The COMPANY this slot belongs to. Several slots can share one — Anthropic
   * issues a single key that `claude` stores in its settings and `opencode`
   * stores in its `auth.json`.
   *
   * T-1151 — this exists because the operator saw "Anthropic" and "Anthropic
   * (OpenCode)" as two cards with two paste boxes and read it as duplication.
   * It IS one key; what differs is where each harness keeps it. Grouping by
   * company says that in the layout instead of asking the reader to infer it.
   *
   * Grouping only. It deliberately does NOT merge the slots: one paste that
   * wrote both would flip a Claude Max subscription to metered API billing
   * (`claude-auth.provider.ts` reads settings.json before the OAuth record) and
   * would push a member's key into the operator's shared opencode file.
   */
  companyId: string;
  /**
   * Which slot of its company this is, for the sub-label. Omitted when the
   * company has exactly one slot — a lone row needs no disambiguation.
   */
  context?: { labelKey: string; labelDefault: string };
  credential: VendorCredentialKind;
  store: VendorCredentialStore;
  /**
   * The `(provider, target?)` pair the write surface must use. Null when we
   * store nothing (the vendor's CLI owns its own login).
   */
  slot: { provider: string; target?: string } | null;
  /** Where the operator obtains a key, when there is one to obtain. */
  keyUrl?: string;
  consumers: VendorConsumer[];
};

/**
 * The vendors nassaj holds or brokers a credential for.
 *
 * Deliberately NOT every company whose model can be reached: opencode's Zen
 * balance and Antigravity's own account are billed inside those tools and we
 * neither store nor broker anything for them, so listing them here would invite
 * an operator to paste a key that has nowhere to go — the exact B-343 failure.
 */
export const VENDORS: readonly Vendor[] = Object.freeze([
  {
    id: 'anthropic',
    companyId: 'anthropic',
    context: { labelKey: 'vendors.context.claudeAgent', labelDefault: 'the Claude agent' },
    name: 'Anthropic',
    credential: 'both',
    store: 'cli_file',
    slot: { provider: 'claude' },
    keyUrl: 'https://console.anthropic.com/settings/keys',
    consumers: [
      {
        axis: 'body',
        body: 'claude',
        labelKey: 'vendors.consumer.claudeBody',
        labelDefault: 'the Claude agent',
      },
    ],
  },
  {
    id: 'openai',
    companyId: 'openai',
    context: { labelKey: 'vendors.context.codexAgent', labelDefault: 'the Codex agent' },
    name: 'OpenAI',
    credential: 'both',
    store: 'cli_file',
    slot: { provider: 'codex' },
    keyUrl: 'https://platform.openai.com/api-keys',
    consumers: [
      {
        axis: 'body',
        body: 'codex',
        labelKey: 'vendors.consumer.codexBody',
        labelDefault: 'the Codex agent',
      },
    ],
  },
  {
    id: 'moonshot',
    companyId: 'moonshot',
    name: 'Moonshot',
    credential: 'both',
    store: 'aes',
    slot: { provider: 'kimi' },
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    consumers: [
      {
        axis: 'body',
        body: 'kimi',
        labelKey: 'vendors.consumer.kimiBody',
        labelDefault: 'the Kimi agent',
      },
      {
        axis: 'engine',
        body: 'claude',
        engine: 'kimi',
        labelKey: 'vendors.consumer.kimiEngineOnClaude',
        labelDefault: 'the Kimi engine under Claude',
      },
      {
        axis: 'tool',
        body: 'claude',
        labelKey: 'vendors.consumer.delegateTool',
        labelDefault: 'the delegate_to_vendor tool under Claude',
      },
    ],
  },
  {
    id: 'alibaba-qwen-coding-plan',
    companyId: 'alibaba-cloud',
    name: 'Alibaba ModelStudio',
    credential: 'api_key',
    store: 'aes',
    slot: { provider: 'qwen' },
    keyUrl: 'https://modelstudio.console.alibabacloud.com/',
    consumers: [
      {
        axis: 'body',
        body: 'qwen',
        labelKey: 'vendors.consumer.qwenBody',
        labelDefault: 'the Qwen Code agent',
      },
    ],
  },
  {
    id: 'zai',
    companyId: 'zai',
    context: { labelKey: 'vendors.context.claudeEngine', labelDefault: 'the Claude engine' },
    name: 'Z.AI',
    credential: 'api_key',
    store: 'aes',
    slot: { provider: 'glm' },
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    consumers: [
      {
        axis: 'engine',
        body: 'claude',
        engine: 'glm',
        labelKey: 'vendors.consumer.glmEngineOnClaude',
        labelDefault: 'the GLM engine under Claude',
      },
      {
        axis: 'tool',
        body: 'claude',
        labelKey: 'vendors.consumer.delegateTool',
        labelDefault: 'the delegate_to_vendor tool under Claude',
      },
    ],
  },
  {
    /**
     * The SAME company as `zai`, and deliberately a separate row: OpenCode's GLM
     * carrier reads its own `auth.json` target, not our encrypted store. One row
     * with two stores would have to say "stored" for a key the carrier cannot
     * see — which is exactly what the old engines panel did (B-343).
     */
    id: 'zai-opencode',
    companyId: 'zai',
    context: { labelKey: 'vendors.context.inOpenCode', labelDefault: 'inside OpenCode' },
    name: 'Z.AI (OpenCode carrier)',
    credential: 'api_key',
    store: 'cli_file',
    slot: { provider: 'opencode', target: 'glm' },
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    consumers: [
      {
        axis: 'engine',
        body: 'opencode',
        engine: 'glm',
        labelKey: 'vendors.consumer.glmCarrierInOpenCode',
        labelDefault: 'the GLM carrier inside OpenCode',
      },
    ],
  },
  {
    /**
     * OpenCode reaching Anthropic BY KEY. Deliberately not a subscription row:
     * routing a personal Claude subscription through OpenCode is forbidden
     * outright, so the only credential this slot may ever hold is an API key.
     */
    id: 'anthropic-opencode',
    companyId: 'anthropic',
    context: { labelKey: 'vendors.context.inOpenCode', labelDefault: 'inside OpenCode' },
    name: 'Anthropic (OpenCode)',
    credential: 'api_key',
    store: 'cli_file',
    slot: { provider: 'opencode', target: 'anthropic' },
    keyUrl: 'https://console.anthropic.com/settings/keys',
    consumers: [
      {
        axis: 'body',
        body: 'opencode',
        labelKey: 'vendors.consumer.anthropicInOpenCode',
        labelDefault: 'Anthropic models inside OpenCode',
      },
    ],
  },
  {
    id: 'openai-opencode',
    companyId: 'openai',
    context: { labelKey: 'vendors.context.inOpenCode', labelDefault: 'inside OpenCode' },
    name: 'OpenAI (OpenCode)',
    credential: 'api_key',
    store: 'cli_file',
    slot: { provider: 'opencode', target: 'openai' },
    keyUrl: 'https://platform.openai.com/api-keys',
    consumers: [
      {
        axis: 'body',
        body: 'opencode',
        labelKey: 'vendors.consumer.openaiInOpenCode',
        labelDefault: 'OpenAI models inside OpenCode',
      },
    ],
  },
  {
    id: 'openrouter',
    companyId: 'openrouter',
    name: 'OpenRouter',
    credential: 'api_key',
    store: 'cli_file',
    slot: { provider: 'opencode', target: 'openrouter' },
    keyUrl: 'https://openrouter.ai/keys',
    consumers: [
      {
        axis: 'body',
        body: 'opencode',
        labelKey: 'vendors.consumer.openrouterInOpenCode',
        labelDefault: 'OpenRouter models inside OpenCode',
      },
    ],
  },
  {
    id: 'deepseek',
    companyId: 'deepseek',
    name: 'DeepSeek',
    credential: 'api_key',
    store: 'aes',
    slot: { provider: 'deepseek' },
    keyUrl: 'https://platform.deepseek.com/api_keys',
    consumers: [
      {
        axis: 'body',
        body: 'deepseek',
        labelKey: 'vendors.consumer.deepseekBody',
        labelDefault: 'the DeepSeek agent',
      },
      {
        /**
         * B-424 (‏15bf86c2) أهّل DeepSeek محرّكاً تحت جسد Claude وأضاف الخلية إلى
         * `bodyEngineMatrix` — ولم يضف قارئَ المفتاح هنا. فكان سطرُ «يُستهلك في»
         * تحت بطاقة DeepSeek يعدّ قارئَين ويسكت عن ثالث، وهو بالضبط النقص الذي
         * كُتب لأجله الاختبار العكسي في `vendors.test.ts` (‏B-363): سطرٌ يَعِد
         * بإحصاء **كلّ** قارئ أسوأُ من لا سطر حين يكون ناقصاً، لأنه يُقرأ جواباً
         * شاملاً. رُصد بالحارس نفسه في T-1219 وأُصلح معه.
         */
        axis: 'engine',
        body: 'claude',
        engine: 'deepseek',
        labelKey: 'vendors.consumer.deepseekEngineOnClaude',
        labelDefault: 'the DeepSeek engine under Claude',
      },
      {
        axis: 'tool',
        body: 'claude',
        labelKey: 'vendors.consumer.delegateTool',
        labelDefault: 'the delegate_to_vendor tool under Claude',
      },
    ],
  },
]);

/** Vendors whose credential we actually store or broker a write for. */
export const WRITABLE_VENDORS: readonly Vendor[] = VENDORS.filter((vendor) => vendor.slot !== null);

/** Lookup by vendor id. */
export function vendorById(id: string): Vendor | null {
  return VENDORS.find((vendor) => vendor.id === id) ?? null;
}

/**
 * The vendor a given credential slot belongs to — the inverse lookup the engines
 * panel needs to say "managed under <vendor>" instead of offering its own box.
 */
export function vendorForSlot(provider: string, target?: string): Vendor | null {
  return (
    VENDORS.find(
      (vendor) =>
        vendor.slot?.provider === provider
        && (vendor.slot?.target ?? undefined) === (target ?? undefined),
    ) ?? null
  );
}

/** The vendor whose credential a (body, engine) pair consumes, if any. */
export function vendorForPair(body: string, engine: string): Vendor | null {
  return (
    VENDORS.find((vendor) =>
      vendor.consumers.some(
        (consumer) => consumer.axis === 'engine' && consumer.body === body && consumer.engine === engine,
      ),
    ) ?? null
  );
}

/** Display name per company. One entry per distinct `companyId`. */
export const COMPANY_NAME: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  moonshot: 'Moonshot',
  zai: 'Z.AI',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  'alibaba-cloud': 'Alibaba Cloud',
});

export type VendorCompany = { id: string; name: string; vendors: Vendor[] };

/**
 * Is this slot the agent's OWN credential — the one its harness authenticates
 * to its own vendor with? (T-1206)
 *
 * This replaces `vendorTouchesAgent`, whose defect was one missing clause: it
 * asked `consumers.some(c => c.body === agent)` **with no test on `axis`**, so
 * every axis answered yes. `axis` is the field that distinguishes the three
 * things this file exists to keep apart (see `VendorConsumer`):
 *
 *   `body`   — a harness authenticating to its own vendor. THIS is ownership.
 *   `engine` — an endpoint driving somebody else's body. A run configuration,
 *              which is what the Engines tab is for.
 *   `tool`   — something that merely spends the key. Not a run configuration at
 *              all, and never a page of its own.
 *
 * Erasing that distinction is what dropped Moonshot, Z.AI and DeepSeek cards
 * into the Claude Account tab beside Anthropic's, at identical visual weight —
 * four "your account at" sections on a page whose subject is one relationship.
 *
 * WHAT IT DOES **NOT** DECIDE: which slots the card then shows. The card carries
 * ALL of its company's slots, foreign places included, because one key with
 * several destinations is the point (T-1201) and hiding a destination that the
 * Save button will really write to is worse than naming it. Only the choice of
 * WHICH COMPANY belongs on WHICH PAGE is made here.
 *
 * TWO CLAUSES, and the second is not decoration — it was MEASURED against the
 * catalog, not assumed. `zai-opencode` is `axis:'engine', body:'opencode'`
 * (OpenCode's GLM carrier is an endpoint driving OpenCode, not OpenCode
 * authenticating to Z.AI), so the `body` clause ALONE would drop Z.AI out of the
 * OpenCode account and leave the `opencode:glm` record with no page at all. The
 * slot's own provider is the second way a credential is native to an agent: the
 * record physically lives in that agent's own credential surface.
 *
 *   `body` clause  → anthropic→claude, openai→codex, moonshot→kimi,
 *                    deepseek→deepseek, {anthropic,openai,openrouter}-opencode.
 *   `slot` clause  → zai-opencode→opencode (its target lives in opencode's
 *                    auth.json), zai→glm (dormant: the tile is disabled).
 *
 * Between them, Claude keeps exactly one card and OpenCode keeps four — which is
 * what the four-slot carrier honestly is.
 *
 * What NEITHER clause admits is `engine` or `tool` reaching across to a body it
 * merely spends a key on: `moonshot`'s engine and tool consumers both name
 * `claude`, and its slot is `kimi`, so Moonshot is native to Kimi and to nothing
 * else. That is the whole correction.
 */
export function vendorIsNativeToAgent(vendor: Vendor, agent: string): boolean {
  if (vendor.slot?.provider === agent) return true;
  return vendor.consumers.some((consumer) => consumer.axis === 'body' && consumer.body === agent);
}

/**
 * The companies whose OWN credential belongs on a given agent's Account page,
 * in catalog order.
 *
 * Claude gets exactly one card (Anthropic). OpenCode gets four, and that is not
 * an inconsistency: OpenCode genuinely is a multi-vendor carrier, and all four
 * of its slots are `axis:'body', body:'opencode'`.
 */
export function companiesForAgent(agent: string): VendorCompany[] {
  return vendorsByCompany().filter((company) =>
    company.vendors.some((vendor) => vendorIsNativeToAgent(vendor, agent)),
  );
}

/**
 * The agents a company's credential is native to — the inverse of
 * `companiesForAgent`, and a pure statement ABOUT THE CATALOG.
 *
 * It answers "whose own credential is this?", which is what the Account page
 * uses to decide whose status row to show. It deliberately no longer answers
 * "where is the key entered?": since T-1219 that question has one constant
 * answer for every company — the Vendors & credentials tab — so a function that
 * computed it per company existed only to be disagreed with.
 *
 * `companyHomeAgent` was that function and is gone. Every surface that used to
 * ask it (the engines panel's pointer, the model picker's deep link, the Vendors
 * tab's card/row choice) now names the one home directly, which is why none of
 * them can drift from another any more.
 */
export function agentsForCompany(companyId: string, agents: readonly string[]): string[] {
  return agents.filter((agent) =>
    VENDORS.some((vendor) => vendor.companyId === companyId && vendorIsNativeToAgent(vendor, agent)),
  );
}

/**
 * The vendor list grouped by company, in first-appearance order. The UI renders
 * ONE section per company — the brand name once — with a row per slot inside it,
 * each keeping its own status and its own write permission.
 */
export function vendorsByCompany(): VendorCompany[] {
  const groups: VendorCompany[] = [];
  for (const vendor of VENDORS) {
    let group = groups.find((candidate) => candidate.id === vendor.companyId);
    if (!group) {
      group = { id: vendor.companyId, name: COMPANY_NAME[vendor.companyId] ?? vendor.name, vendors: [] };
      groups.push(group);
    }
    group.vendors.push(vendor);
  }
  return groups;
}
