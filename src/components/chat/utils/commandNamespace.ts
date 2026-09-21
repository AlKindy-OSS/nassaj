/**
 * getDisplayNamespace — فصل تصنيف العرض عن وسم التوجيه
 *
 * تُحدِّد المجموعة المرئية في CommandMenu لكل أمر دون المساس بـ namespace
 * الذي تعتمده حراس التوجيه (isPassthroughBuiltInCommand / isBtwSlashEntry …).
 *
 * القاعدة الوحيدة المضافة:
 *   «nassaj» → «builtin» عرضاً فقط
 *   (أوامر نسّاج العميلية كـ/btw هي مكافئات أصيلة للأوامر المدمجة في Claude Code)
 */
export const getDisplayNamespace = (command: { namespace?: string; type?: string }): string => {
  const ns = command.namespace || command.type || 'other';
  if (ns === 'nassaj') return 'builtin';
  return ns;
};
