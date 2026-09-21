import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ImageLightboxProps {
  /** Anything an <img> accepts: a blob:, data: or already-resolved http URL. */
  src: string;
  alt?: string;
  onClose: () => void;
}

/**
 * T-1235 — full-screen preview for a chat image (composer attachment or a
 * picture already sent).
 *
 * Rendered through a portal on <body>: the composer thumbnails live inside a
 * `overflow-hidden rounded-2xl` prompt box, so an in-place overlay would be
 * clipped to a 80×80 square instead of covering the viewport.
 */
const ImageLightbox = ({ src, alt, onClose }: ImageLightboxProps) => {
  const { t } = useTranslation('chat');
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      // The close control is deliberately the only interactive element in the
      // dialog. Keep keyboard focus inside the modal instead of tabbing into
      // the chat hidden behind it.
      if (event.key === 'Tab') {
        event.preventDefault();
        closeButtonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    closeButtonRef.current?.focus();
    // The page behind must not scroll while the overlay is up (touch devices
    // otherwise pan the chat under the picture).
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      // Only a click whose actual target is the backdrop closes. This also
      // avoids the close button's bubbling click calling onClose twice.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'Image preview'}
    >
      <button
        ref={closeButtonRef}
        type="button"
        onClick={onClose}
        aria-label={t('images.closePreview')}
        className="absolute end-4 top-4 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-black/80"
      >
        <X className="h-5 w-5" />
      </button>
      <img
        src={src}
        alt={alt || ''}
        className="max-h-[90vh] max-w-[95vw] rounded-lg object-contain shadow-2xl"
      />
    </div>,
    document.body,
  );
};

export default ImageLightbox;
