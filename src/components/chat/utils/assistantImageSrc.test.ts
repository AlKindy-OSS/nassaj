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
  resolveAssistantImage,
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

  it.each([
    'HTTPS://evil.example/?d=secret',
    'HttP://evil.example/x.png',
    '//evil.example/x.png',
    '/\\evil.example/x.png',
    '\\\\evil.example/x.png',
    '/\t/evil.example/x.png',
    'ftp://evil.example/x.png',
    'javascript:alert(1)',
    'blob:https://evil.example/uuid',
  ])('B-1667: %s is remote', (src) => {
    expect(classifyImageSrc(src)).toBe('remote');
  });

  it.each([
    '/api/projects/1/files?path=/etc/passwd',
    '/api/user/delete-account',
    '/api/chat-images/../auth/user',
    '/api/chat-images/%2e%2e/auth/user',
    '/api/chat-images/..%2Fauth',
    '/api/assistant-images-evil',
  ])('B-1667: /api/ outside the image allowlist (%s) is rejected', (src) => {
    expect(classifyImageSrc(src)).toBe('empty');
  });

  it('B-1667: the allowlisted image APIs still classify as api', () => {
    expect(classifyImageSrc('/api/assistant-images?path=%2Fhome%2Fuser%2Fa.png&session=s')).toBe('api');
    expect(classifyImageSrc('/api/chat-images/s1/a.png')).toBe('api');
  });
});

describe('resolveAssistantImage (B-1667)', () => {
  it('remote → the disabled-links error, never a source', () => {
    expect(resolveAssistantImage('  https://evil/?d=1', 's1')).toEqual({ ok: false, message: 'الروابط البعيدة معطّلة' });
  });

  it('absolute path → the authenticated assistant-images URL with the session', () => {
    expect(resolveAssistantImage('/home/user/a.png', 's1')).toEqual({
      ok: true, src: '/api/assistant-images?path=%2Fhome%2Fuser%2Fa.png&session=s1',
    });
  });

  it('absolute path without a session → invalid request error', () => {
    expect(resolveAssistantImage('/home/user/a.png', null)).toEqual({ ok: false, message: 'طلب صورة غير صالح' });
  });

  it('data: and allowlisted api pass through normalized', () => {
    expect(resolveAssistantImage(' data:image/png;base64,AA== ', 's1')).toEqual({ ok: true, src: 'data:image/png;base64,AA==' });
    expect(resolveAssistantImage('/api/chat-images/a.png', null)).toEqual({ ok: true, src: '/api/chat-images/a.png' });
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
