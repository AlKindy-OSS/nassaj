/**
 * cropImage.test.ts — اختبارات دالة computeCropGeometry (هندسة نقية)
 *                    + mock موثَّق لترميز Canvas في getCroppedFile.
 *
 * RUNNER: node:test (test:src) — لا vitest.
 *
 * ملاحظة: jsdom لا يُنفّذ Canvas فعلياً، لذا نختبر:
 *   (أ) computeCropGeometry كدالة نقية بلا أي mock.
 *   (ب) getCroppedFile مع mock صريح لـ HTMLImageElement + canvas + toBlob،
 *       نُثبت فيه أن outputCtx.drawImage تُستدعى بالوسائط الصحيحة.
 *
 * بنية الخوارزمية المختبَرة (خوارزمية القماشتين):
 *   - drawImage أولى: bboxCtx.drawImage(img, 0, 0) — لا تُتتبَّع في هذه الاختبارات.
 *   - drawImage ثانية: outputCtx.drawImage(bboxCanvas, sx, sy, sw, sh, 0, 0, dw, dh)
 *     وهي التي تحمل صواب الإحداثيات المُختبَر.
 *
 * المرجع: شرط qa-critic 1 (اختبار الهندسة النقية) + شرط 2 (mock موثَّق).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { computeCropGeometry, getCroppedFile, MAX_OUTPUT_SIDE, type AreaPixels } from './cropImage';

// ---------------------------------------------------------------------------
// اختبارات computeCropGeometry (هندسة نقية — لا DOM)
// ---------------------------------------------------------------------------

describe('computeCropGeometry', () => {
  it('لا دوران: الأبعاد تمر مباشرة بدون تحجيم', () => {
    const area: AreaPixels = { x: 10, y: 20, width: 100, height: 50 };
    const geo = computeCropGeometry(500, 300, area, 0);
    assert.equal(geo.sx, 10,  'sx');
    assert.equal(geo.sy, 20,  'sy');
    assert.equal(geo.sw, 100, 'sw');
    assert.equal(geo.sh, 50,  'sh');
    assert.equal(geo.dw, 100, 'dw');
    assert.equal(geo.dh, 50,  'dh');
    assert.equal(geo.rotation, 0, 'rotation');
    // bbox عند 0° = أبعاد الصورة الأصلية
    assert.equal(geo.bboxW, 500, 'bboxW');
    assert.equal(geo.bboxH, 300, 'bboxH');
  });

  it('90° bbox يتبادل ضلعيه: نW=200 نH=100 → bboxW=100 bboxH=200', () => {
    // روتيت 90°: bbox = {H, W} = {100, 200}
    const area: AreaPixels = { x: 0, y: 0, width: 100, height: 200 };
    const geo = computeCropGeometry(200, 100, area, 90);
    assert.equal(geo.bboxW, 100, 'bboxW = ارتفاع الأصل');
    assert.equal(geo.bboxH, 200, 'bboxH = عرض الأصل');
    assert.equal(geo.dw, 100, 'dw = عرض منطقة القص من bbox');
    assert.equal(geo.dh, 200, 'dh = ارتفاع منطقة القص من bbox');
    assert.equal(geo.rotation, 90, 'rotation');
  });

  it('180° bbox يبقى بنفس حجم الأصل', () => {
    const area: AreaPixels = { x: 0, y: 0, width: 300, height: 150 };
    const geo = computeCropGeometry(300, 150, area, 180);
    assert.equal(geo.bboxW, 300, 'bboxW = عرض الأصل');
    assert.equal(geo.bboxH, 150, 'bboxH = ارتفاع الأصل');
    assert.equal(geo.dw, 300, 'dw');
    assert.equal(geo.dh, 150, 'dh');
    assert.equal(geo.rotation, 180, 'rotation');
  });

  it('270° bbox يتبادل ضلعيه كـ 90°', () => {
    const area: AreaPixels = { x: 0, y: 0, width: 100, height: 200 };
    const geo = computeCropGeometry(200, 100, area, 270);
    assert.equal(geo.bboxW, 100, 'bboxW');
    assert.equal(geo.bboxH, 200, 'bboxH');
    assert.equal(geo.dw, 100, 'dw');
    assert.equal(geo.dh, 200, 'dh');
    assert.equal(geo.rotation, 270, 'rotation');
  });

  it('360° يُعادل 0°', () => {
    const area: AreaPixels = { x: 0, y: 0, width: 100, height: 60 };
    const geo = computeCropGeometry(200, 120, area, 360);
    assert.equal(geo.rotation, 0, 'rotation مُطبَّع');
    assert.equal(geo.dw, 100, 'dw');
    assert.equal(geo.dh, 60, 'dh');
  });

  it('تطبيق الحد الأقصى: أطول ضلع يُعاد تحجيمه مع الحفاظ على النسبة', () => {
    const area: AreaPixels = { x: 0, y: 0, width: 4000, height: 2000 };
    const geo = computeCropGeometry(4000, 4000, area, 0, 2000);
    assert.equal(geo.dw, 2000, 'dw بعد cap');
    assert.equal(geo.dh, 1000, 'dh مع الحفاظ على النسبة');
  });

  it('cap مع دوران 90°: تُطبَّق على أبعاد منطقة القص من bbox', () => {
    // صورة 4000×1000 عند 90°: bbox = {1000, 4000}
    // قص كامل للـ bbox: area = {0, 0, 1000, 4000}
    // sw=1000، sh=4000، longest=4000، scale=0.5 → dw=500، dh=2000
    const area: AreaPixels = { x: 0, y: 0, width: 1000, height: 4000 };
    const geo = computeCropGeometry(4000, 1000, area, 90, 2000);
    assert.equal(geo.dw, 500,  'dw بعد cap');
    assert.equal(geo.dh, 2000, 'dh بعد cap');
  });

  it('حماية الصفر: عرض/ارتفاع صغير جداً لا يُعيد صفراً', () => {
    const area: AreaPixels = { x: 0, y: 0, width: 0, height: 0 };
    const geo = computeCropGeometry(100, 100, area, 0);
    assert.equal(geo.sw, 1, 'sw >= 1');
    assert.equal(geo.sh, 1, 'sh >= 1');
    assert.equal(geo.dw, 1, 'dw >= 1');
    assert.equal(geo.dh, 1, 'dh >= 1');
  });

  it('صور صغيرة تحت الحد لا تُكبَّر', () => {
    const area: AreaPixels = { x: 0, y: 0, width: 200, height: 100 };
    const geo = computeCropGeometry(400, 300, area, 0, MAX_OUTPUT_SIDE);
    assert.equal(geo.dw, 200, 'لا تكبير');
    assert.equal(geo.dh, 100, 'لا تكبير');
  });

  it('الدوران السالب يُعامَل بشكل صحيح (modulo 360)', () => {
    // -90 → 270
    const area: AreaPixels = { x: 0, y: 0, width: 100, height: 200 };
    const geo = computeCropGeometry(200, 100, area, -90);
    assert.equal(geo.rotation, 270, 'rotation مُطبَّع إلى 270');
    assert.equal(geo.bboxW, 100, 'bboxW');
    assert.equal(geo.bboxH, 200, 'bboxH');
  });

  it('qa-critic: صورة 200×100 دوران 90° قص كامل bbox {0,0,100,200} → ناتج 100×200', () => {
    // bbox = rotateSize(200,100,90°) = {100, 200}
    // منطقة القص الكاملة للـ bbox: {0,0,100,200}
    // الناتج يجب أن يكون 100×200 لا 200×100 كما في الخوارزمية القديمة الخاطئة
    const area: AreaPixels = { x: 0, y: 0, width: 100, height: 200 };
    const geo = computeCropGeometry(200, 100, area, 90);
    assert.equal(geo.bboxW, 100, 'bboxW = ارتفاع الصورة الأصلية');
    assert.equal(geo.bboxH, 200, 'bboxH = عرض الصورة الأصلية');
    assert.equal(geo.dw, 100, 'dw من bbox لا من الأصل');
    assert.equal(geo.dh, 200, 'dh من bbox لا من الأصل');
  });
});

// ---------------------------------------------------------------------------
// اختبار getCroppedFile مع mock موثَّق للـ Canvas
// ---------------------------------------------------------------------------

/**
 * نهيئ jsdom لتوفير global.document وglobal.Image.
 *
 * Mock Image: naturalWidth=800، naturalHeight=600 كقيم افتراضية واقعية.
 * سجّل وسائط drawImage الثانية (outputCtx) للتحقق منها.
 *
 * في خوارزمية القماشتين:
 *   1. bboxCtx.drawImage(img, 0, 0) — الصورة كاملة مدوَّرة (أولى، لا نتتبعها)
 *   2. outputCtx.drawImage(bboxCanvas, sx, sy, sw, sh, 0, 0, dw, dh) — القص (نتتبعها)
 * drawImageArgs تُسجّل آخر استدعاء لـ drawImage أي القص.
 */

let dom: JSDOM;
let drawImageArgs: unknown[] = [];
let toBlobMimeArg = '';
let toBlobQualityArg: number | undefined;
let capturedImageSrc = '';

/** ينشئ canvas context وهمياً — يُسجّل drawImage لاختبار وسائط القص */
function makeMockContext() {
  return {
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    drawImage: (...args: unknown[]) => {
      // نسجّل كل استدعاء — في الخوارزمية الجديدة الثاني (outputCtx) يُلغي الأول
      drawImageArgs = args;
    },
  };
}

/** canvas element وهمي — يُسجّل mime وجودة toBlob */
function makeMockCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: (_type: string) => makeMockContext(),
    toBlob: (cb: (b: Blob | null) => void, mime: string, quality?: number) => {
      toBlobMimeArg = mime;
      toBlobQualityArg = quality;
      cb(new dom.window.Blob([], { type: mime }));
    },
  };
}

describe('getCroppedFile (mock موثَّق للـ Canvas)', () => {
  let origCreateElement: typeof document.createElement;

  before(() => {
    dom = new JSDOM('<!DOCTYPE html>', { url: 'http://localhost' });

    const w = dom.window as unknown as Record<string, unknown>;
    void w; // suppress unused warning
    global.document = dom.window.document;
    global.File = dom.window.File as unknown as typeof File;
    global.Blob = dom.window.Blob as unknown as typeof Blob;

    // Mock HTMLImageElement: onload يُطلَق فور تعيين src، naturalWidth/Height واقعيان
    const MockImageClass = class {
      _src = '';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 800;
      naturalHeight = 600;
      decode(): Promise<void> { return Promise.resolve(); }
      get src() { return this._src; }
      set src(value: string) {
        this._src = value;
        capturedImageSrc = value;
        Promise.resolve().then(() => this.onload?.());
      }
    };
    global.Image = MockImageClass as unknown as typeof Image;

    origCreateElement = dom.window.document.createElement.bind(dom.window.document);
    dom.window.document.createElement = (tag: string) => {
      if (tag === 'canvas') return makeMockCanvas() as unknown as HTMLCanvasElement;
      return origCreateElement(tag);
    };
    global.document.createElement = dom.window.document.createElement;
  });

  after(() => {
    dom.window.document.createElement = origCreateElement;
    global.document.createElement = origCreateElement;
  });

  it('outputCtx.drawImage تُستدعى بإحداثيات القص الصحيحة من areaPixels', async () => {
    drawImageArgs = [];
    const area: AreaPixels = { x: 5, y: 10, width: 100, height: 80 };
    const fakeFile = new File([new Uint8Array(10)], 'photo.jpg', { type: 'image/jpeg' });
    const objectUrl = 'blob:fake-url-for-test';

    await getCroppedFile(fakeFile, objectUrl, area, 0);

    // outputCtx.drawImage(bboxCanvas, sx, sy, sw, sh, 0, 0, dw, dh)
    assert.equal(drawImageArgs[1], 5,   'sx يُمرَّر صحيحاً');
    assert.equal(drawImageArgs[2], 10,  'sy يُمرَّر صحيحاً');
    assert.equal(drawImageArgs[3], 100, 'sw يُمرَّر صحيحاً');
    assert.equal(drawImageArgs[4], 80,  'sh يُمرَّر صحيحاً');
    assert.equal(capturedImageSrc, objectUrl, 'objectURL يُمرَّر إلى Image.src');
  });

  it('mime يُحدَّد image/jpeg لملفات JPEG مع quality=0.9', async () => {
    const area: AreaPixels = { x: 0, y: 0, width: 50, height: 50 };
    const fakeFile = new File([new Uint8Array(10)], 'test.jpg', { type: 'image/jpeg' });
    await getCroppedFile(fakeFile, 'blob:fake', area, 0);
    assert.equal(toBlobMimeArg, 'image/jpeg');
    assert.equal(toBlobQualityArg, 0.9);
  });

  it('mime يُحدَّد image/png لملفات PNG بدون quality', async () => {
    const area: AreaPixels = { x: 0, y: 0, width: 50, height: 50 };
    const fakeFile = new File([new Uint8Array(10)], 'test.png', { type: 'image/png' });
    await getCroppedFile(fakeFile, 'blob:fake', area, 0);
    assert.equal(toBlobMimeArg, 'image/png');
    assert.equal(toBlobQualityArg, undefined);
  });

  it('mime يُحدَّد image/webp لملفات WebP مع quality=0.9', async () => {
    const area: AreaPixels = { x: 0, y: 0, width: 50, height: 50 };
    const fakeFile = new File([new Uint8Array(10)], 'test.webp', { type: 'image/webp' });
    await getCroppedFile(fakeFile, 'blob:fake', area, 0);
    assert.equal(toBlobMimeArg, 'image/webp');
    assert.equal(toBlobQualityArg, 0.9);
  });

  it('اسم الملف: يُزيل -cropped المتكرّر ويُضيفه مرة واحدة', async () => {
    const area: AreaPixels = { x: 0, y: 0, width: 50, height: 50 };
    const fakeFile = new File([new Uint8Array(10)], 'photo-cropped-cropped.jpg', { type: 'image/jpeg' });
    const result = await getCroppedFile(fakeFile, 'blob:fake', area, 0);
    assert.equal(result.name, 'photo-cropped.jpg');
  });

  it('اسم الملف: يُعيد <base>-cropped.jpg لاسم عادي', async () => {
    const area: AreaPixels = { x: 0, y: 0, width: 50, height: 50 };
    const fakeFile = new File([new Uint8Array(10)], 'vacation.jpg', { type: 'image/jpeg' });
    const result = await getCroppedFile(fakeFile, 'blob:fake', area, 0);
    assert.equal(result.name, 'vacation-cropped.jpg');
  });

  it('عند الدوران 90° أبعاد الناتج تطابق منطقة القص من bbox (بلا تبادل محاور)', async () => {
    // area={0,0,200,100} من bbox — dw=200، dh=100 مباشرةً بلا تبادل
    const area: AreaPixels = { x: 0, y: 0, width: 200, height: 100 };
    const fakeFile = new File([new Uint8Array(10)], 'img.jpg', { type: 'image/jpeg' });
    await getCroppedFile(fakeFile, 'blob:fake', area, 90);
    // outputCtx.drawImage(bboxCanvas, sx, sy, sw, sh, 0, 0, dw, dh)
    const dw = drawImageArgs[7] as number;
    const dh = drawImageArgs[8] as number;
    assert.equal(dw, 200, `dw=${dw} يجب أن يكون 200`);
    assert.equal(dh, 100, `dh=${dh} يجب أن يكون 100`);
  });
});
