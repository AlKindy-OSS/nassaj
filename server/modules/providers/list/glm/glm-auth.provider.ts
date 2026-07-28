import { VendorAuthProvider } from '@/modules/providers/shared/vendor/vendor-auth.provider.js';

/**
 * GLM auth: status derived from whether the user has a GLM key in the encrypted
 * secrets store (hosted API, always "installed"). Never throws.
 */
export class GlmProviderAuth extends VendorAuthProvider {
  constructor() {
    super('glm');
  }
}
