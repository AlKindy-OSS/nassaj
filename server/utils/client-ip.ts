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
 * Hard rules (do not relax):
 *   - NEVER call app.set('trust proxy', …) — Express's req.ip would then trust
 *     X-Forwarded-For unconditionally, defeating this guard.
 *   - NEVER read X-Forwarded-For here. Only cf-connecting-ip, and only behind
 *     the loopback check.
 *   - Fully defensive: any error returns null. Auditing/diagnostics must never
 *     break the request path.
 *
 * Accepts either an Express request or a raw Node IncomingMessage (so the WS
 * upgrade path can call it with `info.req`). Both expose `headers` and
 * `socket.remoteAddress`.
 */

import type { IncomingMessage } from 'node:http';

/** The loopback peer addresses that prove the request came via the local tunnel. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Minimal structural shape shared by Express requests and IncomingMessage. */
type IpSourceRequest = {
  headers?: Record<string, string | string[] | undefined> | IncomingMessage['headers'];
  socket?: { remoteAddress?: string | null } | null;
};

/**
 * Resolves the client IP. Trusts `cf-connecting-ip` ONLY when the immediate TCP
 * peer (socket.remoteAddress) is a loopback address; otherwise returns the
 * direct remoteAddress. Returns null on any error or when nothing is resolvable.
 */
export function clientIp(req: IpSourceRequest | IncomingMessage | null | undefined): string | null {
  try {
    if (!req) {
      return null;
    }

    const remoteAddress = req.socket?.remoteAddress ?? null;

    if (remoteAddress && LOOPBACK_ADDRESSES.has(remoteAddress)) {
      const header = req.headers?.['cf-connecting-ip'];
      // cf-connecting-ip is a single IP, but headers can be string | string[].
      const cfIp = Array.isArray(header) ? header[0] : header;
      if (typeof cfIp === 'string' && cfIp.trim() !== '') {
        return cfIp.trim();
      }
    }

    return remoteAddress;
  } catch {
    return null;
  }
}
