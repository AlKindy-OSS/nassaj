/**
 * Outbound address policy (ADR-194 D7 address matrix, T-1962 S2).
 *
 * `addressBlockCategory(address, policy, own)` returns null when a resolved
 * address may be connected to, otherwise a short category used in the typed
 * error `fetch_address_blocked:<category>`. Two policies:
 *
 *   public           — global unicast only.
 *   private_allowed  — additionally RFC1918, CGNAT and ULA (self-hosted IdPs on
 *                      a tailnet). Everything special stays blocked: loopback,
 *                      link-local, metadata, multicast, IETF/special ranges,
 *                      6to4, Teredo, NAT64, the tailnet resolver and this
 *                      host's own interface addresses.
 *
 * IPv4-mapped IPv6 is evaluated as its embedded IPv4. Unparseable input is
 * blocked. The legacy connector table is kept verbatim for the connector
 * wrapper (its behaviour is frozen by its own suite); a test proves `public`
 * blocks a superset of it.
 */
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

export type AddressPolicy = 'public' | 'private_allowed';

/** Canonical keys of this host's interface addresses (see `addressKey`). */
export type HostAddressSet = ReadonlySet<string>;

/** Cloud metadata endpoints reachable on IPv4 (AWS/GCP/Azure-style, Alibaba, Azure wire server). */
const METADATA_IPV4 = new Set(['169.254.169.254', '100.100.100.200', '168.63.129.16']);

/** Strict dotted-quad parse; null for anything else (leading zeros, short forms, ranges). */
export function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const octets = address.split('.').map(Number);
  return octets.length === 4 && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    ? octets : null;
}

/** Eight 16-bit words of an IPv6 address (dotted tail supported), or null. */
export function ipv6Words(address: string): number[] | null {
  let normalized = address.toLowerCase();
  const dotted = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (dotted) {
    const octets = dotted.split('.').map(Number);
    if (octets.length !== 4 || octets.some(value => value < 0 || value > 255)) return null;
    normalized = `${normalized.slice(0, -dotted.length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  if ((normalized.match(/::/gu) ?? []).length > 1) return null;
  const [leftRaw, rightRaw = ''] = normalized.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (!normalized.includes('::') && missing !== 0)) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right].map(word => Number.parseInt(word, 16));
  return words.length === 8 && words.every(word => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
}

/** Dotted IPv4 carried in the last two words of an IPv6 address. */
export const embeddedIpv4 = (high: number, low: number): string =>
  `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

const allZero = (words: number[], from: number, to: number): boolean =>
  words.slice(from, to).every((word) => word === 0);

const isMappedIpv4 = (words: number[]): boolean => allZero(words, 0, 5) && words[5] === 0xffff;

/**
 * Canonical comparison key: `v4:a.b.c.d` (IPv4-mapped IPv6 folds to its IPv4)
 * or `v6:<eight hex words>`; null when unparseable. Zone ids are dropped.
 */
export function addressKey(raw: string): string | null {
  const address = raw.split('%', 1)[0];
  const octets = parseIpv4(address);
  if (octets) return `v4:${octets.join('.')}`;
  const words = isIP(address) === 6 ? ipv6Words(address) : null;
  if (!words) return null;
  if (isMappedIpv4(words)) return `v4:${embeddedIpv4(words[6], words[7])}`;
  return `v6:${words.map((word) => word.toString(16)).join(':')}`;
}

/** This host's interface addresses, enumerated at call time (D7). */
export function hostInterfaceAddresses(
  source: () => ReturnType<typeof networkInterfaces> = networkInterfaces,
): HostAddressSet {
  const keys = new Set<string>();
  for (const entries of Object.values(source())) {
    for (const entry of entries ?? []) {
      const key = addressKey(entry.address);
      if (key) keys.add(key);
    }
  }
  return keys;
}

function isIetfSpecialIpv4([a, b, c]: number[]): boolean {
  return (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || (a === 192 && b === 88 && c === 99);
}

/** Ranges blocked under every policy, IPv4. */
function ipv4SpecialCategory(octets: number[]): string | null {
  const [a, b] = octets;
  const dotted = octets.join('.');
  if (a === 127) return 'loopback';
  if (a === 0) return 'unspecified';
  if (METADATA_IPV4.has(dotted)) return 'metadata';
  if (a === 169 && b === 254) return 'link_local';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  if (isIetfSpecialIpv4(octets)) return 'special';
  if (dotted === '100.100.100.100') return 'tailnet_resolver';
  return null;
}

function ipv4PrivateCategory([a, b]: number[]): string | null {
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  return null;
}

function ipv4Category(address: string, policy: AddressPolicy, own: HostAddressSet): string | null {
  const octets = parseIpv4(address);
  if (!octets) return 'invalid';
  const special = ipv4SpecialCategory(octets);
  if (special) return special;
  if (own.has(`v4:${octets.join('.')}`)) return 'own_interface';
  const privateCategory = ipv4PrivateCategory(octets);
  return privateCategory !== null && policy === 'public' ? privateCategory : null;
}

const isMetadataIpv6 = (w: number[]): boolean =>
  w[0] === 0xfd00 && w[1] === 0x0ec2 && allZero(w, 2, 7) && w[7] === 0x254;

const isTailnetResolverIpv6 = (w: number[]): boolean =>
  w[0] === 0xfd7a && w[1] === 0x115c && w[2] === 0xa1e0 && allZero(w, 3, 7) && w[7] === 0x53;

const isDocumentationIpv6 = (w: number[]): boolean =>
  (w[0] === 0x2001 && w[1] === 0x0db8) || (w[0] === 0x3fff && (w[1] & 0xf000) === 0)
  || (w[0] === 0x0100 && allZero(w, 1, 4));

/** Transition encodings are rejected outright: they tunnel to an address we cannot vet. */
function ipv6TransitionCategory(w: number[]): string | null {
  if (w[0] === 0x64 && w[1] === 0xff9b && (allZero(w, 2, 6) || w[2] === 1)) return 'nat64';
  if (w[0] === 0x2002) return '6to4';
  if (w[0] === 0x2001 && w[1] < 0x0200) return 'teredo';
  if (allZero(w, 0, 6)) return 'ipv4_compatible';
  return null;
}

/** Ranges blocked under every policy, IPv6 (mapped IPv4 handled by the caller). */
function ipv6SpecialCategory(w: number[]): string | null {
  if (allZero(w, 0, 8)) return 'unspecified';
  if (allZero(w, 0, 7) && w[7] === 1) return 'loopback';
  const transition = ipv6TransitionCategory(w);
  if (transition) return transition;
  if ((w[0] & 0xffc0) === 0xfe80) return 'link_local';
  if ((w[0] & 0xff00) === 0xff00) return 'multicast';
  if (isMetadataIpv6(w)) return 'metadata';
  if (isTailnetResolverIpv6(w)) return 'tailnet_resolver';
  if (isDocumentationIpv6(w)) return 'special';
  return null;
}

function ipv6Category(address: string, policy: AddressPolicy, own: HostAddressSet): string | null {
  const words = ipv6Words(address);
  if (!words) return 'invalid';
  if (isMappedIpv4(words)) return ipv4Category(embeddedIpv4(words[6], words[7]), policy, own);
  const special = ipv6SpecialCategory(words);
  if (special) return special;
  if (own.has(addressKey(address) ?? '')) return 'own_interface';
  if ((words[0] & 0xfe00) === 0xfc00) return policy === 'public' ? 'ula' : null;
  return (words[0] & 0xe000) === 0x2000 ? null : 'non_global';
}

/**
 * D7 decision for one resolved address: null = allowed, otherwise the block
 * category. Never throws; anything unparseable is `invalid`.
 */
export function addressBlockCategory(
  rawAddress: string,
  policy: AddressPolicy,
  own: HostAddressSet = new Set(),
): string | null {
  if (typeof rawAddress !== 'string') return 'invalid';
  const address = rawAddress.split('%', 1)[0];
  const family = isIP(address);
  if (family === 4) return ipv4Category(address, policy, own);
  if (family === 6) return ipv6Category(address, policy, own);
  return 'invalid';
}

/**
 * The connector table as it stood before D7 (kept verbatim: the connector
 * wrapper's behaviour is frozen by its suite). IPv4.
 */
function legacyIpv4IsForbidden(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2)))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

/** IPv4-compatible, IPv4-mapped and well-known NAT64 forms inherit the IPv4 decision. */
function legacyEmbeddedForbidden(words: number[]): boolean | null {
  const embedded = () => legacyIpv4IsForbidden(embeddedIpv4(words[6], words[7]));
  if (allZero(words, 0, 6)) return embedded();
  if (isMappedIpv4(words)) return embedded();
  if (words[0] === 0x64 && words[1] === 0xff9b && allZero(words, 2, 6)) return embedded();
  return null;
}

/** The legacy connector address table (pre-D7). True = forbidden. */
export function legacyConnectorAddressForbidden(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return legacyIpv4IsForbidden(address);
  if (family !== 6) return true;
  const words = ipv6Words(address);
  if (!words) return true;
  const embedded = legacyEmbeddedForbidden(words);
  if (embedded !== null) return embedded;
  const [first] = words;
  if (first === 0x64 && words[1] === 0xff9b && words[2] === 1) return true;
  if ((first & 0xe000) !== 0x2000) return true;
  return first === 0x2002
    || (first === 0x2001 && words[1] < 0x0200)
    || (first === 0x2001 && words[1] === 0x0db8)
    || (first === 0x3fff && (words[1] & 0xf000) === 0);
}
