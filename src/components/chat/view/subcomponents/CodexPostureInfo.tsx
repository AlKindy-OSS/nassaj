import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PromptInputButton } from '../../../../shared/view/ui';

type CodexPostureInfoProps = {
  /** الوضع الحالي لأزرار دوّار الأذونات — يحدّد نص السقف المعروض. */
  permissionMode: string;
};

// T-894/T-905: يعرض السقف الفعلي الثابت (sandbox/شبكة) لكل وضع أذونات
// codex بجانب زرّ الوضع نفسه، تصحيحاً لتضليل النصوص القديمة التي كانت تصف
// bypassPermissions بأنه «وصول كامل للقرص والشبكة» بينما السقف الحيّ
// (ADR-058/T-884) = workspace-write + شبكة OFF ما لم يُفعِّل المشغّل العلم
// التشغيلي CODEX_ALLOW_FULL_ACCESS لكامل النشر (مطفأ افتراضياً على الأسطول).
// عرضٌ ثابت i18n+عميل بلا أي قراءة خادمية لحالة الأعلام الفعلية للنشر
// الحالي (خارج نطاق T-905 — راجع مذكرة المتابعات).
const POSTURE_KEY_BY_MODE: Record<string, string> = {
  default: 'codex.posture.default',
  acceptEdits: 'codex.posture.acceptEdits',
  bypassPermissions: 'codex.posture.bypassPermissions',
};

export default function CodexPostureInfo({ permissionMode }: CodexPostureInfoProps) {
  const { t } = useTranslation('chat');
  const postureKey = POSTURE_KEY_BY_MODE[permissionMode] ?? POSTURE_KEY_BY_MODE.default;

  return (
    <PromptInputButton
      tooltip={{ content: t(postureKey) }}
      aria-label={`${t('codex.posture.title')}: ${t(postureKey)}`}
      tabIndex={0}
    >
      <Info className="h-4 w-4" />
    </PromptInputButton>
  );
}
