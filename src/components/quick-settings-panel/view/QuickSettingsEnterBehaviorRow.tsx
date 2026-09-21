import { CornerDownLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import SegmentedControl, { type SegmentedOption } from '../../settings/view/SegmentedControl';
import type { EnterBehavior } from '../../../lib/enter-behavior';
import { STACKED_SETTING_ROW_CLASS } from '../constants';

type QuickSettingsEnterBehaviorRowProps = {
  value: EnterBehavior;
  onChange: (value: EnterBehavior) => void;
  /** نتيجة `'auto'` على هذا الجهاز الآن — تُصرَّح نصّاً لا تُترك للتخمين. */
  autoSends: boolean;
};

/**
 * ‏T-1319 — منتقي سلوك مفتاح Enter.
 *
 * **الخيارات مسمّاة بالنتيجة لا بالآلية.** التحكّم السابق كان مربّع تأشير اسمه
 * «الإرسال بـCtrl+Enter» وتحته شرحٌ يذكر IME — وكلاهما يفشل عند المستخدم
 * المقصود: مستخدمُ الجوال لا `Ctrl` عنده أصلاً، والمستخدمُ العربي لا يعرف ما
 * IME ولا يعنيه. والسؤال الحقيقي واحد: «حين أضغط Enter، ماذا يحدث؟».
 *
 * **ولماذا تُصرَّح نتيجة `auto`؟** لأن خياراً اسمه «حسب الجهاز» لا يقول شيئاً
 * عن الجهاز الحاضر، فيبقى المستخدم بعد اختياره غيرَ عالمٍ بما اختار — وهو نفس
 * عطل «تحكّمٌ يصف حالةً غير التي على الشاشة».
 */
export default function QuickSettingsEnterBehaviorRow({
  value,
  onChange,
  autoSends,
}: QuickSettingsEnterBehaviorRowProps) {
  const { t, i18n } = useTranslation('settings');
  // نصوص بـ`defaultValue`: ملفّات `src/i18n/locales` تحت تعديل جلسة أخرى الآن،
  // والسابقة قائمة في `MainContentHeader` و`QuickSettingsPanelView`.
  const isArabic = i18n.language?.startsWith('ar');

  const title = t('quickSettings.enterBehavior.title', {
    defaultValue: isArabic ? 'مفتاح Enter' : 'Enter key',
  });

  const options: readonly SegmentedOption<EnterBehavior>[] = [
    {
      value: 'auto',
      label: t('quickSettings.enterBehavior.auto', {
        defaultValue: isArabic ? 'حسب الجهاز' : 'Auto',
      }),
    },
    {
      value: 'send',
      label: t('quickSettings.enterBehavior.send', {
        defaultValue: isArabic ? 'إرسال' : 'Send',
      }),
    },
    {
      value: 'newline',
      label: t('quickSettings.enterBehavior.newline', {
        defaultValue: isArabic ? 'سطر جديد' : 'New line',
      }),
    },
  ];

  const autoOutcome = autoSends
    ? t('quickSettings.enterBehavior.autoSends', {
      defaultValue: isArabic ? 'على هذا الجهاز: يُرسل الرسالة' : 'On this device: sends the message',
    })
    : t('quickSettings.enterBehavior.autoNewline', {
      defaultValue: isArabic ? 'على هذا الجهاز: سطر جديد' : 'On this device: new line',
    });

  return (
    <div className={STACKED_SETTING_ROW_CLASS}>
      <span className="flex items-center gap-2 text-sm text-foreground">
        <CornerDownLeft className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        {title}
      </span>

      {/* اللوحة بعرض `w-64`: الأزرار تتقاسم العرض بالتساوي بحشوٍ أضيق كي تسع
          اللصائق العربية بلا لفّ ولا فيضان. */}
      <SegmentedControl
        options={options}
        value={value}
        onChange={onChange}
        label={title}
        className="w-full [&>button]:flex-1 [&>button]:whitespace-nowrap [&>button]:px-2"
      />

      {value === 'auto' && (
        <p className="text-xs text-muted-foreground">{autoOutcome}</p>
      )}

      <p className="text-xs text-muted-foreground">
        {t('quickSettings.enterBehavior.hint', {
          defaultValue: isArabic
            ? 'يبقى Ctrl+Enter يُرسل دائماً، وShift+Enter سطراً جديداً.'
            : 'Ctrl+Enter always sends; Shift+Enter always starts a new line.',
        })}
      </p>
    </div>
  );
}
