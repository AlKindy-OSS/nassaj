import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CommandMenu from './CommandMenu';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const commands = [
  { name: '/help', namespace: 'builtin', type: 'built-in' },
  { name: '/models', namespace: 'builtin', type: 'built-in' },
];

const renderMenu = () => {
  const onClose = vi.fn();
  const utils = render(
    <div>
      <button type="button" data-command-menu-toggle="">toggle</button>
      <p>outside</p>
      <CommandMenu commands={commands} isOpen onClose={onClose} />
    </div>,
  );
  return { onClose, ...utils };
};

describe('CommandMenu close behaviour', () => {
  it('renders a labelled close button that closes the menu', () => {
    const { onClose } = renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'commandMenu.close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows the total command count in its header', () => {
    renderMenu();
    expect(screen.getByText('commandMenu.title')).toBeTruthy();
    expect(screen.getByText(String(commands.length))).toBeTruthy();
  });

  it('closes on a pointer tap outside the menu', () => {
    const { onClose } = renderMenu();
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not close on a tap inside the menu or on its own toggle button', () => {
    const { onClose } = renderMenu();
    fireEvent.pointerDown(screen.getByText('/help'));
    fireEvent.pointerDown(screen.getByText('toggle'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape unless another handler already consumed it', () => {
    const { onClose } = renderMenu();
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    consumed.preventDefault();
    document.dispatchEvent(consumed);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('attaches no listeners while closed', () => {
    const onClose = vi.fn();
    render(<CommandMenu commands={commands} isOpen={false} onClose={onClose} />);
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
