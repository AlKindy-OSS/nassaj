/**
 * Rate-limit bucket key for a client IP (ADR-205 D7).
 *
 * IPv4 is used as is; an IPv4-mapped IPv6 address collapses to its IPv4 form;
 * any other IPv6 address collapses to its /64 prefix, because one client
 * controls a whole /64 and can rotate addresses inside it; anything missing or
 * unparsable becomes `unknown`.
 */
import { isIP } from 'node:net';

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Expands an IPv6 literal (no zone, no embedded IPv4) to eight hextets, or null. */
function hextets(address: string): string[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  return all.every((part) => /^[0-9a-f]{1,4}$/i.test(part)) ? all.map((part) => part.toLowerCase().replace(/^0+(?=.)/, '')) : null;
}

/** Rewrites a trailing dotted IPv4 (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) as two hextets. */
function embeddedV4ToHex(address: string): string {
  const match = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return address;
  const [a, b, c, d] = match.slice(2).map(Number);
  return `${match[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
}

/**
 * Bucket key for `ip`.
 * @param ip address as resolved by `clientIp` (may be null)
 * @returns `a.b.c.d`, `<h1>:<h2>:<h3>:<h4>::/64`, or `unknown`
 */
export function ipRateKey(ip: string | null | undefined): string {
  if (typeof ip !== 'string') return 'unknown';
  const address = ip.trim().replace(/%.*$/, '');
  const mapped = MAPPED_V4.exec(address);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return 'unknown';
  const parts = hextets(embeddedV4ToHex(address));
  return parts ? `${parts.slice(0, 4).join(':')}::/64` : 'unknown';
}
