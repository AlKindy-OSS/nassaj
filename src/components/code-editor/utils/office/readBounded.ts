/** Raised when a download exceeds the preview size cap. */
export class PreviewTooLargeError extends Error {
  constructor() {
    super('File exceeds the preview size limit');
    this.name = 'PreviewTooLargeError';
  }
}

/**
 * Reads a response body while counting bytes, cancelling the download as
 * soon as it passes `limit`. The server may stream without Content-Length,
 * so the declared size alone cannot be trusted to stop a large download.
 */
export async function readResponseBounded(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) throw new PreviewTooLargeError();
  const reader = response.body?.getReader();
  if (!reader) {
    // Only for environments without streamed bodies (every current browser has
    // them): the whole body is buffered before the size check can run.
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.length > limit) throw new PreviewTooLargeError();
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new PreviewTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
