import { useTranslation } from 'react-i18next';

export interface SteerComposerNoteProps {
  starterName: string;
}

/**
 * T-1903 (ADR-190) — ملاحظة أسفل صندوق الكتابة لغير بادئ الدور حين يستطيع
 * توجيهه: توضّح أن التوجيه يُحتسب على حصة بادئ الدور لا حصته (معلومة إسناد
 * حصة يجب أن يراها قبل أن يكتب). T-1956: تلميح `/steer` للبادئ نفسه لم يعد
 * هنا — صار تلميحاً على مؤشّر في شريط الدور الجاري (RunStatusSteerHint) لأنّ
 * ظهوره الدائم كان مزعجاً.
 */
export default function SteerComposerNote({ starterName }: SteerComposerNoteProps) {
  const { t } = useTranslation('chat');
  return (
    <p className="mx-3 mt-1 text-xs text-muted-foreground sm:mx-0" data-testid="steer-composer-note">
      {t('steer.composerNote', {
        starter: starterName,
        defaultValue: 'Counted against {{starter}}’s quota',
      })}
    </p>
  );
}
