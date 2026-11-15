import { VendorAuthProvider } from '@/modules/providers/shared/vendor/vendor-auth.provider.js';

/**
 * Kimi key status (ADR-229). Kimi is no longer a body, only an engine of the
 * Claude body, so its status is the Moonshot key slot alone: `authenticated`
 * means THIS member (or their grantor) holds a key. The Kimi Code subscription
 * login belonged to the removed body and is no longer read.
 */
export class KimiProviderAuth extends VendorAuthProvider {
  constructor() {
    super('kimi');
  }
}
