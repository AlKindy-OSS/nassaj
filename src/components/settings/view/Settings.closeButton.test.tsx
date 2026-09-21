import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SettingsCloseButton from './SettingsCloseButton';

afterEach(cleanup);

describe('Settings close button accessibility', () => {
  it('has the translated accessible name and keeps the icon decorative', () => {
    const onClose = vi.fn();
    const { container } = render(<SettingsCloseButton onClose={onClose} label="Close settings" />);

    const button = screen.getByRole('button', { name: 'Close settings' });
    expect(button.getAttribute('aria-label')).toBe('Close settings');
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(button);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
