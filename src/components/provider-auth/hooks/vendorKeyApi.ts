/**
 * Shared reading of a failed vendor-key / link-mode / backup response
 * (ADR-200 S9). The server answers an `AppError` as
 * `{ success: false, error: { code, message, details, ...details } }`; older
 * routes answer `{ error: "text" }`. Both are read into one shape so a caller
 * branches on `code` and never renders an object.
 */

export type ApiFailure = {
  status: number;
  code: string | null;
  message: string;
  details: Record<string, unknown>;
};

type ErrorPayload = {
  error?: string | { code?: unknown; message?: unknown; details?: unknown };
  message?: string;
};

function asDetails(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Reads the failure out of a non-OK response; never throws. */
export async function readApiFailure(response: Response, fallback: string): Promise<ApiFailure> {
  try {
    const payload = (await response.json()) as ErrorPayload;
    const error = payload?.error;
    if (typeof error === 'object' && error !== null) {
      return {
        status: response.status,
        code: typeof error.code === 'string' ? error.code : null,
        message: typeof error.message === 'string' ? error.message : fallback,
        details: asDetails(error.details),
      };
    }
    return {
      status: response.status,
      code: null,
      message: typeof error === 'string' ? error : (payload?.message ?? fallback),
      details: {},
    };
  } catch {
    return { status: response.status, code: null, message: fallback, details: {} };
  }
}

export const NETWORK_FAILURE: ApiFailure = {
  status: 0,
  code: 'NETWORK_ERROR',
  message: 'Network error',
  details: {},
};

/** Link-mode harnesses (the two with a subscription / API-key choice). */
export type LinkHarness = 'claude' | 'codex';

export type LinkMode = 'subscription' | 'api_key';
