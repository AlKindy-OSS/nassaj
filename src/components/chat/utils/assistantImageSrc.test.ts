/**
 * T-1737 — وحدات اختبار classifier المصدر ومحلّل جسم السياج.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/utils/assistantImageSrc.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  classifyImageSrc,
  parseFenceBody,
  buildAssistantImageUrl,
  resolveAssistantImageError,
} from './assistantImageSrc';

// ─── classifyImageSrc ──────────────────────────────────────────────────────

describe('classifyImageSrc', () => {
  it('يُصنِّف data: URL', () => {
    expect(classifyImageSrc('data:image/png;base64,ABC==')).toBe('data');
  });

  it('يُصنِّف /api/chat-images/ كـapi', () => {
    expect(classifyImageSrc('/api/chat-images/abc.png')).toBe('api');
  });

  it('يُصنِّف /api/assistant-images كـapi', () => {
    expect(classifyImageSrc('/api/assistant-images?path=/x&session=y')).toBe('api');
  });

  it('يُصنِّف مسار مطلق محلي', () => {
    expect(classifyImageSrc('/home/operator/screenshots/shot.png')).toBe('path');
  });

  it('يُصنِّف /var/tmp/... كمسار', () => {
    expect(classifyImageSrc('/var/tmp/image.png')).toBe('path');
  });

  it('يُصنِّف http:// كـremote', () => {
    expect(classifyImageSrc('http://example.com/img.png')).toBe('remote');
  });

  it('يُصنِّف https:// كـremote', () => {
    expect(classifyImageSrc('https://example.com/img.png')).toBe('remote');
  });

  it('يُصنِّف سلسلة فارغة كـempty', () => {
    expect(classifyImageSrc('')).toBe('empty');
  });

  it('يُصنِّف مسافات فقط كـempty', () => {
    expect(classifyImageSrc('   ')).toBe('empty');
  });

  it('يُصنِّف مسار نسبي كـempty', () => {
    expect(classifyImageSrc('screenshots/shot.png')).toBe('empty');
  });

  it('يتجاهل المسافات البادئة', () => {
    expect(classifyImageSrc('  /home/operator/img.png')).toBe('path');
    expect(classifyImageSrc('  data:image/png;base64,')).toBe('data');
    expect(classifyImageSrc('  https://x.com')).toBe('remote');
  });
});

// ─── parseFenceBody ────────────────────────────────────────────────────────

describe('parseFenceBody', () => {
  it('يستخرج المصدر من السطر الأول', () => {
    const { source } = parseFenceBody('/home/operator/img.png\n');
    expect(source).toBe('/home/operator/img.png');
  });

  it('يستخرج caption من الأسطر الباقية', () => {
    const { source, caption } = parseFenceBody('/home/operator/img.png\nشرح الصورة');
    expect(source).toBe('/home/operator/img.png');
    expect(caption).toBe('شرح الصورة');
  });

  it('يدعم caption من عدة أسطر', () => {
    const body = '/srv/x.png\nسطر أول\nسطر ثانٍ';
    const { caption } = parseFenceBody(body);
    expect(caption).toBe('سطر أول\nسطر ثانٍ');
  });

  it('يتجاهل الأسطر الفارغة قبل المصدر', () => {
    const { source } = parseFenceBody('\n\n/home/operator/img.png');
    expect(source).toBe('/home/operator/img.png');
  });

  it('يدعم CRLF', () => {
    const { source, caption } = parseFenceBody('/srv/x.png\r\ncaption هنا\r\n');
    expect(source).toBe('/srv/x.png');
    expect(caption).toBe('caption هنا');
  });

  it('يدعم CR فقط', () => {
    const { source } = parseFenceBody('/srv/x.png\rcaption');
    expect(source).toBe('/srv/x.png');
  });

  it('يُعيد source="" عند جسم فارغ', () => {
    const { source, caption } = parseFenceBody('');
    expect(source).toBe('');
    expect(caption).toBe('');
  });

  it('يُعيد source="" عند أسطر فارغة فقط', () => {
    const { source } = parseFenceBody('\n\n\n');
    expect(source).toBe('');
  });

  it('يُعيد caption="" عند غياب أسطر caption', () => {
    const { caption } = parseFenceBody('/srv/x.png');
    expect(caption).toBe('');
  });

  it('يُقلِّم الأسطر', () => {
    const { source, caption } = parseFenceBody('  /srv/x.png  \n  شرح  ');
    expect(source).toBe('/srv/x.png');
    expect(caption).toBe('شرح');
  });

  it('يتجاهل الأسطر الفارغة في caption', () => {
    const { caption } = parseFenceBody('/srv/x.png\n\nسطر\n\n');
    expect(caption).toBe('سطر');
  });
});

// ─── buildAssistantImageUrl ────────────────────────────────────────────────

describe('buildAssistantImageUrl', () => {
  it('يبني URL صحيح مع path و session', () => {
    const url = buildAssistantImageUrl('/home/operator/img.png', 'session-123');
    expect(url).toBe(
      '/api/assistant-images?path=%2Fhome%2Foperator%2Fimg.png&session=session-123',
    );
  });

  it('يُشفَّر الأحرف الخاصة في المسار', () => {
    const url = buildAssistantImageUrl('/home/operator/my file.png', 'sid');
    expect(url).toContain('%20');
  });
});

// ─── resolveAssistantImageError ────────────────────────────────────────────

describe('resolveAssistantImageError', () => {
  it.each([
    [400, 'طلب صورة غير صالح'],
    [403, 'المسار غير مسموح'],
    [404, 'الملف غير موجود'],
    [413, 'الصورة أكبر من الحدّ'],
    [415, 'نوع غير مدعوم'],
    [500, 'تعذّر تحميل الصورة'],
    [502, 'تعذّر تحميل الصورة'],
    ['network' as const, 'تعذّر تحميل الصورة'],
  ])('الرمز %s → "%s"', (status, expected) => {
    expect(resolveAssistantImageError(status as number | 'network')).toBe(expected);
  });
});
