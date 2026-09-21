import { AlertTriangle, CheckCircle2 } from 'lucide-react';

import SettingsCard from '../../SettingsCard';

export type FeedbackKind = 'success' | 'error';
export type Feedback = { kind: FeedbackKind; message: string } | null;

/**
 * Inline success/error banner shared by the profile-settings sections
 * (avatar/username/password forms and the passkeys list).
 *
 * **نبرتان بصياغة واحدة الآن.** كانت النبرتان تُرسمان بمصدرين مختلفين: الخطأ
 * بـ`Alert` المشترك (صندوق بحدّ وخلفية) والنجاح بنصٍّ ملوّن عارٍ بلا سطح — لأن
 * الرمز `--success` لم يكن موجوداً في `src/index.css` يوم كُتب. صار موجوداً
 * (‏B-399)، فسقط سبب الاستثناء: النتيجتان تقعان في الموضع نفسه بعد الفعل نفسه،
 * فتظهران بالوعاء نفسه بنبرتين مختلفتين.
 *
 * والوعاء `SettingsCard` بنبرته لا `Alert`: هذا سطح إعدادات، وصندوق النبرة هو
 * ما يرسمه الأصل (‏upstream) للمناطق التي ليست كبقيّتها. والأيقونة تبقى مع كلٍّ
 * منهما فلا يقع التمييز على اللون وحده (‏WCAG 1.4.1).
 */
export default function FeedbackBanner({ feedback }: { feedback: Feedback }) {
  if (!feedback) {
    return null;
  }

  const isSuccess = feedback.kind === 'success';

  return (
    <SettingsCard tone={isSuccess ? 'success' : 'danger'}>
      <div
        role={isSuccess ? 'status' : 'alert'}
        className={
          isSuccess
            ? 'flex items-start gap-2 text-[13px] leading-relaxed text-success'
            : 'flex items-start gap-2 text-[13px] leading-relaxed text-danger'
        }
      >
        {isSuccess ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
        )}
        <p>{feedback.message}</p>
      </div>
    </SettingsCard>
  );
}
