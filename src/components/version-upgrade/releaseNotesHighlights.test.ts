/**
 * اختبارات دالة extractReleaseHighlights
 *
 * تغطّي: البيانات المنظَّمة بأقسام، وغير المنظَّمة، وفارغة/null،
 * وحدّ maxItems، والترتيب بحسب الفئة، وتنظيف Markdown.
 */
import { describe, it, expect } from 'vitest';
import {
  extractReleaseHighlights,
  stripMarkdownInline,
  stripConventionalPrefix,
} from './releaseNotesHighlights';

// ─── stripMarkdownInline ──────────────────────────────────────────────────────

describe('stripMarkdownInline', () => {
  it('يُزيل التنسيق السميك', () => {
    expect(stripMarkdownInline('**نص سميك** عادي')).toBe('نص سميك عادي');
  });

  it('يُزيل التنسيق المائل', () => {
    expect(stripMarkdownInline('*مائل* عادي')).toBe('مائل عادي');
  });

  it('يُزيل الكود المُضمَّن ويُبقي النص', () => {
    expect(stripMarkdownInline('استخدم `npm ci` للتثبيت')).toBe('استخدم npm ci للتثبيت');
  });

  it('يُحوّل الرابط [نص](url) إلى النص فقط', () => {
    expect(stripMarkdownInline('[تفاصيل](https://example.com/release)')).toBe('تفاصيل');
  });

  it('يُزيل الروابط المجرّدة', () => {
    const result = stripMarkdownInline('راجع https://github.com/owner/repo/issues/1 للتفاصيل');
    expect(result).not.toContain('https://');
  });

  it('يُزيل هاش commit', () => {
    expect(stripMarkdownInline('إصلاح abc1234 في المرسل')).not.toContain('abc1234');
  });

  it('يُزيل إشارات PR', () => {
    const result = stripMarkdownInline('إصلاح خطأ في العرض #123');
    expect(result).not.toContain('#123');
  });

  it('يُزيل الصور', () => {
    expect(stripMarkdownInline('![لقطة](screen.png) نص')).toBe('نص');
  });

  it('يُعيد نصاً فارغاً للإدخال الفارغ', () => {
    expect(stripMarkdownInline('')).toBe('');
  });

  it('يُزيل بادئة feat: من بداية النص', () => {
    expect(stripMarkdownInline('feat: إضافة دعم RTL')).toBe('إضافة دعم RTL');
  });

  it('يُزيل بادئة fix: من بداية النص', () => {
    expect(stripMarkdownInline('fix: إصلاح خروج عشوائي')).toBe('إصلاح خروج عشوائي');
  });

  it('يُزيل بادئة improvement: مع نطاق', () => {
    expect(stripMarkdownInline('improvement(ui): تحسين واجهة الإعدادات')).toBe('تحسين واجهة الإعدادات');
  });

  it('يُزيل بادئة chore: الإنجليزية', () => {
    expect(stripMarkdownInline('chore: update dependencies')).toBe('update dependencies');
  });

  it('لا يُعدّل نصاً يبدأ بكلمة عربية', () => {
    expect(stripMarkdownInline('إضافة ميزة التحديث التلقائي')).toBe('إضافة ميزة التحديث التلقائي');
  });
});

// ─── stripConventionalPrefix ──────────────────────────────────────────────────

describe('stripConventionalPrefix', () => {
  it('يُزيل feat:', () => {
    expect(stripConventionalPrefix('feat: new feature')).toBe('new feature');
  });

  it('يُزيل fix مع نطاق وعلامة !', () => {
    expect(stripConventionalPrefix('fix(auth)!: critical security patch')).toBe('critical security patch');
  });

  it('لا يُعدّل النص الذي لا يبدأ ببادئة CC', () => {
    expect(stripConventionalPrefix('normal text here')).toBe('normal text here');
  });

  it('يتعامل مع الإدخال الفارغ', () => {
    expect(stripConventionalPrefix('')).toBe('');
  });
});

// ─── extractReleaseHighlights ─────────────────────────────────────────────────

describe('extractReleaseHighlights', () => {
  // ── إدخالات فارغة ────────────────────────────────────────────────────────

  it('يُعيد [] للنص الفارغ', () => {
    expect(extractReleaseHighlights('')).toEqual([]);
  });

  it('يُعيد [] للمسافات فقط', () => {
    expect(extractReleaseHighlights('   \n\n  ')).toEqual([]);
  });

  // ── بنية مقسّمة بأقسام ───────────────────────────────────────────────────

  const structuredBody = `
## What's Changed

### Added

- ميزة تسجيل الدخول بـSSO
- دعم RTL في لوحة الإعدادات
- نافذة موافقة التحديث الجديدة

### Changed

- تحسين أداء تحميل المحادثات
- تبسيط واجهة اختيار النماذج

### Fixed

- إصلاح خروج عشوائي عند تجديد JWT
- حلّ مشكلة تجميد المتصفح عند فتح الإعدادات
`;

  it('يستخرج البنود من الأقسام المُعنوَنة', () => {
    const highlights = extractReleaseHighlights(structuredBody);
    expect(highlights.length).toBeGreaterThan(0);
  });

  it('يُصنّف Added كـfeature', () => {
    const highlights = extractReleaseHighlights(structuredBody);
    const features = highlights.filter((h) => h.category === 'feature');
    expect(features.length).toBeGreaterThanOrEqual(1);
    expect(features[0].text).toContain('SSO');
  });

  it('يُصنّف Changed كـimprovement', () => {
    const highlights = extractReleaseHighlights(structuredBody);
    const improvements = highlights.filter((h) => h.category === 'improvement');
    expect(improvements.length).toBeGreaterThanOrEqual(1);
  });

  it('يُصنّف Fixed كـfix', () => {
    const highlights = extractReleaseHighlights(structuredBody);
    const fixes = highlights.filter((h) => h.category === 'fix');
    expect(fixes.length).toBeGreaterThanOrEqual(1);
  });

  it('يُقدّم المزايا على التحسينات على الإصلاحات', () => {
    const highlights = extractReleaseHighlights(structuredBody);
    const categories = highlights.map((h) => h.category);
    const firstFix = categories.indexOf('fix');
    const lastFeature = categories.lastIndexOf('feature');
    const lastImprovement = categories.lastIndexOf('improvement');
    if (firstFix !== -1 && lastFeature !== -1) {
      expect(lastFeature).toBeLessThan(firstFix);
    }
    if (firstFix !== -1 && lastImprovement !== -1) {
      expect(lastImprovement).toBeLessThan(firstFix);
    }
  });

  it('لا يتجاوز maxItems', () => {
    const highlights = extractReleaseHighlights(structuredBody, 3);
    expect(highlights.length).toBeLessThanOrEqual(3);
  });

  it('يحترم الحدّ الافتراضي 6', () => {
    const highlights = extractReleaseHighlights(structuredBody);
    expect(highlights.length).toBeLessThanOrEqual(6);
  });

  // ── نص غير مقسّم (قائمة نقطية عادية) ───────────────────────────────────

  const unstructuredBody = `
- ميزة جديدة في المحرّر
- تحسين أداء البحث
- إصلاح خطأ في التحميل
`;

  it('يستخرج بنوداً من نص غير مقسّم', () => {
    const highlights = extractReleaseHighlights(unstructuredBody);
    expect(highlights.length).toBeGreaterThan(0);
  });

  it('يُصنّف بنود النص غير المقسّم كـother', () => {
    const highlights = extractReleaseHighlights(unstructuredBody);
    for (const h of highlights) {
      expect(h.category).toBe('other');
    }
  });

  // ── تنظيف Markdown في البنود ─────────────────────────────────────────────

  it('يُزيل التنسيق Markdown من نصوص البنود', () => {
    const body = `
### Added

- **نافذة جديدة** لعرض ملاحظات الإصدار بـ[رابط](https://example.com)
`;
    const highlights = extractReleaseHighlights(body);
    expect(highlights.length).toBe(1);
    expect(highlights[0].text).toBe('نافذة جديدة لعرض ملاحظات الإصدار بـرابط');
    expect(highlights[0].text).not.toContain('**');
    expect(highlights[0].text).not.toContain('https://');
  });

  // ── بنود قصيرة جداً ──────────────────────────────────────────────────────

  it('يتجاهل البنود القصيرة جداً (< 8 محارف)', () => {
    const body = `
### Fixed

- ok
- إصلاح مشكلة في تحميل الصفحة الرئيسية
`;
    const highlights = extractReleaseHighlights(body);
    expect(highlights.every((h) => h.text.length >= 8)).toBe(true);
  });

  // ── صيغة الأرقام 1. 2. ──────────────────────────────────────────────────

  it('يعالج القوائم المرقّمة', () => {
    const body = `
### Added

1. ميزة التحديث التلقائي عند خلوّ الجلسات
2. دعم الإشعارات عبر WebPush
`;
    const highlights = extractReleaseHighlights(body);
    expect(highlights.length).toBe(2);
    expect(highlights[0].category).toBe('feature');
  });

  // ── بادئات Conventional Commits في بنود القائمة ──────────────────────────

  it('يُزيل بادئات Conventional Commits من بنود قائمة الإصدار', () => {
    const body = `
### Added

- feat: إضافة دعم RTL في الإعدادات
- feat(ui): نافذة موافقة التحديث الجديدة

### Fixed

- fix: إصلاح خروج عشوائي عند تجديد JWT
- fix(auth)!: إصلاح حرج في التحقّق
`;
    const highlights = extractReleaseHighlights(body);
    for (const h of highlights) {
      expect(h.text).not.toMatch(/^feat[:(]/i);
      expect(h.text).not.toMatch(/^fix[:(]/i);
    }
    expect(highlights.find((h) => h.text.includes('RTL'))).toBeTruthy();
  });

  // ── CHANGELOG format من هذا المستودع ────────────────────────────────────

  it('يعالج صيغة CHANGELOG المحلية (## [1.47.0.16])', () => {
    const body = `## [1.47.0.16] — Session idle warning (2026-09-12)

### Added

- بعد 60 دقيقة بلا رسالة يظهر شريط تحذير بحجم السياق المستخدَم.
- بطاقة DeepSeek coming-soon بالشعار الرسمي.

### Fixed

- STOP لا يتجمّد بعد الآن عند غياب interrupt().
- إعدادات تبقى ظاهرة عند تغيير نقطة الكسر 768px (B-466).
`;
    const highlights = extractReleaseHighlights(body);
    const features = highlights.filter((h) => h.category === 'feature');
    const fixes = highlights.filter((h) => h.category === 'fix');
    expect(features.length).toBeGreaterThanOrEqual(1);
    expect(fixes.length).toBeGreaterThanOrEqual(1);
    // التحقق من تنظيف رموز Markdown فقط
    for (const h of highlights) {
      expect(h.text).not.toContain('**');
      expect(h.text).not.toContain('`');
    }
  });
});
