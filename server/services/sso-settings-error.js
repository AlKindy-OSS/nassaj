/**
 * Client-safe refusal of the owner SSO settings services (ADR-194 D8/D9,
 * T-1962 S4). `code` is a fixed machine-readable string; `details` may carry
 * only fixed codes or counts, never a submitted value or a secret.
 */
export class SsoSettingsError extends Error {
  /**
   * @param {string} code
   * @param {number} [status]
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, status = 400, details = undefined) {
    super(code);
    this.name = 'SsoSettingsError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
