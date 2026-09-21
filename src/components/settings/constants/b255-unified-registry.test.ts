/**
 * B-255: Unified tab registry — SETTINGS_MAIN_TABS is the single source of
 * truth for all settings navigation. Verifies that previously missing tabs
 * (profile, command-board) are now present and that role gates are correct.
 */
import { describe, it, expect } from 'vitest';

import { SETTINGS_MAIN_TABS, COMMAND_BOARD_TAB_ROLES } from './constants';

describe('B-255 unified tab registry', () => {
  it('includes profile tab', () => {
    expect(SETTINGS_MAIN_TABS.some((t) => t.id === 'profile')).toBe(true);
  });

  it('includes command-board tab', () => {
    expect(SETTINGS_MAIN_TABS.some((t) => t.id === 'command-board')).toBe(true);
  });

  it('command-board is restricted to owner role', () => {
    const entry = SETTINGS_MAIN_TABS.find((t) => t.id === 'command-board');
    expect(entry?.roles).toEqual(COMMAND_BOARD_TAB_ROLES);
    expect(entry?.roles).toContain('owner');
  });

  it('users tab is restricted to owner and admin', () => {
    const entry = SETTINGS_MAIN_TABS.find((t) => t.id === 'users');
    expect(entry?.roles).toContain('owner');
    expect(entry?.roles).toContain('admin');
  });

  it('every entry has a non-empty labelKey', () => {
    SETTINGS_MAIN_TABS.forEach((tab) => {
      expect(tab.labelKey).toBeTruthy();
    });
  });

  it('every entry has an icon component (function or forwardRef object)', () => {
    SETTINGS_MAIN_TABS.forEach((tab) => {
      // Lucide icons are React.forwardRef objects, so accept both function and object.
      expect(tab.icon).toBeTruthy();
    });
  });

  it('contains exactly the expected 13 tab ids', () => {
    const ids = SETTINGS_MAIN_TABS.map((t) => t.id);
    expect(ids).toEqual([
      'profile',
      'agents',
      // «المرجعيّات» — تبويبٌ رئيسيٌّ لا فئةٌ داخل `agents`: محورُ ذاك هو الجسم،
      // والذاكرةُ وبطاقاتُ الوكلاء مستقلّتان عن المحرّك تماماً. موضعُه هنا بنصّ
      // التصميم: «الأجسام» ثم «ما تقرؤه الأجسام» ثم «مَن يزوّدها».
      'references',
      // T-1205 أسقط `vendors` حين انتقلت بطاقةُ كل شركة إلى تبويب «الحساب»
      // للوكيل الذي يخصّها، وT-1206 أعاده **بدورٍ آخر**: فهرسٌ لكل المفاتيح،
      // ومنزلُ الشركة التي لا بلاطةَ لوكيلها فلا حساب تُعرض فيه (DeepSeek).
      // وهو شرط سلامة لا تفضيل — الحارس في `agents-settings/vendors.test.ts`
      // («لا مفتاح لا يُدخَل») هو ما يمنع حذفه مرّةً أخرى.
      'vendors',
      'appearance',
      'git',
      'api',
      // ADR-098 — منصات خارجية بمفتاح عام على نسّاج، بلا صلاحية لكل شخص.
      'connectors',
      'notifications',
      'users',
      'command-board',
      'about',
    ]);
  });

  it('profile has no role restriction (reachable by all)', () => {
    const entry = SETTINGS_MAIN_TABS.find((t) => t.id === 'profile');
    expect(entry?.roles).toBeUndefined();
  });

  /**
   * ‏T-1219 — «الوصول البرمجي» لا «مفاتيح واجهة نسّاج». الاسمان كانا يقولان
   * «مفاتيح API» في شريطٍ واحد وهما متعاكسان: هذا توكناتٌ **تدخل** إلى نسّاج،
   * وتبويب المورّدين مفاتيحُ **تخرج** منه.
   */
  it('api tab label names programmatic access, not keys', () => {
    const entry = SETTINGS_MAIN_TABS.find((t) => t.id === 'api');
    expect(entry?.label).toBe('Programmatic access');
    // والوعد الذي لا ينقلب: لا يحمل هذا البند كلمة «مفاتيح» فيُخلط بتبويب
    // الاعتمادات مرّةً أخرى.
    expect(entry?.label.toLowerCase()).not.toContain('key');
  });
});
