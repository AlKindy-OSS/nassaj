/**
 * client-ip — single source of truth for the caller's IP address (ADR-040).
 *
 * Security model: this app sits behind a Cloudflare Tunnel that connects to
 * 127.0.0.1, so the ONLY trustworthy source of the real client IP is
 * `cf-connecting-ip` — but only when the immediate TCP peer is loopback (i.e.
 * the request actually came through the local tunnel). When the immediate peer
 * is NOT loopback, the request reached the process directly and any
 * `cf-connecting-ip` header is attacker-controlled and must be ignored.
 *
 * Self-hosted reverse proxy (B-500 / T-1309): an operator who puts nginx or
 * Caddy on loopback in front of the app sets `NASSAJ_TRUSTED_PROXY_HOPS` to the
 * number of proxies they run (1 for one local nginx). Then, and only when the
 * immediate peer is loopback, the client is read from X-Forwarded-For exactly
 * `hops` entries from the right — entries further left were supplied by the
 * client and are ignored — and `cf-connecting-ip` is NOT trusted (a local proxy
 * passes it through from the client). Default 0 keeps the tunnel behaviour.
 *
 * Hard rules (do not relax):
 *   - NEVER call app.set('trust proxy', …) — Express's req.ip would then trust
 *     X-Forwarded-For unconditionally, defeating this guard.
 *   - X-Forwarded-For is read ONLY with a configured hop count AND a loopback
 *     peer; the selected entry must be a literal IP.
 *   - Fully defensive: any error returns null. Auditing/diagnostics must never
 *     break the request path.
 *
 * Accepts either an Express request or a raw Node IncomingMessage (so the WS
 * upgrade path can call it with `info.req`). Both expose `headers` and
 * `socket.remoteAddress`.
 */

import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

/** The loopback peer addresses that prove the request came via the local tunnel. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Upper bound for the configured hop count; anything else reads as 0. */
const MAX_TRUSTED_PROXY_HOPS = 10;

/** Minimal structural shape shared by Express requests and IncomingMessage. */
type IpSourceRequest = {
  headers?: Record<string, string | string[] | undefined> | IncomingMessage['headers'];
  socket?: { remoteAddress?: string | null } | null;
};

/**
 * Reads `NASSAJ_TRUSTED_PROXY_HOPS`: a whole number 1..10 enables proxy mode;
 * unset, empty, malformed or out of range yields 0 (tunnel mode, the default).
 */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NASSAJ_TRUSTED_PROXY_HOPS?.trim() ?? '';
  if (!/^\d{1,2}$/.test(raw)) {
    return 0;
  }
  const hops = Number(raw);
  return hops <= MAX_TRUSTED_PROXY_HOPS ? hops : 0;
}

/** First value of a header that may arrive as string | string[]. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The client as seen by the outermost trusted proxy: the X-Forwarded-For chain
 * plus the immediate peer, counted `hops` from the right (clamped to the left
 * end, as Express does). Null when the header is absent or the pick is not an IP.
 */
function forwardedClient(req: IpSourceRequest | IncomingMessage, remoteAddress: string, hops: number): string | null {
  const header = req.headers?.['x-forwarded-for'];
  const joined = Array.isArray(header) ? header.join(',') : header;
  if (typeof joined !== 'string' || joined.trim() === '') {
    return null;
  }
  const chain = [...joined.split(',').map((entry) => entry.trim()), remoteAddress];
  const candidate = chain[Math.max(0, chain.length - 1 - hops)];
  return candidate && isIP(candidate) ? candidate : null;
}

/**
 * Resolves the client IP. In proxy mode (see header) reads X-Forwarded-For
 * behind a loopback peer; otherwise trusts `cf-connecting-ip` ONLY when the
 * immediate TCP peer (socket.remoteAddress) is a loopback address. Falls back to
 * the direct remoteAddress. Returns null on any error or when nothing resolves.
 */
export function clientIp(req: IpSourceRequest | IncomingMessage | null | undefined): string | null {
  try {
    if (!req) {
      return null;
    }

    const remoteAddress = req.socket?.remoteAddress ?? null;
    if (!remoteAddress || !LOOPBACK_ADDRESSES.has(remoteAddress)) {
      return remoteAddress;
    }

    const hops = trustedProxyHops();
    if (hops > 0) {
      return forwardedClient(req, remoteAddress, hops) ?? remoteAddress;
    }

    const cfIp = firstHeader(req.headers?.['cf-connecting-ip']);
    if (typeof cfIp === 'string' && cfIp.trim() !== '') {
      return cfIp.trim();
    }

    return remoteAddress;
  } catch {
    return null;
  }
}
