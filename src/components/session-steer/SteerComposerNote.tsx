import { useTranslation } from 'react-i18next';

export interface SteerComposerNoteProps {
  starterName: string;
  /**
   * ADR-190 (تحديث) — بادئ الدور نفسه يستطيع الآن توجيه دوره الجاري: الخادم
   * يقبل ذلك مباشرةً بلا موافقة وبلا موجّه أدوات (sender === starter). لكن
   * المسار الوحيد إلى الحقن هو أمر `/steer <text>` صراحةً (اعتراضٌ نحويّ في
   * useChatComposerState) — رسالةٌ عادية من البادئ تسلك المسار الطبيعي ولا
   * تُوجَّه، وزرّ Steer نفسه لا يُعرَض له أصلاً (RunStatusViewerActions يُظهره
   * لغير البادئ فقط، فللبادئ STOP). النصّ إذن يسمّي الأمر صراحةً بدل الإيحاء
   * بأنّ أيّ رسالة تُحقَن.
   */
  isStarter?: boolean;
}

/**
 * T-1903 (ADR-190) — ملاحظة أسفل صندوق الكتابة تظهر فقط حين يستطيع المستخدم
 * الحالي توجيه هذا الدور. لغير البادئ: توضّح أن التوجيه يُحتسب على حصة بادئ
 * الدور، لا حصته. للبادئ نفسه: توضّح أن `/steer` هو المسار الوحيد لإيصال
 * رسالته إلى دوره الجاري (لا الرسالة العادية).
 */
export default function SteerComposerNote({ starterName, isStarter = false }: SteerComposerNoteProps) {
  const { t } = useTranslation('chat');
  return (
    <p className="mx-3 mt-1 text-xs text-muted-foreground sm:mx-0" data-testid="steer-composer-note">
      {isStarter
        ? t('steer.composerNoteSelf', {
            defaultValue: 'Type /steer followed by your message to deliver it into your running turn.',
          })
        : t('steer.composerNote', {
            starter: starterName,
            defaultValue: 'Counted against {{starter}}’s quota',
          })}
    </p>
  );
}
