/**
 * Small-body reader shared by the install paths (ADR-215 ش3): installer
 * scripts, the claude `latest` pointer, manifest and signature. Large
 * payloads (the ~290 MB claude binary) stream through `downloadVerified`
 * in opencode-asset.ts instead; this reader keeps the whole body in memory.
 */

import { withAbort } from './opencode-asset.js';

/** Hard ceiling for any body read by `readCapped` (ش3: ≤ 64 KB…256 KB scripts). */
export const SMALL_BODY_MAX_BYTES = 256 * 1024;

/** Reads a response body, failing past `cap` bytes or when `signal` aborts. */
export async function readCapped(res: Response, cap: number, signal: AbortSignal): Promise<Uint8Array> {
  if (cap > SMALL_BODY_MAX_BYTES) throw new Error('readCapped is for small bodies only');
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > cap) throw Object.assign(new Error('too large'), { code: 'ASSET_TOO_LARGE' });
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  const read = () => withAbort(reader.read(), signal).catch(async (error: unknown) => {
    await reader.cancel().catch(() => {});
    throw error;
  });
  for (let r = await read(); !r.done; r = await read()) {
    total += r.value.length;
    if (total > cap) {
      await reader.cancel();
      throw Object.assign(new Error('too large'), { code: 'ASSET_TOO_LARGE' });
    }
    chunks.push(r.value);
  }
  return Buffer.concat(chunks);
}
