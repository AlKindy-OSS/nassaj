import { useTranslation } from 'react-i18next';
import SessionProviderLogo from '../../../../../../llm-logo-provider/SessionProviderLogo';
import type { AgentProvider } from '../../../../../types/types';

type ComingSoonContentProps = {
  agent: AgentProvider;
};

/**
 * لوح «قريباً» — يُصيَّر للمزوّدات الظاهرة في الشريط ولكنها بلا ربط فعلي بعد
 * (T-1760). يحلّ محلّ تبويبات الفئة كلها (الحساب/الأذونات/المحرّكات/…) بدلاً من
 * عرض لوح فارغ.
 *
 * لا نقطة حالة على البلاطة، ولا CTA تسجيل دخول هنا.
 *
 * يستخدم `SessionProviderLogo` (لا `VendorLogo`) لتسليم الشعار الرسمي كلما
 * توفّر، بدلاً من شارة الحرف الأوّلي (T-1761).
 *
 * RTL: padding-inline منطقي، محاذاة مع `text-align: start`.
 */
export default function ComingSoonContent({ agent }: ComingSoonContentProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
      <span aria-hidden="true">
        <SessionProviderLogo provider={agent} className="h-10 w-10" />
      </span>
      <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
        {t(`agents.${agent}.comingSoon`, {
          defaultValue: t('agents.comingSoon.default', {
            defaultValue: 'Coming soon — will be connected later.',
          }),
        })}
      </p>
    </div>
  );
}
