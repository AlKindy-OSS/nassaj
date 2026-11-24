import { describe, expect, it } from 'vitest';

import { clamp, computeFit, toggleZoomTarget, zoomAround, zoomLimits } from './lightboxZoomMath';

describe('clamp', () => {
  it('يحصر القيمة بين الحدين', () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(-1, 1, 10)).toBe(1);
    expect(clamp(11, 1, 10)).toBe(10);
  });
});

describe('computeFit', () => {
  const phone = { width: 390, height: 844 };

  it('يملأ العرض لصورة طويلة جداً فتُقرأ بالتمرير العمودي', () => {
    const fit = computeFit({ width: 1170, height: 20000 }, phone, 16);
    expect(fit.mode).toBe('width');
    expect(fit.width).toBe(390);
  });

  it('يحتوي الصورة العادية داخل الإطار مع الهامش', () => {
    const fit = computeFit({ width: 2000, height: 1000 }, phone, 16);
    expect(fit.mode).toBe('contain');
    expect(fit.width).toBe(358);
  });

  it('لا يكبّر صورة أصغر من الإطار', () => {
    expect(computeFit({ width: 100, height: 80 }, phone, 16).width).toBe(100);
    expect(computeFit({ width: 200, height: 20000 }, phone, 16).width).toBe(200);
  });

  it('يتعامل مع أبعاد صفرية دون قسمة على صفر', () => {
    expect(computeFit({ width: 0, height: 0 }, phone, 16).width).toBe(0);
  });
});

describe('zoomLimits', () => {
  it('الأدنى هو الملاءمة والأعلى أكبر من 4×الملاءمة و2×الحجم الأصلي', () => {
    expect(zoomLimits(390, 1170)).toEqual({ min: 390, max: 2340 });
    expect(zoomLimits(358, 200)).toEqual({ min: 358, max: 1432 });
  });
});

describe('zoomAround', () => {
  const viewport = { width: 400, height: 800 };

  it('يُبقي نقطة التركيز ثابتة عند التكبير', () => {
    // Image 400 wide (fills), aspect 2 → 800 tall; focal at the centre.
    const next = zoomAround({
      prevWidth: 400, nextWidth: 800, aspect: 2, viewport,
      scroll: { left: 0, top: 0 }, focal: { x: 200, y: 400 },
    });
    expect(next).toEqual({ left: 200, top: 400 });
  });

  it('يحسب إزاحة الصورة المتوسّطة حين تكون أصغر من الإطار', () => {
    // 200×200 image centred in 400×800 → offset (100, 300); focal on its centre.
    const next = zoomAround({
      prevWidth: 200, nextWidth: 800, aspect: 1, viewport,
      scroll: { left: 0, top: 0 }, focal: { x: 200, y: 400 },
    });
    expect(next).toEqual({ left: 200, top: 0 });
  });

  it('يحصر التمرير ضمن المدى المتاح', () => {
    const next = zoomAround({
      prevWidth: 800, nextWidth: 400, aspect: 2, viewport,
      scroll: { left: 400, top: 800 }, focal: { x: 400, y: 800 },
    });
    expect(next).toEqual({ left: 0, top: 0 });
  });
});

describe('toggleZoomTarget', () => {
  it('من الملاءمة إلى 1:1 ومن غيرها إلى الملاءمة', () => {
    expect(toggleZoomTarget({ current: 390, fit: 390, natural: 1170, max: 2340 })).toBe(1170);
    expect(toggleZoomTarget({ current: 1170, fit: 390, natural: 1170, max: 2340 })).toBe(390);
    expect(toggleZoomTarget({ current: 700, fit: 390, natural: 1170, max: 2340 })).toBe(390);
  });

  it('يضاعف الملاءمة حين تكون الصورة أصغر من الإطار', () => {
    expect(toggleZoomTarget({ current: 100, fit: 100, natural: 100, max: 400 })).toBe(200);
  });
});
