// @vitest-environment node
/**
 * اختبارات منطق مودال الإعدادات المستقلّة عن DOM.
 *
 * قصد هذه الوحدة: التحقّق من أن resolveEscapeTarget وhasActiveNestedDialog
 * تتصرّفان بشكل صحيح في كل الحالات الحدّية دون الحاجة إلى jsdom أو
 * تصيير React — لأن الجزء الوحيد الذي يحتاج DOM هو الاستدعاء الفعلي
 * لـquerySelector في Settings.tsx، وهو محصور في سطر واحد.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveEscapeTarget,
  hasActiveNestedDialog,
} from './settingsDialogHelpers';

describe('resolveEscapeTarget', () => {
  it('يُعيد "none" إذا كان مودال متداخل مفتوحاً — لا تُغلق الإعدادات', () => {
    expect(resolveEscapeTarget({ hasNestedDialog: true, showLoginModal: false })).toBe('none');
  });

  it('المودال المتداخل له الأولوية على ProviderLoginModal', () => {
    // كلاهما مفتوح في نفس الوقت — المتداخل أعمق ويجب أن يُغلق أولاً
    expect(resolveEscapeTarget({ hasNestedDialog: true, showLoginModal: true })).toBe('none');
  });

  it('يُعيد "login-modal" إذا كان ProviderLoginModal مفتوحاً بلا مودال متداخل', () => {
    expect(resolveEscapeTarget({ hasNestedDialog: false, showLoginModal: true })).toBe('login-modal');
  });

  it('يُعيد "settings" إذا لم يكن هناك أي مودال متداخل أو login modal', () => {
    expect(resolveEscapeTarget({ hasNestedDialog: false, showLoginModal: false })).toBe('settings');
  });
});

describe('hasActiveNestedDialog', () => {
  it('يُعيد false لـnull', () => {
    expect(hasActiveNestedDialog(null)).toBe(false);
  });
});
