import { VendorAuthProvider } from '@/modules/providers/shared/vendor/vendor-auth.provider.js';

/**
 * DeepSeek auth: status derived from whether the user has a DEEPSEEK key in the
 * encrypted secrets store (hosted API, always "installed"). Never throws.
 */
export class DeepSeekProviderAuth extends VendorAuthProvider {
  constructor() {
    super('deepseek');
  }
}
