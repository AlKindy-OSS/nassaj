/**
 * Turns a refused attachment upload into one clear, localized sentence (T-2116).
 *
 * The server is authoritative: a 413 with code `attachment_too_large` carries the
 * limit it enforced, which is published so every open composer refuses early
 * from then on. A 413 without that code came from the network path in front of
 * nassaj (a proxy or tunnel with its own body cap), not from the owner's setting.
 */

import { publishStoragePolicy } from './storagePolicy';

type Translate = (key: string, options?: Record<string, unknown>) => string;

type UploadErrorBody = { error?: unknown; code?: unknown; maxMb?: unknown };

async function readErrorBody(response: Response): Promise<UploadErrorBody | null> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' ? (body as UploadErrorBody) : null;
  } catch {
    return null;
  }
}

function isValidMb(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * @param response - the non-OK response of POST /upload-attachments
 * @param t - i18n translate bound to the `chat` namespace
 * @returns the message to show the sender
 */
export async function describeAttachmentUploadFailure(response: Response, t: Translate): Promise<string> {
  const body = await readErrorBody(response);
  if (body?.code === 'attachment_too_large' && isValidMb(body.maxMb)) {
    publishStoragePolicy({ attachmentMaxMb: body.maxMb });
    return t('fileAttachment.errorSize', { maxMb: body.maxMb });
  }
  if (response.status === 413) return t('fileAttachment.errorProxyTooLarge');
  if (typeof body?.error === 'string' && body.error) return body.error;
  return t('fileAttachment.errorUpload');
}
