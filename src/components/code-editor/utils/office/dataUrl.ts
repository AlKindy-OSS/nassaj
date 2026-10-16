// Embedded images and fonts reach the preview only as base64 data: URLs. The
// declared MIME type comes from the untrusted package ([Content_Types].xml),
// so it is ignored: the type is re-derived from the bytes' magic number and
// only an allow-listed raster image or font type is ever emitted.

export type DataUrlKind = 'image' | 'font';

type Signature = { mime: string; kind: DataUrlKind; test: (bytes: Uint8Array) => boolean };

const startsWith = (prefix: number[], offset = 0) => (bytes: Uint8Array): boolean =>
  prefix.every((byte, index) => bytes[offset + index] === byte);

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));

const SIGNATURES: Signature[] = [
  { mime: 'image/png', kind: 'image', test: startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: 'image/jpeg', kind: 'image', test: startsWith([0xff, 0xd8, 0xff]) },
  { mime: 'image/gif', kind: 'image', test: startsWith(ascii('GIF8')) },
  { mime: 'image/bmp', kind: 'image', test: startsWith(ascii('BM')) },
  { mime: 'image/webp', kind: 'image', test: (bytes) => startsWith(ascii('RIFF'))(bytes) && startsWith(ascii('WEBP'), 8)(bytes) },
  { mime: 'font/ttf', kind: 'font', test: startsWith([0x00, 0x01, 0x00, 0x00]) },
  { mime: 'font/ttf', kind: 'font', test: startsWith(ascii('true')) },
  { mime: 'font/otf', kind: 'font', test: startsWith(ascii('OTTO')) },
  { mime: 'font/collection', kind: 'font', test: startsWith(ascii('ttcf')) },
  { mime: 'font/woff', kind: 'font', test: startsWith(ascii('wOFF')) },
  { mime: 'font/woff2', kind: 'font', test: startsWith(ascii('wOF2')) },
];

const DATA_URL_HEAD = /^data:[a-z0-9.+/-]*(?:;[a-z0-9.+=-]*)*;base64,/i;
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;
const HEAD_CHARS = 16; // decodes to 12 bytes, enough for every signature above

/** Sniffs the first bytes of a base64 payload; null when it is not decodable. */
function sniff(payload: string): Signature | null {
  let head: string;
  try {
    head = atob(payload.slice(0, HEAD_CHARS - (Math.min(payload.length, HEAD_CHARS) % 4)));
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(head, (char) => char.charCodeAt(0));
  return SIGNATURES.find((signature) => signature.test(bytes)) ?? null;
}

/**
 * Returns a canonical `data:<allow-listed mime>;base64,<payload>` URL when the
 * input is a base64 data URL whose bytes are a known image or font, else null.
 */
export function canonicalDataUrl(url: string, allowed: readonly DataUrlKind[]): string | null {
  const value = url.trim();
  const head = DATA_URL_HEAD.exec(value);
  if (!head) return null;
  const payload = value.slice(head[0].length).replace(/\s+/g, '');
  if (payload === '' || !BASE64_BODY.test(payload)) return null;
  const signature = sniff(payload);
  if (!signature || !allowed.includes(signature.kind)) return null;
  return `data:${signature.mime};base64,${payload}`;
}
