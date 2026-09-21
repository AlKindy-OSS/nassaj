import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crop } from 'lucide-react';
import ImageLightbox from './ImageLightbox';

/**
 * ImageCropModal محمَّل بشكل كسول — react-easy-crop تبقى خارج الحزمة الرئيسية.
 * تُعرض Suspense بلا fallback مرئي لأن الزرّ يفتح المودال فقط عند الضغط عليه.
 */
const ImageCropModal = lazy(() => import('./ImageCropModal'));

interface ImageAttachmentProps {
  file: File;
  onRemove: () => void;
  /** استبدال الملف الأصلي بالملف المقصوص */
  onReplace?: (next: File) => void;
  /**
   * يُستدعى عند فتح المودال (true) وعند إغلاقه (false).
   * يُتيح للمُستدعي تتبع حالة القص لتعطيل الإرسال.
   */
  onCropStateChange?: (isCropping: boolean) => void;
  uploadProgress?: number;
  error?: string;
}

/** أنواع MIME التي لا يدعمها القص (svg لا يُرسم على Canvas؛ gif يفقد الحركة) */
const UNCROPABLE_TYPES = new Set(['image/svg+xml', 'image/gif']);

const ImageAttachment = ({ file, onRemove, onReplace, onCropStateChange, uploadProgress, error }: ImageAttachmentProps) => {
  const { t } = useTranslation('chat');
  const [preview, setPreview] = useState<string | undefined>(undefined);
  // T-1235: an 80×80 thumbnail is too small to check what was actually attached,
  // so the preview opens full-screen on click — before the message is sent, while
  // removing the wrong picture still costs nothing.
  const [isZoomed, setIsZoomed] = useState(false);
  const [isCropping, setIsCropping] = useState(false);

  // نحتفظ بـ objectURL الخاص بالمودال منفصلاً حتى نُلغيه عند الإغلاق فقط
  const cropObjectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // تنظيف objectURL القص عند إزالة المكوّن — حماية من تسرّب الذاكرة
  useEffect(() => {
    return () => {
      if (cropObjectUrlRef.current) {
        URL.revokeObjectURL(cropObjectUrlRef.current);
        cropObjectUrlRef.current = null;
      }
    };
  }, []);

  const canCrop = !UNCROPABLE_TYPES.has(file.type) && Boolean(onReplace);

  const handleCropOpen = () => {
    // ننشئ objectURL مستقلاً للمودال (لا يُشارك مع preview لضمان عدم تلاشيه)
    cropObjectUrlRef.current = URL.createObjectURL(file);
    setIsCropping(true);
    onCropStateChange?.(true);
  };

  const handleCropClose = () => {
    setIsCropping(false);
    onCropStateChange?.(false);
    if (cropObjectUrlRef.current) {
      URL.revokeObjectURL(cropObjectUrlRef.current);
      cropObjectUrlRef.current = null;
    }
  };

  const handleCropConfirm = (croppedFile: File) => {
    handleCropClose();
    onReplace?.(croppedFile);
  };

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => setIsZoomed(true)}
        aria-label={`Preview ${file.name}`}
        className="block cursor-zoom-in rounded focus:outline-none focus:ring-2 focus:ring-primary"
      >
        <img src={preview} alt={file.name} className="h-20 w-20 rounded object-cover" />
      </button>
      {isZoomed && preview && (
        <ImageLightbox src={preview} alt={file.name} onClose={() => setIsZoomed(false)} />
      )}
      {uploadProgress !== undefined && uploadProgress < 100 && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <div className="text-xs text-white">{uploadProgress}%</div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-500/50">
          <svg className="h-6 w-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
      )}

      {/* زر القص — مخفيّ للـ svg و gif — ≥24px touch target */}
      {canCrop && (
        <button
          type="button"
          onClick={handleCropOpen}
          className="absolute -end-2 bottom-0 min-h-6 min-w-6 rounded-full bg-foreground/80 p-1.5 text-background opacity-100 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:opacity-0 sm:group-hover:opacity-100"
          aria-label={t('imageCrop.cropButton', { name: file.name })}
        >
          <Crop className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}

      <button
        type="button"
        onClick={onRemove}
        className="absolute -end-2 -top-2 min-h-6 min-w-6 rounded-full bg-red-500 p-1.5 text-white opacity-100 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:opacity-0 sm:group-hover:opacity-100"
        aria-label={t('images.remove')}
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* مودال القص — يُنشأ فقط عند الطلب (lazy) */}
      {isCropping && cropObjectUrlRef.current && (
        <Suspense fallback={null}>
          <ImageCropModal
            file={file}
            objectUrl={cropObjectUrlRef.current}
            onConfirm={handleCropConfirm}
            onClose={handleCropClose}
          />
        </Suspense>
      )}
    </div>
  );
};

export default ImageAttachment;
