import { VendorAuthProvider } from '@/modules/providers/shared/vendor/vendor-auth.provider.js';
import { detectKimiAuthMode } from './kimi-auth-mode.js';

/**
 * Kimi auth: `authenticated` يبقى مبنياً على مفتاح API (المسار الفعلي
 * للمحادثة حالياً)، لكن `authMode` يكشف المسارَين معاً: اشتراك Kimi Code
 * (OAuth من `~/.kimi-code/credentials/`) ومفتاح API من مخزن الأسرار.
 * الاكتشاف قراءة ملف + مخزن، لا يُطلق عملية ولا يجدّد توكناً.
 */
export class KimiProviderAuth extends VendorAuthProvider {
  constructor() {
    super('kimi');
  }

  async getStatus(userId?: string | number | null) {
    const base = await super.getStatus(userId);
    const authMode = await detectKimiAuthMode(userId ?? null);
    return { ...base, authMode };
  }
}
