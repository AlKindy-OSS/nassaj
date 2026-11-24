import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import ImageLightbox from './ImageLightbox';

afterEach(cleanup);

describe('ImageLightbox', () => {
  it('يعرض الصورة في حوار ويغلق بزر الإغلاق مرة واحدة', () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="data:image/png;base64,AA==" alt="لقطة الشاشة" onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'لقطة الشاشة' })).toBeDefined();
    expect(screen.getByRole('img', { name: 'لقطة الشاشة' })).toBeDefined();
    const close = screen.getByRole('button', { name: 'images.closePreview' });
    expect(document.activeElement).toBe(close);

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('يغلق بالنقر على الخلفية ولا يغلق بالنقر على الصورة', () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="data:image/png;base64,AA==" alt="صورة" onClose={onClose} />);
    const dialog = screen.getByRole('dialog');

    fireEvent.click(screen.getByRole('img'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('يغلق بمفتاح Escape ويعيد التركيز إلى العنصر السابق عند الفك', () => {
    const onClose = vi.fn();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(
      <ImageLightbox src="data:image/png;base64,AA==" alt="صورة" onClose={onClose} />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

// ── B-1805: zoom, pan, focus cycle and the original-image control ──────────

/** jsdom has no PointerEvent; a MouseEvent subclass carries the fields we read. */
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
  }
}

const TALL = { naturalWidth: 1170, naturalHeight: 20000 };
const VIEWPORT = { clientWidth: 390, clientHeight: 844 };
const stubbed: Array<[object, string, PropertyDescriptor | undefined]> = [];

function stubGetter(target: object, key: string, value: number) {
  stubbed.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
  Object.defineProperty(target, key, { configurable: true, get: () => value });
}

function stubLayout() {
  stubGetter(HTMLImageElement.prototype, 'naturalWidth', TALL.naturalWidth);
  stubGetter(HTMLImageElement.prototype, 'naturalHeight', TALL.naturalHeight);
  stubGetter(HTMLElement.prototype, 'clientWidth', VIEWPORT.clientWidth);
  stubGetter(HTMLElement.prototype, 'clientHeight', VIEWPORT.clientHeight);
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
}

afterEach(() => {
  while (stubbed.length) {
    const [target, key, descriptor] = stubbed.pop()!;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete (target as Record<string, unknown>)[key];
  }
  vi.unstubAllGlobals();
});

function renderLoaded(src = 'blob:https://app.example/1', onClose = vi.fn()) {
  stubLayout();
  render(<ImageLightbox src={src} alt="لقطة" onClose={onClose} />);
  const img = screen.getByRole('img') as HTMLImageElement;
  fireEvent.load(img);
  return { img, onClose, dialog: screen.getByRole('dialog') };
}

function pointer(target: Element, type: string, init: PointerEventInit) {
  target.dispatchEvent(new TestPointerEvent(type, { bubbles: true, cancelable: true, ...init }));
}

describe('ImageLightbox — B-1805', () => {
  it('يفتح الصورة الطويلة بعرض الإطار ويعرض النسبة داخل bdi', () => {
    const { img } = renderLoaded();
    expect(img.style.width).toBe('390px');
    const toolbar = screen.getByRole('toolbar', { name: 'images.toolbar' });
    expect(toolbar.querySelector('bdi')?.textContent).toBe('33%');
    expect((screen.getByRole('button', { name: 'images.zoomOut' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'images.zoomIn' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('يدور التركيز على عناصر الحوار المفعّلة بـTab وShift+Tab', () => {
    const { dialog } = renderLoaded();
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ));
    expect(focusables.length).toBeGreaterThan(2);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(focusables[1]);
  });

  it('اختصارات + و- و0 تعمل بلا ctrl ولا تخطف تكبير المتصفح', () => {
    const { img } = renderLoaded();
    fireEvent.keyDown(document, { key: '+' });
    const zoomed = parseFloat(img.style.width);
    expect(zoomed).toBeGreaterThan(390);

    const withCtrl = fireEvent.keyDown(document, { key: '=', ctrlKey: true });
    expect(withCtrl).toBe(true); // not default-prevented
    expect(parseFloat(img.style.width)).toBe(zoomed);
    fireEvent.keyDown(document, { key: '-', metaKey: true });
    expect(parseFloat(img.style.width)).toBe(zoomed);

    fireEvent.keyDown(document, { key: '-' });
    expect(parseFloat(img.style.width)).toBeLessThan(zoomed);
    fireEvent.keyDown(document, { key: '=' });
    fireEvent.keyDown(document, { key: '0' });
    expect(img.style.width).toBe('390px');
  });

  it('لا يغلق النقرُ التالي لسحبٍ انتهى على الخلفية، ويغلق النقر النظيف', () => {
    const { dialog, onClose } = renderLoaded();
    pointer(dialog, 'pointerdown', { pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 10, button: 0 });
    pointer(dialog, 'pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 60, buttons: 1 });
    pointer(dialog, 'pointerup', { pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 60 });
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    pointer(dialog, 'pointerdown', { pointerId: 2, pointerType: 'mouse', clientX: 10, clientY: 10, button: 0 });
    pointer(dialog, 'pointerup', { pointerId: 2, pointerType: 'mouse', clientX: 11, clientY: 10 });
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('رابط http يفتح الأصل في تبويب جديد بـnoopener', () => {
    renderLoaded('https://cdn.example/shot.png');
    const link = screen.getByRole('link', { name: 'images.openOriginal' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.hasAttribute('download')).toBe(false);
  });

  it('blob: وdata: يصيران تنزيلاً لا تنقّلاً', () => {
    renderLoaded('blob:https://app.example/1');
    const blobLink = screen.getByRole('link', { name: 'images.download' });
    expect(blobLink.hasAttribute('download')).toBe(true);
    expect(blobLink.hasAttribute('target')).toBe(false);
    cleanup();

    renderLoaded('data:image/png;base64,AA==');
    expect(screen.getByRole('link', { name: 'images.download' }).hasAttribute('download')).toBe(true);
  });

  it('يستعمل مفتاح ترجمة حين لا يوجد نص بديل', () => {
    render(<ImageLightbox src="data:image/png;base64,AA==" onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'images.previewFallback' })).toBeDefined();
  });
});
