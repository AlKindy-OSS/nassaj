/**
 * B-1699: whether a request comes straight from this host — a loopback TCP peer
 * carrying no proxy or forwarding header. The tunnel also connects over loopback,
 * but always adds such a header, so a remote caller never passes. Used to publish
 * host-local details (wake-up hold pids) on the otherwise public /health.
 */

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Headers any proxy in front of the server may add; one present ⇒ not direct. */
const PROXY_HEADERS = Object.freeze([
  'cf-connecting-ip', 'x-forwarded-for', 'forwarded', 'x-real-ip', 'true-client-ip', 'via',
]);

/**
 * @param {{ socket?: { remoteAddress?: string }, headers?: Record<string, unknown> }} req
 * @returns {boolean}
 */
export function isDirectLocalRequest(req) {
  if (!LOOPBACK_PEERS.has(req?.socket?.remoteAddress)) return false;
  const headers = req.headers || {};
  return PROXY_HEADERS.every((name) => headers[name] === undefined || headers[name] === '');
}

export { PROXY_HEADERS };
