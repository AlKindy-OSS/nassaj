/**
 * Public session-share viewer page (GET /s/:id) and its asset CORS policy.
 *
 * The viewer shares the Nassaj origin, and the app keeps its auth token in
 * localStorage on that origin. The page is therefore delivered as a document with
 * an OPAQUE origin: the CSP `sandbox` directive (without allow-same-origin) denies
 * it storage, cookies and credentialed same-origin requests, and the rest of the CSP
 * confines script, style, font and fetch targets to what the viewer needs.
 *
 * Consequences handled here:
 *  - Module scripts, stylesheets and fonts are fetched by an opaque-origin document
 *    in CORS mode (`Origin: null`), so every static asset route answers with
 *    `Access-Control-Allow-Origin: *` (`publicAssetCors`). Assets are public,
 *    credential-less files, so a wildcard exposes nothing the origin does not
 *    already serve to anyone.
 *  - No `Cross-Origin-Opener-Policy` is sent: combined with `sandbox` it can turn the
 *    navigation into an error page in some browsers.
 *  - The page is read from the CURRENT promoted client generation (`dist/share.html`),
 *    so its hashed asset URLs always belong to the generation being served.
 */
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

const SHARE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Return the canonical origin for NASSAJ_PUBLIC_ORIGIN, or null when unset/invalid. */
export function parsePublicOrigin(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
        const url = new URL(value.trim());
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) return null;
        return url.origin;
    } catch {
        return null;
    }
}

/** The enforced Content-Security-Policy of the viewer page for one explicit origin. */
export function buildSharePageCsp(origin) {
    return [
        'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
        "default-src 'none'",
        `script-src ${origin}/assets/`,
        `style-src ${origin}/assets/ 'unsafe-inline'`,
        `font-src ${origin}/assets/`,
        'img-src data:',
        `connect-src ${origin}/api/session-shares/`,
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'",
    ].join('; ');
}

/** Mount on `/assets`: the opaque-origin viewer loads its bundle in CORS mode. */
export function publicAssetCors(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    next();
}

function notFound(res) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).end();
}

/**
 * Router for the viewer page. Mount before the static mounts and the SPA fallback.
 * Without an explicit valid public origin every /s/* request is a 404 (never the
 * SPA shell, never a page whose CSP would have to guess its origin).
 */
export function createSharePageRouter({ appRoot, publicOrigin }) {
    const origin = parsePublicOrigin(publicOrigin);
    const csp = origin ? buildSharePageCsp(origin) : null;
    const router = express.Router();

    // share.html lives in dist/ but is only ever delivered by the route below.
    router.get('/share.html', (_req, res) => notFound(res));

    router.get(/^\/s(?:\/.*)?$/, (req, res) => {
        const match = /^\/s\/([^/]+)\/?$/.exec(req.path);
        if (!origin || !match || !SHARE_ID.test(match[1])) return notFound(res);
        let html;
        try {
            html = fs.readFileSync(path.join(appRoot, 'dist', 'share.html'));
        } catch {
            return notFound(res);
        }
        // Drop the app-wide report-only policy; this page has its own enforced one.
        res.removeHeader('Content-Security-Policy-Report-Only');
        res.setHeader('Content-Security-Policy', csp);
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Robots-Tag', 'noindex,nofollow,noarchive');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.type('html');
        return res.send(html);
    });
    return router;
}
