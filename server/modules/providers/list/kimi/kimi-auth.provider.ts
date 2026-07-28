import { VendorAuthProvider } from '@/modules/providers/shared/vendor/vendor-auth.provider.js';

/**
 * Kimi auth: status is derived purely from whether the user has a KIMI key in the
 * encrypted secrets store (hosted API, always "installed"). Never throws.
 */
export class KimiProviderAuth extends VendorAuthProvider {
  constructor() {
    super('kimi');
  }
}
