/**
 * T-2116: a refused attachment upload reads as one clear, localized sentence.
 * The server is authoritative: its 413 `attachment_too_large` carries the limit it
 * enforced, which the composer adopts at once. A 413 with no such body came from
 * the network path (proxy/tunnel), not from nassaj.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { describeAttachmentUploadFailure } from './attachmentUpload';
import { getAttachmentMaxMb, resetStoragePolicyForTests } from './storagePolicy';

const t = (key: string, options?: Record<string, unknown>) =>
  options?.maxMb !== undefined ? `${key}:${String(options.maxMb)}` : key;

function response(status: number, body: unknown, contentType = 'application/json'): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': contentType } });
}

beforeEach(() => resetStoragePolicyForTests());

describe('describeAttachmentUploadFailure', () => {
  it('server refusal names the enforced limit and the composer adopts it', async () => {
    const res = response(413, { error: 'File too large.', code: 'attachment_too_large', maxMb: 120 });
    expect(await describeAttachmentUploadFailure(res, t)).toBe('fileAttachment.errorSize:120');
    expect(getAttachmentMaxMb()).toBe(120);
  });

  it('a 413 without the server code is the network path refusing the size', async () => {
    const res = response(413, '<html>413 Request Entity Too Large</html>', 'text/html');
    expect(await describeAttachmentUploadFailure(res, t)).toBe('fileAttachment.errorProxyTooLarge');
    expect(getAttachmentMaxMb()).toBe(50);
  });

  it('other server errors keep their text', async () => {
    const res = response(400, { error: 'File type .exe is not allowed.' });
    expect(await describeAttachmentUploadFailure(res, t)).toBe('File type .exe is not allowed.');
  });

  it('an unreadable body falls back to the generic failure', async () => {
    const res = response(500, 'oops', 'text/plain');
    expect(await describeAttachmentUploadFailure(res, t)).toBe('fileAttachment.errorUpload');
  });

  it('ignores an invalid maxMb in a refusal', async () => {
    const res = response(413, { code: 'attachment_too_large', maxMb: 'x' });
    expect(await describeAttachmentUploadFailure(res, t)).toBe('fileAttachment.errorProxyTooLarge');
    expect(getAttachmentMaxMb()).toBe(50);
  });
});
