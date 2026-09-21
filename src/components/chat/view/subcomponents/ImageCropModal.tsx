/**
 * ImageCropModal.tsx — مودال القص الفعلي للصور قبل الإرسال.
 *
 * يُحمَّل بشكل كسول (React.lazy) حتى لا تدخل react-easy-crop في الحزمة الرئيسية.
 * يُعرض الصورة عبر <img src=objectURL> مما يضمن تطابق EXIF مع المشفّر.
 *
 * @see cropImage.ts للشرح الكامل لخوارزمية القماشتين وسبب استخدام HTMLImageElement
 */
import 'react-easy-crop/react-easy-crop.css';

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Cropper, { type Area } from 'react-easy-crop';
import { RotateCw } from 'lucide-react';

import { Dialog, DialogContent } from '../../../../shared/view/ui/Dialog';
import { getCroppedFile } from '../../utils/cropImage';

interface AspectOption {
  label: string;
  value: number | undefined;
}

interface ImageCropModalProps {
  /** الصورة الأصلية */
  file: File;
  /** objectURL للصورة — يُنشئه المُستدعي ويُلغيه بعد الإغلاق */
  objectUrl: string;
  onConfirm: (croppedFile: File) => void;
  onClose: () => void;
}

const ASPECT_OPTIONS: AspectOption[] = [
  { label: 'imageCrop.aspectFree', value: undefined },
  { label: 'imageCrop.aspect1to1', value: 1 },
  { label: 'imageCrop.aspect4to3', value: 4 / 3 },
  { label: 'imageCrop.aspect16to9', value: 16 / 9 },
];

const ImageCropModal = ({ file, objectUrl, onConfirm, onClose }: ImageCropModalProps) => {
  const { t } = useTranslation('chat');

  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [aspectIndex, setAspectIndex] = useState(0);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [cropError, setCropError] = useState<string | null>(null);

  const currentAspect = ASPECT_OPTIONS[aspectIndex]?.value;

  const handleCropComplete = useCallback((_: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  const handleRotate = useCallback(() => {
    setRotation((prev) => (prev + 90) % 360);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!croppedAreaPixels) return;
    setIsBusy(true);
    setCropError(null);
    try {
      const cropped = await getCroppedFile(file, objectUrl, croppedAreaPixels, rotation);
      onConfirm(cropped);
    } catch (err) {
      console.error('[ImageCropModal] getCroppedFile failed:', err);
      setCropError(t('imageCrop.error'));
    } finally {
      setIsBusy(false);
    }
  }, [croppedAreaPixels, file, objectUrl, rotation, onConfirm, t]);

  const zoomPercent = Math.round(((zoom - 1) / 2) * 100);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !isBusy) onClose(); }}>
      <DialogContent
        aria-labelledby="crop-title"
        className="flex w-full max-w-xl flex-col gap-0 p-0"
        onEscapeKeyDown={() => { if (!isBusy) onClose(); }}
        onPointerDownOutside={() => { if (!isBusy) onClose(); }}
      >
        {/* منطقة حية لإعلانات حالة المعالجة — مخفية بصرياً */}
        <p role="status" aria-live="polite" className="sr-only">
          {isBusy ? t('imageCrop.processing') : ''}
        </p>

        {/* رأس المودال */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 id="crop-title" className="text-sm font-medium text-foreground">
            {t('imageCrop.title')}
          </h2>
        </div>

        {/* منطقة القص */}
        <div className="relative h-64 w-full overflow-hidden bg-black sm:h-80">
          {/* تلميح للقراء الشاشة عن طريقة التحكم بلوحة المفاتيح */}
          <p id="crop-hint" className="sr-only">
            {t('imageCrop.cropHint')}
          </p>
          <Cropper
            image={objectUrl}
            crop={crop}
            zoom={zoom}
            rotation={rotation}
            aspect={currentAspect}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={handleCropComplete}
            keyboardStep={10}
            cropperProps={{
              role: 'group',
              'aria-label': t('imageCrop.cropArea'),
              'aria-describedby': 'crop-hint',
            }}
          />
        </div>

        {/* أدوات التحكم */}
        <div className="flex flex-col gap-3 px-4 py-4">
          {/* أزرار نسب الأبعاد */}
          <div role="group" aria-label={t('imageCrop.aspectLabel')} className="flex flex-wrap gap-2">
            {ASPECT_OPTIONS.map((option, index) => (
              <button
                key={option.label}
                type="button"
                onClick={() => setAspectIndex(index)}
                aria-pressed={aspectIndex === index}
                disabled={isBusy}
                className={[
                  'rounded px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50',
                  aspectIndex === index
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80',
                ].join(' ')}
              >
                {t(option.label)}
              </button>
            ))}
          </div>

          {/* شريط التكبير */}
          <div className="flex items-center gap-3">
            <label htmlFor="crop-zoom" className="min-w-0 shrink-0 text-xs text-muted-foreground">
              {t('imageCrop.zoom')}
            </label>
            <input
              id="crop-zoom"
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              disabled={isBusy}
              aria-label={t('imageCrop.zoom')}
              aria-valuetext={`${zoomPercent}%`}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary disabled:opacity-50"
            />
          </div>

          {/* زر الدوران */}
          <button
            type="button"
            onClick={handleRotate}
            disabled={isBusy}
            aria-label={t('imageCrop.rotate')}
            className="flex w-fit items-center gap-1.5 rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('imageCrop.rotate')}
          </button>

          {/* حالة الخطأ */}
          {cropError && (
            <p role="alert" className="text-xs text-destructive">
              {cropError}
            </p>
          )}
        </div>

        {/* تذييل: أزرار التأكيد والإلغاء */}
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            className="rounded px-4 py-1.5 text-sm text-muted-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            {t('imageCrop.cancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isBusy || !croppedAreaPixels}
            aria-busy={isBusy}
            className="rounded bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            {isBusy ? t('imageCrop.processing') : t('imageCrop.confirm')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ImageCropModal;
