/**
 * Client side of the secrets-file confirmation contract (B-1593).
 *
 * The server serves a project's own `.env*` or SQLite file only when the
 * request carries an explicit confirmation flag; otherwise it answers 428 with
 * SECRET_FILE_CONFIRMATION_CODE. `requestWithSecretConfirmation` sends the
 * request, and on that answer asks the user ("this is a secrets file, open
 * it?") and retries once with the flag. The running service's own secrets are
 * refused with 403 whatever the client sends.
 */
import i18n from 'i18next';

/** Error code of the 428 answer that asks for confirmation. */
export const SECRET_FILE_CONFIRMATION_CODE = 'secret_file_confirmation_required';

/** Outcome when the user declined to open a secrets file. */
export const SECRET_FILE_DECLINED = 'declined' as const;

/** True when `response` is the server asking to confirm a secrets file. */
export async function isSecretConfirmationRequired(response: Response): Promise<boolean> {
  if (response.status !== 428) return false;
  try {
    const body = await response.clone().json();
    return body?.code === SECRET_FILE_CONFIRMATION_CODE;
  } catch {
    return false;
  }
}

/**
 * Default prompt: a native confirm dialog with the localized question. Uses
 * the global i18next instance that src/i18n/config.js initialises at startup.
 */
export function confirmOpenSecretFile(fileName: string): boolean {
  return window.confirm(i18n.t('secretFile.confirm', { fileName }));
}

/**
 * Sends `request(confirmSecret)`. When the server asks for confirmation and
 * `alreadyConfirmed` is false, asks via `confirm` and retries once with the
 * flag. Resolves to the final response, or SECRET_FILE_DECLINED when the user
 * said no (nothing was read or written).
 */
export async function requestWithSecretConfirmation(
  request: (confirmSecret: boolean) => Promise<Response>,
  {
    fileName,
    alreadyConfirmed = false,
    confirm = confirmOpenSecretFile,
  }: { fileName: string; alreadyConfirmed?: boolean; confirm?: (fileName: string) => boolean },
): Promise<Response | typeof SECRET_FILE_DECLINED> {
  const first = await request(alreadyConfirmed);
  if (alreadyConfirmed || !(await isSecretConfirmationRequired(first))) return first;
  if (!confirm(fileName)) return SECRET_FILE_DECLINED;
  return request(true);
}
