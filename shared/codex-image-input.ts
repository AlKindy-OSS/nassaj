export const CODEX_IMAGE_INPUT_MAX_COUNT = 15;
export const CODEX_IMAGE_INPUT_MAX_BYTES = 4 * 1024 * 1024;

const DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp);base64,([a-zA-Z0-9+/]+={0,2})$/u;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export type CodexImageInputRejection = 'invalid' | 'unsupported' | 'too_large';

/** Browser-safe validation shared by Codex ingress and its native receipt proof. */
export function validateCodexImageInput(
  text: unknown,
  dataUrls: unknown,
): { ok: true; dataUrls: string[] } | { ok: false; reason: CodexImageInputRejection } {
  if (typeof text !== 'string' || !Array.isArray(dataUrls)) return { ok: false, reason: 'invalid' };
  if (dataUrls.length > CODEX_IMAGE_INPUT_MAX_COUNT) return { ok: false, reason: 'too_large' };
  let bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > CODEX_IMAGE_INPUT_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const accepted: string[] = [];
  for (const candidate of dataUrls) {
    if (typeof candidate !== 'string') return { ok: false, reason: 'invalid' };
    const match = candidate.match(DATA_URL);
    if (!match) return { ok: false, reason: candidate.startsWith('data:image/') ? 'unsupported' : 'invalid' };
    const body = match[1];
    if (body.length % 4 !== 0) return { ok: false, reason: 'invalid' };
    const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
    const lastData = body[body.length - padding - 1];
    const lastValue = BASE64_ALPHABET.indexOf(lastData);
    if (lastValue < 0 || (padding === 2 && (lastValue & 0x0f) !== 0)
      || (padding === 1 && (lastValue & 0x03) !== 0)) return { ok: false, reason: 'invalid' };
    bytes += candidate.length;
    if (bytes > CODEX_IMAGE_INPUT_MAX_BYTES) return { ok: false, reason: 'too_large' };
    accepted.push(candidate);
  }
  if (!text.trim() && accepted.length === 0) return { ok: false, reason: 'invalid' };
  return { ok: true, dataUrls: accepted };
}
