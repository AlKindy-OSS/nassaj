import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../../utils/api';

import ImageLightbox from './ImageLightbox';

interface ChatMessageImageProps {
  /**
   * Either a `data:` URL (the freshly-sent message, which still holds the bytes
   * in memory) or a `/api/chat-images/...` path (the same message once it comes
   * back from the transcript), or a pre-built `/api/assistant-images?...` URL.
   */
  src: string;
  alt?: string;
  /**
   * T-1737 — عند true تُعرَض رسالة خطأ مرئية عند فشل تحميل الصورة بدلاً من
   * الإخفاء الصامت (return null). مفعَّل لمسار المساعد فقط؛ مسار مرفقات
   * المستخدم يبقى على سلوكه الصامت (تعليق «stays silent … older than the
   * durable store» — لا انحدار).
   */
  showLoadError?: boolean;
  /**
   * T-1737 — مُحلِّل نصّ الخطأ من رمز HTTP أو 'network'.
   * يُستدعى فقط عند showLoadError=true وفشل التحميل. يُتيح ربط كل رمز
   * بالنصّ العربي المناسب (جدول العقد: 400/403/404/413/415/500/network).
   * الافتراضي: دالّة تُعيد 'تعذّر تحميل الصورة' لكل الرموز.
   */
  loadErrorMessageFor?: (status: number | 'network') => string;
  /**
   * T-1737 — `object-contain` لصور المساعد (لقطات شاشة / مخطّطات لا تُقصّ).
   * `object-cover` (الافتراضي) يبقى لمرفقات المستخدم المربّعة.
   */
  objectFit?: 'cover' | 'contain';
}

const _defaultLoadErrorMessageFor = () => 'تعذّر تحميل الصورة';

/**
 * B-430 / T-1235 — one picture inside a sent user message.
 * T-1737 — extended for assistant inline images.
 *
 * The API route is authenticated and <img src> cannot carry an Authorization
 * header, so a stored image is fetched as a blob first (the pattern ImageViewer
 * already uses for project files) rather than weakening the route to accept a
 * `?token=` — query tokens leak into history and logs (B-160).
 *
 * `showLoadError` / `loadErrorMessageFor`: when true, a load failure shows a
 * small visible error notice instead of returning null. The resolver receives
 * the actual HTTP status code (e.g. 403, 415) or 'network', enabling per-code
 * Arabic messages from the contract table. The user-attachment path keeps its
 * silent behaviour (older messages without a durable store). م-1.
 *
 * `objectFit`: `contain` for assistant images (screenshots / diagrams must not
 * be cropped), `cover` (default) for the square user-attachment thumbnails. م-2.
 */
const ChatMessageImage = ({
  src,
  alt,
  showLoadError = false,
  loadErrorMessageFor = _defaultLoadErrorMessageFor,
  objectFit = 'cover',
}: ChatMessageImageProps) => {
  const needsAuth = src.startsWith('/api/');
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(needsAuth ? null : src);
  // null = loading/success; number = HTTP error status; 'network' = fetch threw
  const [failureStatus, setFailureStatus] = useState<number | 'network' | null>(null);
  const [isZoomed, setIsZoomed] = useState(false);

  useEffect(() => {
    if (!needsAuth) {
      setResolvedSrc(src);
      setFailureStatus(null);
      return;
    }

    let objectUrl: string | null = null;
    const controller = new AbortController();

    (async () => {
      try {
        setFailureStatus(null);
        const response = await authenticatedFetch(src, { signal: controller.signal });
        if (!response.ok) {
          // Capture the exact HTTP status for per-code error messages.
          setFailureStatus(response.status);
          return;
        }
        objectUrl = URL.createObjectURL(await response.blob());
        setResolvedSrc(objectUrl);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        // A missing file is expected for messages older than the durable store,
        // so this stays silent in the UI: the path note in the text already says
        // what was attached.
        setFailureStatus('network');
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, needsAuth]);

  // حالة الفشل — سلوك مختلف بحسب showLoadError
  const hasFailed = failureStatus !== null;
  if (hasFailed || !resolvedSrc) {
    if (showLoadError && hasFailed) {
      const message = loadErrorMessageFor(failureStatus!);
      return (
        <div
          role="img"
          aria-label={message}
          className="my-1 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <svg
            className="h-4 w-4 flex-shrink-0"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
              clipRule="evenodd"
            />
          </svg>
          <span>{message}</span>
        </div>
      );
    }
    return null;
  }

  const fitClass = objectFit === 'contain'
    ? 'max-h-80 w-auto object-contain'
    : 'max-h-56 w-full object-cover';

  return (
    <>
      <button
        type="button"
        onClick={() => setIsZoomed(true)}
        aria-label={alt ? `Preview ${alt}` : 'Preview image'}
        className="block max-w-full cursor-zoom-in rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <img
          src={resolvedSrc}
          alt={alt || ''}
          className={`h-auto max-w-full transition-opacity hover:opacity-90 ${fitClass}`}
        />
      </button>
      {isZoomed && (
        <ImageLightbox src={resolvedSrc} alt={alt} onClose={() => setIsZoomed(false)} />
      )}
    </>
  );
};

export default ChatMessageImage;
