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

/** مفتاح وصف سقف صلاحيات Codex الموافق لوضع الإذن الحالي. */
export function getCodexPostureKey(permissionMode: string): string {
  return POSTURE_KEY_BY_MODE[permissionMode] ?? POSTURE_KEY_BY_MODE.default;
}
