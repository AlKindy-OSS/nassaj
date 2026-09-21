/**
 * cropImage.ts — قطع الصور قبل إرسالها في المحادثة.
 *
 * خوارزمية القماشتين (two-canvas):
 *   القماشة 1 (bbox): ترسم الصورة كاملة مدوَّرة على مستطيل محيط حجمه rotateSize(nW,nH,rot).
 *   القماشة 2 (ناتج): تقص croppedAreaPixels من القماشة 1 وتُحجّمها إلى حد 2048px.
 *
 * سبب الخوارزمية:
 *   react-easy-crop يعيد croppedAreaPixels بإحداثيات bbox الدوار لا الصورة الأصلية.
 *   استخدام canvas واحد مع drawImage(img, sx,sy,...) المباشر يعطي إحداثيات خاطئة عند الدوران.
 *
 * ملاحظة EXIF:
 *   نُحمّل الصورة عبر HTMLImageElement + decode() فيطبّق المتصفح دوران EXIF
 *   بنفس الطريقة التي يُظهرها Cropper. لا تستخدم createImageBitmap.
 *
 * @module cropImage
 */

export interface AreaPixels {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropGeometry {
  /** عرض canvas الـbbox (الصورة الكاملة بعد الدوران) */
  bboxW: number;
  /** ارتفاع canvas الـbbox */
  bboxH: number;
  /** إحداثي X المصدر على bbox canvas (من croppedAreaPixels) */
  sx: number;
  /** إحداثي Y المصدر على bbox canvas */
  sy: number;
  /** عرض منطقة المصدر على bbox canvas */
  sw: number;
  /** ارتفاع منطقة المصدر على bbox canvas */
  sh: number;
  /** عرض Canvas الناتج (بعد تطبيق الحد الأقصى) */
  dw: number;
  /** ارتفاع Canvas الناتج */
  dh: number;
  /** زاوية الدوران المُطبَّعة (0–359 درجة) */
  rotation: number;
}

/** الحد الأقصى لأطول ضلع في الناتج (بكسل). السيرفر يُصغّر فوق 1568، فـ 2048 آمن. */
export const MAX_OUTPUT_SIDE = 2048;

/**
 * rotateSize — يُعيد أبعاد المستطيل المحيط بالصورة بعد الدوران.
 *
 * المعادلة: bboxW = |W·cos θ| + |H·sin θ|، bboxH = |W·sin θ| + |H·cos θ|
 */
function rotateSize(
  naturalWidth: number,
  naturalHeight: number,
  rotationDeg: number,
): { bboxW: number; bboxH: number } {
  const rad = (rotationDeg * Math.PI) / 180;
  const sinAbs = Math.abs(Math.sin(rad));
  const cosAbs = Math.abs(Math.cos(rad));
  return {
    bboxW: Math.round(naturalWidth * cosAbs + naturalHeight * sinAbs),
    bboxH: Math.round(naturalWidth * sinAbs + naturalHeight * cosAbs),
  };
}

/**
 * computeCropGeometry — دالة نقية لحساب هندسة خوارزمية القماشتين.
 *
 * قابلة للاختبار المعزول بلا Canvas ولا DOM.
 *
 * @param naturalWidth  العرض الطبيعي للصورة الأصلية (بكسل)
 * @param naturalHeight الارتفاع الطبيعي للصورة الأصلية
 * @param areaPixels    منطقة القص من react-easy-crop (بإحداثيات bbox الدوار)
 * @param rotation      الدوران بالدرجات — أيّ عدد، يُطبَّق modulo 360
 * @param cap           أقصى طول للضلع الأطول في الناتج (افتراضي MAX_OUTPUT_SIDE)
 * @returns             أبعاد bbox + مستطيل المصدر + أبعاد الناتج
 */
export function computeCropGeometry(
  naturalWidth: number,
  naturalHeight: number,
  areaPixels: AreaPixels,
  rotation: number,
  cap = MAX_OUTPUT_SIDE,
): CropGeometry {
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const { bboxW, bboxH } = rotateSize(naturalWidth, naturalHeight, normalizedRotation);

  const { x, y, width, height } = areaPixels;

  // ضمان عدم صفرية أبعاد المصدر
  const sw = Math.max(Math.round(width), 1);
  const sh = Math.max(Math.round(height), 1);

  // الناتج يُطابق منطقة القص من bbox مباشرة — bbox هو من يُعالج الدوران
  const longest = Math.max(sw, sh);
  const scale = longest > cap ? cap / longest : 1;
  const dw = Math.max(Math.round(sw * scale), 1);
  const dh = Math.max(Math.round(sh * scale), 1);

  return {
    bboxW,
    bboxH,
    sx: Math.round(x),
    sy: Math.round(y),
    sw,
    sh,
    dw,
    dh,
    rotation: normalizedRotation,
  };
}

/**
 * getCroppedFile — يُنفّذ القص الفعلي بخوارزمية القماشتين ويُعيد File جديدة.
 *
 * @param file        الصورة الأصلية
 * @param objectUrl   objectURL للصورة (يُنشئه المُستدعي ويُلغيه عند الإغلاق)
 * @param areaPixels  منطقة القص من react-easy-crop (بإحداثيات bbox)
 * @param rotation    الدوران بالدرجات
 * @returns           File مقصوصة باسم `<base>-cropped.<ext>`
 */
export async function getCroppedFile(
  file: File,
  objectUrl: string,
  areaPixels: AreaPixels,
  rotation: number,
): Promise<File> {
  // تحميل الصورة — HTMLImageElement يطبّق EXIF تلقائياً كما يفعل Cropper
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('تعذّر تحميل الصورة للقص'));
    img.src = objectUrl;
  });
  if (typeof img.decode === 'function') {
    await img.decode();
  }

  const nW = img.naturalWidth || 0;
  const nH = img.naturalHeight || 0;

  const geo = computeCropGeometry(nW, nH, areaPixels, rotation);
  const { bboxW, bboxH, sx, sy, sw, sh, dw, dh } = geo;
  const rotRad = (geo.rotation * Math.PI) / 180;

  // القماشة 1: الصورة الكاملة مدوَّرة على bbox
  const bboxCanvas = document.createElement('canvas');
  bboxCanvas.width = bboxW;
  bboxCanvas.height = bboxH;
  const bboxCtx = bboxCanvas.getContext('2d');
  if (!bboxCtx) throw new Error('تعذّر الحصول على سياق Canvas للـbbox');

  bboxCtx.translate(bboxW / 2, bboxH / 2);
  bboxCtx.rotate(rotRad);
  bboxCtx.translate(-nW / 2, -nH / 2);
  bboxCtx.drawImage(img, 0, 0);

  // القماشة 2: القص والتحجيم إلى الناتج النهائي
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = dw;
  outputCanvas.height = dh;
  const outputCtx = outputCanvas.getContext('2d');
  if (!outputCtx) throw new Error('تعذّر الحصول على سياق Canvas للناتج');

  outputCtx.drawImage(bboxCanvas, sx, sy, sw, sh, 0, 0, dw, dh);

  // تحديد نوع الناتج: png بلا جودة، webp وjpeg بجودة 0.9
  let mime: string;
  if (file.type === 'image/png') {
    mime = 'image/png';
  } else if (file.type === 'image/webp') {
    mime = 'image/webp';
  } else {
    mime = 'image/jpeg';
  }
  const quality = mime === 'image/png' ? undefined : 0.9;

  const blob = await new Promise<Blob>((resolve, reject) => {
    outputCanvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob أعاد null'))),
      mime,
      quality,
    );
  });

  // بناء الاسم: إزالة لاحقة -cropped المتكرّرة قبل إضافتها
  const baseName = file.name.replace(/(-cropped)+(\.[^.]+)?$/, '$2') || file.name;
  const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
  const dotIdx = baseName.lastIndexOf('.');
  const stem = dotIdx >= 0 ? baseName.slice(0, dotIdx) : baseName;
  const croppedName = `${stem}-cropped${ext}`;

  return new File([blob], croppedName, { type: mime });
}
