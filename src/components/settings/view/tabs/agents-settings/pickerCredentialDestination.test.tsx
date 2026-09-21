/**
 * pickerCredentialDestination.test.tsx — **كل وجهةٍ يولّدها منتقي النماذج تهبط على
 * حقلٍ حقيقي لشركتها** (‏B-413).
 *
 * العطل الذي أوجب هذا الملف لم يكن قراراً خاطئاً بل **انحرافاً داخل الجلسة
 * نفسها**: T-1206 صحّحت قاعدة «أين تعيش بطاقة الاعتماد» في لوح المحرّكات ونسيت
 * المنتقي، فبقي زرّ «أضف مفتاح GLM» يرسل `{agent: 'claude'}` بينما بطاقة Z.AI
 * انتقلت إلى حساب OpenCode. النتيجة: صفحةٌ فيها بطاقة Anthropic وحدها، بلا رسالة
 * ولا إشارة — طريقٌ مسدود على المسار الأوّل لتفعيل المحرّك.
 *
 * ولهذا **الحارس أهمّ من الإصلاح**، ولهذا هو من هذا الشكل تحديداً: لا يفحص أن
 * الوجهة تساوي قيمةً مكتوبةً هنا (تلك إعادةُ صياغةٍ للكود تنجرف معه)، بل **يُصيّر
 * السطح الذي تشير إليه الوجهة ويطلب فيه حقلَ إدخالٍ لتلك الشركة بعينها**. أيّ
 * تغييرٍ لاحق في قاعدة الموضع — في `vendors.ts` أو في الشريط أو في المنتقي —
 * يُسقط هذا الاختبار قبل أن يصل المالك إلى طريق مسدود.
 *
 * RUNNER: vitest (jsdom). ‏`NODE_ENV=test` إلزامي في هذا الريبو.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      ((opts?.defaultValue as string) ?? key).replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
        opts?.[name] === undefined ? whole : String(opts[name])),
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('../../../../auth', () => ({
  useAuth: () => ({ user: { id: 1, username: 'owner', role: 'owner' } }),
}));

vi.mock('../../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async (url: string) => ({
    ok: true,
    json: async () => ({
      success: true,
      // لا مواضع من الخادم: البطاقة ترسم مواضع الكتالوج، وهو ما يفحصه الحارس —
      // الحقل يجب أن يوجد قبل أي جواب خادمي، وإلا لكان الفحص يقيس المُزيَّف.
      data: { companyId: url.split('/').slice(-2)[0], configured: false, writable: true, slots: [] },
    }),
  })),
}));

import {
  bodyCredentialDestination,
  rowsForBody,
  type CredentialDestination,
} from '../../../../chat/view/subcomponents/modelPickerRows';
import { ENABLED_VENDOR_PROVIDERS } from '../../../../provider-auth/vendorProviders';
import { COMPANY_NAME } from '../../../../../../shared/vendors';
import VendorsSettingsTab from '../vendors-settings/VendorsSettingsTab';

import { visibleSettingsAgents } from './visibleAgents';

afterEach(cleanup);

/**
 * كل صفٍّ مقفول يولّده المنتقي فعلاً، بلا أي مفتاح مخزَّن — الحالة التي يكون فيها
 * الزرّ هو المسار الوحيد إلى إدخال المفتاح.
 */
function lockedDestinations(): Array<{ label: string; destination: CredentialDestination }> {
  const found: Array<{ label: string; destination: CredentialDestination }> = [];

  for (const body of visibleSettingsAgents()) {
    for (const row of rowsForBody(body, {}, {})) {
      if (!row.locked) continue;
      expect(
        row.credentialDestination,
        `الصفّ المقفول «${row.key}» بلا وجهة — يَعِد بحقلٍ ولا يقول أين`,
      ).toBeTruthy();
      found.push({ label: row.key, destination: row.credentialDestination! });
    }
  }

  // وزرّ «أضف مفتاح <المزوّد>» فوق مجموعةٍ مقفولة (‏`isLockedVendor`) — نفس الوعد
  // من موضعٍ آخر، فيدخل الحارس نفسه.
  for (const vendor of ENABLED_VENDOR_PROVIDERS) {
    const destination = bodyCredentialDestination(vendor);
    expect(destination, `مجموعة «${vendor}» المقفولة بلا وجهة`).toBeTruthy();
    found.push({ label: `group:${vendor}`, destination: destination! });
  }

  return found;
}

describe('كل وجهةٍ من المنتقي تحمل حقل مفتاح شركتها (B-413)', () => {
  it('يولّد المنتقي صفوفاً مقفولةً أصلاً — وإلّا لحرس هذا الملفُّ فراغاً', () => {
    // اختبارٌ على الحارس نفسه: لو توقّف المنتقي عن توليد الصفوف المقفولة لصار كل
    // ما تحته يمرّ بلا أن يفحص شيئاً.
    expect(lockedDestinations().length).toBeGreaterThan(0);
  });

  it.each(lockedDestinations())(
    'الوجهة من $label تعرض حقل إدخالٍ لشركتها',
    async ({ destination }) => {
      // ‏T-1219 — الوجهة واحدة لكل مفتاح، فالسطح المُصيَّر واحد. وما يفحصه
      // الحارس لم يتغيّر: أن **حقل هذه الشركة بعينها** موجودٌ فيه. صفحةٌ فيها
      // بطاقة شركةٍ أخرى كانت ستمرّ لولا ذلك — وهي صورة العطل الأصلي (بطاقة
      // Anthropic في صفحةٍ طُلب فيها مفتاح Z.AI). وهو الآن يحرس الوعد الجديد
      // أيضاً: أن المنزل الواحد يسع **كل** شركةٍ يولّد المنتقي وجهةً إليها.
      const { container } = render(<VendorsSettingsTab />);

      await waitFor(() => {
        expect(
          container.querySelector(`#company-api-key-${destination.companyId}`)
            ?? container.querySelector(`[data-company-credential-action="${destination.companyId}"]`),
          `لا حقل لـ«${COMPANY_NAME[destination.companyId] ?? destination.companyId}» في وجهة الزرّ`,
        ).toBeTruthy();
      });
      // ومعه اسمُ الشركة مقروءاً: حقلٌ بلا لصيقةٍ تسمّي الشركة يترك القارئ يخمّن.
      expect(
        screen.getAllByText(
          new RegExp(COMPANY_NAME[destination.companyId] ?? destination.companyId),
        ).length,
      ).toBeGreaterThan(0);
    },
  );
});
