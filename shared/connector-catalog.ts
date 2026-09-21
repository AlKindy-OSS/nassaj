/**
 * connector-catalog — ready-made definitions for the platforms a member can
 * connect in one click (ADR-098 rev2).
 *
 * WHY A CATALOG EXISTS. Without it, adding Notion meant knowing that its MCP
 * server is `@notionhq/notion-mcp-server`, that it is launched with `npx -y`,
 * and that the key travels in `NOTION_TOKEN`. That is packaging knowledge, not a
 * decision the person pasting a key should have to hold. With the catalog the
 * whole interaction is: pick the platform, paste the key.
 *
 * WHY IT IS DATA, NOT CODE. Every entry is a plain record with no behaviour, so
 * adding a platform is a one-object edit rather than a new adapter — and the
 * "custom" path below stays available for anything not listed, so the catalog
 * never becomes a ceiling.
 *
 * `allowsSharing` IS A TERMS-OF-SERVICE FACT, NOT A PREFERENCE. A platform that
 * licenses a seat per person (Canva is the measured example) cannot legitimately
 * be driven by five people through one key, so the API refuses to SHARE it. The
 * same platform is perfectly fine as a PERSONAL connector, which is what the
 * flag steers people toward rather than blocking them outright.
 *
 * EVERY ROW WAS LAUNCHED, NOT JUST LOOKED UP (2026-08-04). Each stdio entry was
 * started with the real `claude` binary and had to reach "Connected" before it
 * stayed here. That pass removed three entries and corrected two:
 *   • linear / canva — OAuth requires a browser grant; a pasted key is
 *     meaningless to it. They belong to the OAuth phase
 *     (ADR-091 ص٢), not to this one.
 *   • google-drive — `server-gdrive` demands an interactive `auth` run that
 *     writes a credentials FILE; there is no env var it will accept.
 *   • stripe — upstream deleted the `--tools` flag; passing it aborts startup.
 *   • sentry — the variable is SENTRY_ACCESS_TOKEN, not SENTRY_AUTH_TOKEN.
 * A row that cannot start is worse than an absent one: it looks connectable and
 * fails only after someone has pasted a live credential.
 *
 * WHICH OAUTH PLATFORMS CAN BE LINKED FROM THE PAGE (measured 2026-08-05). Under
 * ADR-098 rev3 nassaj runs the grant itself and its redirect is its own public
 * origin, so the question for every remote server is whether that origin is
 * accepted. Each was registered dynamically and then driven to `/authorize`:
 *   notion · sentry · linear · atlassian → consent page. Linkable by button.
 *   canva  → 400 "Invalid redirect URI. It must be from an allowed host."
 *   asana  → registration itself refuses the origin (invalid_redirect_uri).
 * Canva and Asana accept ONLY localhost for dynamically registered clients, so
 * they need an app registered by the operator at the platform. Canva stays here
 * because that app is a five-minute step the operator can take; Asana is absent
 * until someone needs it. Re-run scripts/connector-oauth-check.mjs before adding
 * any remote server — a platform that refuses the origin looks perfectly fine
 * until the member is already staring at an error page.
 *
 * VERIFY BEFORE TRUSTING A ROW. Package names and env var names here are the
 * documented ones at the time of writing; a platform can rename either. A wrong
 * row fails loudly at launch (the MCP server does not start), not silently, but
 * it still costs someone a confused minute — so when one is corrected, correct
 * it here rather than working around it per connector.
 */

/**
 * Placeholder for the directory holding the MCP servers nassaj ships itself.
 *
 * The catalog is data shared with the browser, so it cannot know an absolute
 * path — and hardcoding one would break on every install but the author's. The
 * server substitutes this at DISTRIBUTION time (connectors.service), which also
 * means a stored row stays portable if the install moves.
 */
export const BUILT_IN_SERVERS_TOKEN = '{{NASSAJ_MCP_SERVERS}}';

export type CatalogTransport = 'stdio' | 'http';

/**
 * How a connector proves who it is.
 *
 *   'key'   — the member pastes a credential once; it is stored encrypted and
 *             injected at spawn.
 *   'oauth' — there is no key to paste. The member authorises nassaj in a
 *             browser ONCE, and `mcp-remote` keeps the tokens in a per-member
 *             auth directory, refreshing them on its own afterwards.
 *
 * The distinction is not cosmetic: an OAuth connector must never show a key
 * field (there is nothing to type), and its "configured" state is the presence
 * of tokens on disk rather than a row in the secret store.
 */
export type CatalogAuthMode = 'key' | 'oauth';

export type CatalogEntry = {
  /** Stable service id; also the default connector id. */
  service: string;
  /** What the member sees in the picker. */
  displayName: string;
  /** One line: what connecting this actually gets them. */
  summary: string;
  transport: CatalogTransport;
  command?: string;
  args?: string[];
  /**
   * Immutable npm provenance for a catalog-owned `npx` launcher.
   *
   * This does not install anything. When the server-side store-only policy is
   * explicitly enabled, the resolver accepts the package only when the
   * dedicated connector store's lockfile records this exact version and SRI.
   */
  npmPackage?: {
    name: string;
    version: string;
    integrity: `sha512-${string}`;
    /** Exact key in package.json#bin and the path it must map to. */
    bin: { name: string; path: string };
  };
  url?: string;
  /** stdio: env var the key travels in. */
  keyEnvVar?: string;
  /** http: header the key travels in, and what precedes it. */
  keyHeader?: string;
  keyHeaderPrefix?: string;
  /** False when the platform's terms require individual authentication. */
  allowsSharing: boolean;
  /** Where the member goes to obtain the key. */
  keyHelpUrl?: string;
  /** What the key is called on that platform's screen. */
  keyLabel?: string;
  /**
   * Filename under `public/connector-logos/`, without extension. Bundled rather
   * than fetched from an icon CDN: nassaj runs behind a tunnel and should not
   * need the public internet to draw its own settings page, and a per-brand CDN
   * request would tell that CDN which platforms this install uses. Absent when
   * no mark is bundled — the UI falls back to a monogram.
   */
  logo?: string;
  /** Extension of the bundled mark; `png` marks a full-colour raster. */
  logoExt?: 'svg' | 'png';
  /**
   * Whether the MCP server is published BY the platform. An unofficial server is
   * a third party's package that `npx` downloads and hands a live API key to, so
   * the distinction is shown to the member rather than buried here: it is a
   * supply-chain decision, and it is theirs to make.
   */
  official: boolean;
  /**
   * Where the server that receives the key actually comes from. Required in
   * practice for `official: false`: "third-party" without a name is a warning a
   * member cannot act on, and the whole point of the flag is that somebody other
   * than the platform will hold their credential — so they get to look at who.
   */
  vendorUrl?: string;
  /**
   * Additional NON-SECRET values the server needs to start (Slack's workspace id
   * is the measured case: without SLACK_TEAM_ID the server prints a usage line
   * and exits). Kept apart from the key because they are configuration, not
   * credentials — they are stored in the connector row, not in the encrypted
   * store, and the UI may show them back to the member.
   */
  extraEnv?: ReadonlyArray<{ id: string; envVar: string; label: string; hint?: string }>;
  /** Defaults to 'key' when absent, which is what every pasted-credential row is. */
  authMode?: CatalogAuthMode;
  /**
   * OAuth against a platform that will NOT self-register a client for a public
   * redirect — Canva measured 2026-08-05: its registration endpoint accepts any
   * redirect and its authorize endpoint then refuses everything but localhost.
   * The only way in is an app the operator registers once at the platform, whose
   * id and secret arrive in the environment under `clientEnvPrefix`.
   *
   * Endpoints are named here rather than discovered because these platforms
   * publish no MCP-style metadata document; discovery would just be a 404 on the
   * way to the same constants.
   */
  oauthClient?: {
    authorizeUrl: string;
    tokenUrl: string;
    scopes: readonly string[];
    /** `<prefix>_CLIENT_ID` and `<prefix>_CLIENT_SECRET` in nassaj's env. */
    clientEnvPrefix: string;
    /** Where the operator registers the app, shown in the UI. */
    registerAppUrl: string;
    /**
     * Google OAuth is not an RFC 8707 protected-resource flow. Its authorization
     * and token endpoints reject/ignore `resource`, and durable access needs the
     * provider-specific offline/incremental parameters. Kept explicit in the
     * trusted catalog so OAuth behaviour follows the provider, never a hostname
     * supplied by a request.
     */
    providerProfile?: 'google';
  };
};

export const CONNECTOR_CATALOG: readonly CatalogEntry[] = Object.freeze([
  {
    service: 'notion',
    displayName: 'Notion',
    summary: 'Read and write Notion pages and databases.',
    transport: 'stdio',
    command: 'node',
    // Notion's own hosted server, reached through nassaj's locked bridge.
    // Preferred over the npm package + pasted integration token because the
    // grant is the member's own Notion session: they see exactly which pages
    // they shared, and revoke it from Notion rather than by rotating a string.
    args: [`${BUILT_IN_SERVERS_TOKEN}/remote-bridge.js`, 'https://mcp.notion.com/mcp'],
    authMode: 'oauth',
    // A grant belongs to the person who approved it.
    allowsSharing: false,
    keyHelpUrl: 'https://www.notion.so/my-integrations',
    logo: 'notion',
    official: true,
  },
  {
    service: 'github',
    displayName: 'GitHub',
    summary: 'Repositories, issues and pull requests.',
    // GitHub's OWN remote server, not a package. The entry used to run
    // `@modelcontextprotocol/server-github`, which is published by the MCP
    // project rather than by GitHub and was last released 2025-04-08 with no
    // repository declared — so the row carried an `official: true` badge for a
    // server that was neither GitHub's nor maintained. The endpoint below is
    // GitHub's, measured live: it answers 401 to an unauthenticated initialize,
    // which is a real MCP endpoint asking for the token.
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    keyHeader: 'Authorization',
    keyHeaderPrefix: 'Bearer ',
    allowsSharing: false,
    keyHelpUrl: 'https://github.com/settings/tokens',
    keyLabel: 'Personal Access Token',
    logo: 'github',
    official: true,
  },
  {
    service: 'slack',
    displayName: 'Slack',
    summary: 'Read channels and send messages.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    keyEnvVar: 'SLACK_BOT_TOKEN',
    // Measured: the server exits with "Please set SLACK_BOT_TOKEN and
    // SLACK_TEAM_ID" when the workspace id is missing.
    extraEnv: [{ id: 'workspaceId', envVar: 'SLACK_TEAM_ID', label: 'Workspace ID', hint: 'T01234567' }],
    allowsSharing: true,
    keyHelpUrl: 'https://api.slack.com/apps',
    keyLabel: 'Bot User OAuth Token',
    logo: 'slack',
    official: true,
  },
  {
    service: 'figma',
    displayName: 'Figma',
    summary: 'Read files, frames and components.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'figma-developer-mcp', '--stdio'],
    keyEnvVar: 'FIGMA_API_KEY',
    allowsSharing: false,
    keyHelpUrl: 'https://www.figma.com/developers/api#access-tokens',
    keyLabel: 'Personal access token',
    logo: 'figma',
    official: false,
    vendorUrl: 'https://github.com/GLips/Figma-Context-MCP',
  },
  {
    service: 'canva',
    displayName: 'Canva',
    summary: 'Designs, folders and brand templates.',
    transport: 'stdio',
    // nassaj's own server against Canva Connect's REST API, NOT mcp.canva.com.
    // Measured 2026-08-05: `mcp.canva.com` funnels every dynamically registered
    // client into one Canva-owned Connect app (`OC-AZb1vOWcedZR`) and therefore
    // restricts redirects to localhost — twice refused, from two hostnames. A
    // server reached only from the approver's own machine cannot serve a team,
    // so nassaj talks to Connect directly with the operator's OWN app.
    command: 'node',
    args: [`${BUILT_IN_SERVERS_TOKEN}/canva.js`],
    authMode: 'oauth',
    oauthClient: {
      authorizeUrl: 'https://www.canva.com/api/oauth/authorize',
      tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
      // Read-only scopes: this server never edits a design. Asking for write
      // scope nobody uses would put a permission on the member's consent screen
      // that nassaj cannot justify.
      scopes: [
        'profile:read',
        'design:meta:read',
        'design:content:read',
        'folder:read',
        'brandtemplate:meta:read',
        'brandtemplate:content:read',
        'asset:read',
      ],
      clientEnvPrefix: 'NASSAJ_OAUTH_CANVA',
      registerAppUrl: 'https://www.canva.com/developers/integrations',
    },
    // Canva Connect rotates refresh tokens (single use), so two members on one
    // grant would log each other out. Sharing is a correctness problem here.
    allowsSharing: false,
    keyHelpUrl: 'https://www.canva.dev/docs/connect/authentication/',
    logo: 'canva',
    official: true,
  },
  {
    service: 'wafeq',
    displayName: 'Wafeq',
    summary: 'Invoices, journal entries and accounting reports.',
    transport: 'stdio',
    // nassaj's OWN server (server/mcp-servers/wafeq.ts), not a package npx
    // fetches and not a separate deployment. Three days of measured failures
    // came from pointing this row at an external MCP server: a path nobody had
    // written down, a key that was not the key the page asked for, and finally a
    // token that authenticated but could not authorise. Every one of those lived
    // in a runtime nassaj could not reach. Wafeq publishes a REST API; talking
    // to it directly puts the whole path inside this repository.
    command: 'node',
    args: [`${BUILT_IN_SERVERS_TOKEN}/wafeq.js`],
    keyEnvVar: 'WAFEQ_API_KEY',
    // Because it is built in, the key may also come from nassaj's own .env: an
    // operator who sets WAFEQ_API_KEY once gets a working connector for the
    // whole install, with nothing pasted anywhere.
    allowsSharing: true,
    keyHelpUrl: 'https://app.wafeq.com/settings/api-keys',
    keyLabel: 'Wafeq API key',
    logo: 'wafeq',
    official: true,
  },
  {
    service: 'stripe',
    displayName: 'Stripe',
    summary: 'Customers, subscriptions and payments.',
    transport: 'stdio',
    command: 'npx',
    // `--tools` was REMOVED upstream (measured 2026-08-04: the server prints
    // "The --tools flag has been removed" and exits); permissions now come from
    // the restricted key itself.
    args: ['-y', '@stripe/mcp'],
    keyEnvVar: 'STRIPE_SECRET_KEY',
    // A service key belongs to the account, not to a person.
    allowsSharing: true,
    keyHelpUrl: 'https://dashboard.stripe.com/apikeys',
    // The server itself warns that rk_* (restricted) is preferable to sk_*, and
    // since the key now carries the tool permissions, the narrower one is also
    // the more capable choice to recommend.
    keyLabel: 'Restricted key (rk_…)',
    logo: 'stripe',
    official: true,
  },
  {
    service: 'sentry',
    displayName: 'Sentry',
    summary: 'Errors, releases and incident tracking.',
    transport: 'stdio',
    command: 'node',
    // Sentry's hosted server. Same reasoning as Notion: the member authorises
    // their own account instead of minting a long-lived token by hand.
    args: [`${BUILT_IN_SERVERS_TOKEN}/remote-bridge.js`, 'https://mcp.sentry.dev/mcp'],
    authMode: 'oauth',
    allowsSharing: false,
    keyHelpUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
    logo: 'sentry',
    official: true,
  },
  {
    service: 'linear',
    displayName: 'Linear',
    summary: 'Issues, cycles and projects in Linear.',
    transport: 'stdio',
    command: 'node',
    // `/mcp`, not `/sse`: the earlier entry used the SSE path and was removed as
    // unlaunchable. Measured 2026-08-05 — this path authorises against a public
    // redirect and returns a consent page.
    args: [`${BUILT_IN_SERVERS_TOKEN}/remote-bridge.js`, 'https://mcp.linear.app/mcp'],
    authMode: 'oauth',
    allowsSharing: false,
    keyHelpUrl: 'https://linear.app/docs/mcp',
    logo: 'linear',
    official: true,
  },
  {
    service: 'atlassian',
    displayName: 'Atlassian',
    summary: 'Jira issues and Confluence pages.',
    transport: 'stdio',
    command: 'node',
    // Streamable HTTP authv2 endpoint recorded in the M0b evidence ledger. The
    // legacy /v1/sse path requires a second GET channel and is deliberately not
    // handed to the POST-based bridge.
    args: [
      `${BUILT_IN_SERVERS_TOKEN}/remote-bridge.js`,
      'https://mcp.atlassian.com/v1/mcp/authv2',
    ],
    authMode: 'oauth',
    allowsSharing: false,
    keyHelpUrl: 'https://support.atlassian.com/atlassian-rovo-mcp-server/',
    logo: 'atlassian',
    official: true,
  },
  // ── Platforms taken from a partner tools portal (tt.example.com) ────
  // Only the four that HAVE a published MCP server are here. The portal also
  // lists Tamara, Geidea, ZATCA, Google Business, webook, VisitSaudi, TourHQ and
  // the government services — searched 2026-08-04, none publishes one, and
  // inventing a package name would produce a connector that cannot start.
  {
    service: 'salla',
    displayName: 'Salla',
    summary: 'Products, orders and customers in a Salla store.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@theyahia/salla-mcp'],
    keyEnvVar: 'SALLA_ACCESS_TOKEN',
    allowsSharing: true,
    keyHelpUrl: 'https://salla.dev/',
    keyLabel: 'OAuth access token',
    logo: 'salla',
    official: false,
    // The publisher archived `mcp-servers` and moved the whole collection to
    // `WWmcp`; the npm package name and version did not change. Pointing at the
    // grave would answer "who publishes this?" with a read-only repository whose
    // salla is frozen two majors behind what actually runs (owner report,
    // 2026-08-07).
    vendorUrl: 'https://github.com/theYahia/WWmcp/tree/main/servers/salla',
  },
  {
    service: 'infomaniak-mail',
    displayName: 'Infomaniak Mail',
    summary: 'Read and send mail, and manage mailboxes.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@infomaniak/mcp-server-mail'],
    keyEnvVar: 'MAIL_TOKEN',
    allowsSharing: false,
    keyHelpUrl: 'https://manager.infomaniak.com/v3/ng/accounts/token/list',
    keyLabel: 'API token',
    logo: 'infomaniak',
    official: true,
  },
  {
    service: 'infomaniak-contacts',
    displayName: 'Infomaniak Contacts',
    summary: 'Address book and contacts.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@infomaniak/mcp-server-contact'],
    keyEnvVar: 'CONTACT_TOKEN',
    allowsSharing: false,
    keyHelpUrl: 'https://manager.infomaniak.com/v3/ng/accounts/token/list',
    keyLabel: 'API token',
    logo: 'infomaniak',
    official: true,
  },
  {
    service: 'viator',
    displayName: 'Viator',
    summary: 'Tours and activities through the Viator partner API.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@chrischall/viator-mcp'],
    keyEnvVar: 'VIATOR_API_KEY',
    allowsSharing: true,
    keyHelpUrl: 'https://partnerresources.viator.com/',
    keyLabel: 'Partner API key',
    official: false,
    vendorUrl: 'https://github.com/chrischall/viator-mcp',
  },
  {
    service: 'getyourguide',
    displayName: 'GetYourGuide',
    summary: 'Tours and activities through the GetYourGuide partner API.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'getyourguide-mcp'],
    keyEnvVar: 'GYG_API_KEY',
    allowsSharing: true,
    keyHelpUrl: 'https://supplier.getyourguide.com/',
    keyLabel: 'Partner API key',
    logo: 'getyourguide',
    official: false,
    vendorUrl: 'https://github.com/chrischall/getyourguide-mcp',
  },
  {
    service: 'tamara',
    displayName: 'Tamara',
    summary: 'Order status and payment details from Tamara.',
    transport: 'stdio',
    // nassaj's own REST connector — Tamara publishes no MCP server, and its API
    // is a bearer token plus documented GETs (docs.tamara.co).
    command: 'node',
    args: [`${BUILT_IN_SERVERS_TOKEN}/rest-connector.js`, 'tamara'],
    keyEnvVar: 'TAMARA_API_TOKEN',
    // A merchant token belongs to the store, not to a person.
    allowsSharing: true,
    keyHelpUrl: 'https://docs.tamara.co/docs/direct-quick-start-guide',
    keyLabel: 'Merchant API token',
    logo: 'tamara',
    logoExt: 'png',
    official: true,
  },
  {
    service: 'geidea',
    displayName: 'Geidea',
    summary: 'Transactions, orders and payment links from Geidea.',
    transport: 'stdio',
    command: 'node',
    args: [`${BUILT_IN_SERVERS_TOKEN}/rest-connector.js`, 'geidea'],
    // Geidea authenticates with HTTP Basic: the merchant PUBLIC key as the
    // username and the API password as the password. Only the password is a
    // secret, so the public key travels as configuration and may be shown back.
    keyEnvVar: 'GEIDEA_API_PASSWORD',
    extraEnv: [
      { id: 'merchantPublicKey', envVar: 'GEIDEA_PUBLIC_KEY', label: 'Merchant public key', hint: '0000aaaa-…' },
    ],
    allowsSharing: true,
    keyHelpUrl: 'https://docs.geidea.net/docs/pre-requisites',
    keyLabel: 'API password',
    logo: 'geidea',
    logoExt: 'png',
    official: true,
  },
  // ── Google's own managed MCP servers (measured live 2026-08-05) ────────────
  // Each answered `initialize` with 200 and points authorization at
  // accounts.google.com, so nassaj fronts them with the generic bridge plus an
  // app the operator registers once in Google Cloud. READ-ONLY scopes: a
  // connector that can delete mail is a different conversation entirely.
  {
    service: 'google-calendar',
    displayName: 'Google Calendar',
    summary: 'Read calendars, events and availability.',
    transport: 'stdio',
    command: 'node',
    args: [
      `${BUILT_IN_SERVERS_TOKEN}/remote-bridge.js`,
      'https://calendarmcp.googleapis.com/mcp/v1',
    ],
    authMode: 'oauth',
    oauthClient: {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      clientEnvPrefix: 'NASSAJ_OAUTH_GOOGLE',
      registerAppUrl: 'https://console.cloud.google.com/apis/credentials',
      providerProfile: 'google',
    },
    allowsSharing: false,
    keyHelpUrl: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
    logo: 'googlecalendar',
    official: true,
  },
  {
    service: 'google-drive',
    displayName: 'Google Drive',
    summary: 'Search files and read document content.',
    transport: 'stdio',
    command: 'node',
    args: [
      `${BUILT_IN_SERVERS_TOKEN}/remote-bridge.js`,
      'https://drivemcp.googleapis.com/mcp/v1',
    ],
    authMode: 'oauth',
    oauthClient: {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      clientEnvPrefix: 'NASSAJ_OAUTH_GOOGLE',
      registerAppUrl: 'https://console.cloud.google.com/apis/credentials',
      providerProfile: 'google',
    },
    allowsSharing: false,
    keyHelpUrl: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
    logo: 'googledrive',
    official: true,
  },
  {
    service: 'gmail',
    displayName: 'Gmail',
    summary: 'Search messages and read threads.',
    transport: 'stdio',
    command: 'node',
    args: [
      `${BUILT_IN_SERVERS_TOKEN}/remote-bridge.js`,
      'https://gmailmcp.googleapis.com/mcp/v1',
    ],
    authMode: 'oauth',
    oauthClient: {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      clientEnvPrefix: 'NASSAJ_OAUTH_GOOGLE',
      registerAppUrl: 'https://console.cloud.google.com/apis/credentials',
      providerProfile: 'google',
    },
    allowsSharing: false,
    keyHelpUrl: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
    logo: 'gmail',
    official: true,
  },
]);

/** Looks up one catalog entry by service id. */
export function catalogEntryFor(service: string): CatalogEntry | null {
  return CONNECTOR_CATALOG.find((entry) => entry.service === service) ?? null;
}
