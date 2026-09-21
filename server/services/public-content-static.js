/**
 * T-1800 — serve operator-published pages from the EXTERNAL content root.
 *
 * Mounted immediately before `express.static(dist)` and after every `/api`
 * route, so a published page keeps its existing public URL while its bytes live
 * outside the checkout, outside `dist/`, and outside the client asset inventory.
 *
 * SECURITY MODEL. These bytes are served from the Nassaj origin, so any script
 * in them would otherwise reach the user's session token in browser storage.
 * Three defences, none optional:
 *
 *   1. `sandbox` WITHOUT `allow-same-origin` (same rule as the sealed node
 *      overlay, `node-overlay-static.js`): the document gets an opaque origin,
 *      so it cannot read this origin's `localStorage`, cookies, or IndexedDB —
 *      even if the page ships script. `Access-Control-Allow-Origin: *` and
 *      `Cross-Origin-Resource-Policy: cross-origin` let that opaque document
 *      load its own sub-resources back from here.
 *   2. No service worker may ever be registered for published content:
 *      `Service-Worker-Allowed` is never emitted, and a request carrying the
 *      `Service-Worker` header is a 404. A worker here would proxy the whole
 *      origin.
 *   3. The bare origin root (`/`) is never served — the identifier segment is
 *      mandatory, so nothing here can shadow the application shell at `/`.
 *      `/<site-id>/` serves that site's OWN root `index.html` (the same file
 *      a manifest entry named `index.html` already grants, no laxer than any
 *      other asset), and `/<site-id>` alone (no trailing slash) is a 308
 *      redirect to `/<site-id>/` — issued ONLY after `readPublicSiteAsset`
 *      resolves that site's root `index.html` through the full admission
 *      chain (`PUBLIC_SITE_ID` match, not reserved, live pointer, sealed
 *      manifest, digest match), so an unknown, reserved, or withdrawn slug
 *      still falls through to the SPA (`next()`) instead of confirming a site
 *      exists by redirecting it. Neither path ever risks the shell itself:
 *      `<site-id>` cannot be empty, so it can never resolve to `/`.
 *
 * Reads go through `readPublicSiteAsset`, which walks every path segment with
 * `O_NOFOLLOW`, re-stats the chain, and matches the sha256 of the bytes it is
 * about to return against the signed-in-manifest digest. A miss is `next()` —
 * the SPA keeps its routes — and never an error page that would confirm what
 * exists.
 */
import {
    PublicPageUnavailable, PUBLIC_SITE_ID, isReservedPublicSiteId, publicSiteType, readPublicSiteAsset,
} from './public-page-manifest.mjs';

/** Sandboxed, script-isolated delivery. `allow-same-origin` is never present. */
export const PUBLIC_CONTENT_CSP = [
    'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
    "default-src 'self'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
].join('; ');

/** First-segment names the application owns; a publication may never claim them. */

/**
 * Split a request path into `{ siteId, relativePath }`, or null when the path
 * cannot address published content at all.
 *
 * `relativePath` is `null` for the bare `/<site-id>` form (no trailing
 * slash): that form never serves bytes directly, so the caller must confirm
 * the site's root `index.html` actually resolves before redirecting to
 * `/<site-id>/` — see the module header, defence 3.
 */
export function resolveRequestTarget(requestPath) {
    if (typeof requestPath !== 'string' || requestPath.includes('\0')) return null;
    const segments = requestPath.split('/');
    if (segments[0] !== '') return null;
    const siteId = segments[1];
    if (!siteId || !PUBLIC_SITE_ID.test(siteId) || isReservedPublicSiteId(siteId)) return null;
    const rest = segments.slice(2);
    // `/<site-id>` (no trailing slash): a redirect candidate, gated by the caller.
    if (rest.length === 0) return { siteId, relativePath: null };
    // `/<site-id>/` serves that site's own root index.html.
    if (rest.length === 1 && rest[0] === '') return { siteId, relativePath: 'index.html' };
    if (rest[rest.length - 1] === '') rest[rest.length - 1] = 'index.html';
    for (const segment of rest) {
        if (segment === '' || segment.startsWith('.')) return null;
    }
    if (!publicSiteType(rest[rest.length - 1])) return null;
    return { siteId, relativePath: rest.join('/') };
}

/**
 * Redirect `/<site-id>` to `/<site-id>/`, but only once the site's own root
 * `index.html` actually resolves through the full admission chain — an
 * unknown, reserved, or withdrawn slug falls through to `next()` instead,
 * so this never confirms a site's existence to an unauthenticated caller.
 *
 * It reads the whole `index.html` to answer a yes/no question, which is more
 * work than the answer needs. It stays that way deliberately: there is no
 * lighter existence check in this contract, and adding one means a SECOND
 * reader that repeats the pointer/tombstone/manifest/digest walk — two readers
 * that must agree forever, where the cheap one is the one an attacker probes.
 * The cost is bounded anyway (`PUBLIC_SITE_ASSET_MAX_BYTES`, and only on the
 * bare `/<site-id>` form, which redirects once and is then never requested).
 */
function redirectPublishedSiteRoot(req, res, next, dataRoot, siteId) {
    try {
        readPublicSiteAsset(dataRoot, siteId, 'index.html');
    } catch {
        return next();
    }
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    return res.redirect(308, `${req.path}/${query}`);
}

/**
 * Mount the external public-content reader on an Express app.
 *
 * @param {import('express').Express} app
 * @param {object} options
 * @param {string|null} options.dataRoot absolute external content root, or null to stay off
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @returns {{ enabled: boolean, reason: string }}
 */
export function mountPublicContent(app, { dataRoot, logger = console } = {}) {
    if (!dataRoot) return { enabled: false, reason: 'absent' };

    app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        // A service worker registered here would proxy the whole origin.
        if (req.headers['service-worker']) return next();

        const target = resolveRequestTarget(req.path || '/');
        if (!target) return next();

        // `/<site-id>` alone never serves bytes: redirect to the trailing-slash
        // form only once the site's own index.html actually resolves, so an
        // unknown or withdrawn slug falls through to the SPA (module header, §3).
        if (target.relativePath === null) return redirectPublishedSiteRoot(req, res, next, dataRoot, target.siteId);

        let asset;
        try {
            asset = readPublicSiteAsset(dataRoot, target.siteId, target.relativePath);
        } catch (error) {
            if (error instanceof PublicPageUnavailable) return next();
            return next();
        }

        res.setHeader('Content-Type', asset.mime);
        res.setHeader('Content-Security-Policy', PUBLIC_CONTENT_CSP);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('ETag', `"${asset.revision}"`);
        res.removeHeader('Service-Worker-Allowed');
        res.setHeader('Content-Length', String(asset.bytes.length));
        if (req.method === 'HEAD') return res.status(200).end();
        return res.status(200).end(asset.bytes);
    });

    logger.info?.('[public-content] enabled', { root: dataRoot });
    return { enabled: true, reason: 'ok' };
}
