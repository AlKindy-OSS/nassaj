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
