/** First-origin bootstrap refusal and its operator-visible HTTP mapping (B-1461, ADR-193 H3). */

/**
 * Why a first origin bind was refused:
 * - `startup_profile`: this start-up profile does not allow an initial bind
 *   (allowInitialOriginBootstrap=false, e.g. an existing-installation start; T-1958);
 * - `existing_installation_effects`: the installation already produced connector
 *   effects or origin history, so a silent first bind is unsafe.
 */
export type ConnectorOriginBootstrapRefusalReason = 'startup_profile' | 'existing_installation_effects';

/** Thrown by the first-origin bind path. The message stays `connector_origin_bootstrap_unsafe`. */
export class ConnectorOriginBootstrapRefusedError extends Error {
  constructor(readonly reason: ConnectorOriginBootstrapRefusalReason) {
    super('connector_origin_bootstrap_unsafe');
    this.name = 'ConnectorOriginBootstrapRefusedError';
  }
}

export type ConnectorOriginBootstrapRefusalResponse = Readonly<{
  status: 409; body: Readonly<{ code: 'CONNECTOR_ORIGIN_BOOTSTRAP_REFUSED'; reason: ConnectorOriginBootstrapRefusalReason }>;
}>;

/** Maps a bootstrap refusal to 409 CONNECTOR_ORIGIN_BOOTSTRAP_REFUSED with its reason; otherwise null. */
export const connectorOriginBootstrapRefusal = (error: unknown): ConnectorOriginBootstrapRefusalResponse | null =>
  error instanceof ConnectorOriginBootstrapRefusedError
    ? Object.freeze({ status: 409 as const, body: Object.freeze({
      code: 'CONNECTOR_ORIGIN_BOOTSTRAP_REFUSED' as const, reason: error.reason }) })
    : null;
