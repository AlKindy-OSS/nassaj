import { Building2 } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../shared/view/ui';
import SettingsSection from '../../SettingsSection';
import { vendorsByCompany } from '../../../../../../shared/vendors';

import CompanyCredentialCard from './CompanyCredentialCard';
import VoiceTranscriptionSection from './VoiceTranscriptionSection';

/**
 * VendorsSettingsTab — «المورّدون والاعتمادات»: **المنزل الوحيد لكل مفتاح**
 * (‏T-1219، قرار المالك 2026-08-04).
 *
 * ## القاعدة، وهي سطرٌ واحد بلا استثناء
 *
 *   > كلُّ حقل إدخال مفتاحٍ في نسّاج يُصيَّر من هنا. ولا حقلَ في أي سطحٍ آخر.
 *
 * وقيمةُ هذه الصياغة أنها **لا شرطية فيها**. الترتيب السابق (T-1205 ثم T-1206)
 * قسم المفاتيح بين سطحين بقاعدة «شركةٌ وكيلُها ظاهر ⇒ حسابُه، وإلا ⇒ هنا»،
 * فصارت سلامةُ النظام — ألّا يوجد كاتبان لسجلٍّ واحد، وهو عطل B-343 — معلَّقةً
 * على اتّفاق ثلاث دوالّ في ثلاثة ملفّات (`companyHomeAgent`،
 * `vendorIsNativeToAgent`، وشرطيةُ هذا التبويب). قاعدةٌ بلا فرعٍ لا تنحرف.
 *
 * ## وما الذي كلّفه الفرعان
 *
 * صفحةُ OpenCode كانت تُصيّر أربع بطاقاتٍ كاملة — لأنها حاملٌ لأربعة مورّدين —
 * كلُّ بطاقةٍ بحقلٍ وزرِّ حفظٍ ومربّعاتِ وجهةٍ ووصفٍ مطابقٍ لأخواتها. وهو التكرار
 * الذي رصده المالك حرفياً. وقد صارت الآن أربعةَ **صفوفٍ** في صفحة الوكيل
 * (‏`AgentVendorCredentials`): اسمٌ وحالةٌ وإشارةٌ إلى هنا.
 *
 * ## ولماذا الكتالوج كاملاً وبترتيبه
 *
 * `vendorsByCompany()` بلا تصفيةٍ بالوكلاء الظاهرين: شركةٌ لا وكيلَ ظاهر لها
 * (‏DeepSeek، ومستهلكُها الأصيل معطَّلٌ عالمياً) كان مفتاحُها قبل T-1206 غيرَ
 * قابلٍ للإدخال في أي مكان، بلا رسالة خطأ. والقائمةُ الكاملة تجعل ذلك مستحيلاً
 * بالبناء لا بحارس: ما دام للشركة صفٌّ في الكتالوج فلها حقلٌ في هذه الشاشة.
 */
export default function VendorsSettingsTab({
  focusCompanyId,
  onQwenConnect,
}: {
  focusCompanyId?: string;
  onQwenConnect?: () => void;
}) {
  const { t } = useTranslation('settings');

  useEffect(() => {
    if (!focusCompanyId) return;

    const field = document.getElementById(`company-api-key-${focusCompanyId}`);
    if (!(field instanceof HTMLElement)) return;

    field.scrollIntoView?.({ block: 'center' });
    field.focus({ preventScroll: true });
  }, [focusCompanyId]);

  return (
    <div className="space-y-8">
    <SettingsSection
      level="page"
      // ‏`Building2` كما في بند الشريط الجانبي: رأسُ الصفحة وبندُ التنقّل إليها
      // لا يجوز أن يحملا رمزين مختلفين — المورّد **شركة**، والمفتاح لتبويب آخر.
      icon={Building2}
      title={t('vendors.title', { defaultValue: 'Vendors & credentials' })}
      /*
        **بلا وصفٍ للصفحة** (‏T-1223). كان: «كل مفاتيح API التي يحملها نسّاج، تُدخَّل
        هنا وهنا وحده. لكل شركة مفتاح واحد، ومواضع كتابته هي المربّعات التي
        تحدّدها داخل بطاقتها» — ثلاثُ جملٍ تشرح شاشةً صارت تشرح نفسها: عمودُ أسماءٍ
        وحقولٌ وأزرارُ حفظ. والشرحُ فوق شاشةٍ مفهومة هو ما جعلها تُقرأ «تعليمية».
      */
    >
      {/*
        صفوفٌ بإيقاعٍ رأسي، **بلا صناديق وبلا خطوط**.

        الصناديق سقطت لأن ستّةً منها متجاورةً تحت عنوانٍ يجمعها أصلاً تقول «ستّةُ
        موضوعات»، والحقيقة موضوعٌ واحد بستّة صفوف.

        والخطوط لم تحلّ محلَّها رغم أن هذه **قائمةٌ متجانسة** — وهي الحالة التي
        يسمح فيها الـBrief بالخطّ. القناة الوحيدة إليه `SettingsGroup divided`،
        ومالكُها ملفٌّ واحد بقرار المالك: «ممكن تُستخدم في صفحة المستخدمين، لكن لا
        تُعمَّم كنمط على كل ما يشبهها». وإضافةُ مالكٍ ثانٍ هي أوّلُ خطوةٍ في ذلك
        التعميم بعينه، والفراغُ يفصل ما يكفي بلا أن يستأذن أحداً.
      */}
      <div className="space-y-1">
        {vendorsByCompany().map((company) => company.id === 'alibaba-cloud' ? (
          <div key={company.id} data-company={company.id} className="grid grid-cols-1 items-center gap-2 py-2.5 sm:grid-cols-[7rem_1fr_auto]">
            <span dir="ltr" className="text-start text-[15px] font-medium text-foreground">
              {company.name}
            </span>
            <span className="text-[13px] text-muted-foreground">
              {t('vendors.qwenManaged', {
                defaultValue: 'Coding Plan or Token Plan · stored in the encrypted nassaj vault',
              })}
            </span>
            <Button
              id={`company-api-key-${company.id}`}
              data-company-credential-action={company.id}
              type="button"
              size="sm"
              onClick={onQwenConnect}
              disabled={!onQwenConnect}
            >
              {t('vendors.connectQwen', { defaultValue: 'Connect Qwen' })}
            </Button>
          </div>
        ) : (
          <CompanyCredentialCard key={company.id} company={company} />
        ))}
      </div>
    </SettingsSection>

      {/*
        ‏**قسمٌ تحت قائمة الشركات لا صفٌّ فيها** (‏ADR-103 / T-1247).

        القاعدة التي تحكم هذه الصفحة — «كلُّ حقل مفتاحٍ يُصيَّر من هنا» — تضع مفتاح
        التفريغ هنا بلا نقاش: هو مفتاحُ مورّدٍ **خارج** يُدفع ثمنُه لشركةٍ أخرى،
        فتبويبٌ ثالثٌ له كان أوّلَ فرعٍ في قاعدةٍ وُجدت بلا فروع.

        وهو **ليس صفّاً في القائمة أعلاه** لأن تلك مولَّدة من كتالوج المورّدين، وهذا
        ليس مورّداً فيه بل ميزةٌ لها علمُ تشغيلٍ ونقطةُ نهايةٍ وسقفُ حجم — ثلاثةُ
        أشياء لا يعرف صفُّ الشركة كيف يعرضها، ونطاقان (تثبيت/عضو) لا يعرفهما.
      */}
      <VoiceTranscriptionSection />
    </div>
  );
}
