/**
 * ImageAttachment.test.tsx — اختبار زر القص وإخفائه للأنواع غير القابلة للقص.
 *
 * RUNNER: node:test + tsx (test:src) — لا vitest.
 *
 * يستخدم renderToStaticMarkup بلا DOM/jsdom. الأجزاء الديناميكية
 * (useEffect، URL.createObjectURL) لا تعمل في SSR — نختبر هنا
 * المنطق الدقيق الذي اشترطه qa-critic:
 *   - زر القص يظهر للأنواع القابلة للقص (JPEG، PNG، WebP).
 *   - زر القص مخفيّ لـ image/svg+xml و image/gif (شرط qa-critic 3).
 *   - onReplace غير مُمرَّرة تُخفي الزر أيضاً.
 *
 * المكوّن يستخدم useTranslation — نُقدّم mock يعيد المفتاح مباشرة.
 * يستخدم lazy(ImageCropModal) — لا يُنشَئ في SSR.
 * يستخدم Crop من lucide-react — نُقدّم mock بسيط.
 */
import { describe, it, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// ---------------------------------------------------------------------------
// mock الوحدات المعتمِدة على البيئة
// ---------------------------------------------------------------------------

// react-i18next: useTranslation → t يُعيد المفتاح
mock.module('react-i18next', {
  namedExports: {
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        if (opts && typeof opts.name === 'string') return `${key}:${opts.name}`;
        return key;
      },
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  },
});

// lucide-react: Crop → عنصر span بسيط
mock.module('lucide-react', {
  namedExports: {
    Crop: (props: Record<string, unknown>) =>
      React.createElement('span', { 'data-lucide': 'crop', ...props }),
  },
});

// ImageLightbox: stub بسيط
mock.module('./ImageLightbox', {
  defaultExport: () => null,
});

// ImageCropModal: lazy stub — لا يُنشَئ في SSR
mock.module('./ImageCropModal', {
  defaultExport: () => null,
});

// ---------------------------------------------------------------------------
// مساعدات الاختبار
// ---------------------------------------------------------------------------

/**
 * يُنشئ File مزيّف بنوع MIME محدّد.
 * لا ننشئ objectURL حقيقياً — نُحاكيه كسلسلة نصية.
 */
function makeFile(name: string, type: string): File {
  return new File([new Uint8Array(1)], name, { type });
}

/**
 * يُعرض المكوّن ويتحقق إن كان يحتوي على زر القص.
 * يستخدم aria-label الذي يبدأ بـ imageCrop.cropButton كمعرّف.
 */
function hasCropButton(html: string): boolean {
  return html.includes('imageCrop.cropButton');
}

// ---------------------------------------------------------------------------
// الاختبارات
// ---------------------------------------------------------------------------

describe('ImageAttachment — ظهور زر القص وإخفاؤه', async () => {
  // نستورد المكوّن بعد تسجيل الـ mocks
  const { default: ImageAttachment } = await import('./ImageAttachment');

  const noop = () => {};

  it('يُظهر زر القص لملفات JPEG مع onReplace مُمرَّرة', () => {
    const file = makeFile('photo.jpg', 'image/jpeg');
    const html = renderToStaticMarkup(
      React.createElement(ImageAttachment, {
        file,
        onRemove: noop,
        onReplace: noop,
      }),
    );
    assert.ok(hasCropButton(html), 'زر القص يجب أن يظهر لـ JPEG');
  });

  it('يُظهر زر القص لملفات PNG مع onReplace مُمرَّرة', () => {
    const file = makeFile('image.png', 'image/png');
    const html = renderToStaticMarkup(
      React.createElement(ImageAttachment, {
        file,
        onRemove: noop,
        onReplace: noop,
      }),
    );
    assert.ok(hasCropButton(html), 'زر القص يجب أن يظهر لـ PNG');
  });

  it('يُظهر زر القص لملفات WebP مع onReplace مُمرَّرة', () => {
    const file = makeFile('photo.webp', 'image/webp');
    const html = renderToStaticMarkup(
      React.createElement(ImageAttachment, {
        file,
        onRemove: noop,
        onReplace: noop,
      }),
    );
    assert.ok(hasCropButton(html), 'زر القص يجب أن يظهر لـ WebP');
  });

  it('يُخفي زر القص لملفات image/svg+xml — شرط qa-critic 3', () => {
    const file = makeFile('icon.svg', 'image/svg+xml');
    const html = renderToStaticMarkup(
      React.createElement(ImageAttachment, {
        file,
        onRemove: noop,
        onReplace: noop,
      }),
    );
    assert.ok(!hasCropButton(html), 'زر القص يجب ألا يظهر لـ SVG');
  });

  it('يُخفي زر القص لملفات image/gif — شرط qa-critic 3', () => {
    const file = makeFile('animation.gif', 'image/gif');
    const html = renderToStaticMarkup(
      React.createElement(ImageAttachment, {
        file,
        onRemove: noop,
        onReplace: noop,
      }),
    );
    assert.ok(!hasCropButton(html), 'زر القص يجب ألا يظهر لـ GIF');
  });

  it('يُخفي زر القص عند عدم تمرير onReplace (بلا prop)', () => {
    const file = makeFile('photo.jpg', 'image/jpeg');
    const html = renderToStaticMarkup(
      React.createElement(ImageAttachment, {
        file,
        onRemove: noop,
        // onReplace غائبة
      }),
    );
    assert.ok(!hasCropButton(html), 'زر القص يجب ألا يظهر بلا onReplace');
  });

  it('زر الإزالة يظهر دائماً بصرف النظر عن النوع', () => {
    for (const type of ['image/jpeg', 'image/svg+xml', 'image/gif']) {
      const file = makeFile('test', type);
      const html = renderToStaticMarkup(
        React.createElement(ImageAttachment, { file, onRemove: noop }),
      );
      assert.ok(html.includes('images.remove'), `زر الإزالة يجب أن يظهر لـ ${type}`);
    }
  });
});
