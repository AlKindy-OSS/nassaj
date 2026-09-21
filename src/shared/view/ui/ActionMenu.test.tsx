import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ActionMenu from './ActionMenu';

afterEach(cleanup);

describe('ActionMenu', () => {
  it('keeps the danger tone when a destructive item receives focus', () => {
    render(
      <ActionMenu
        label="Account"
        items={[
          { key: 'settings', label: 'Settings', onSelect: vi.fn() },
          { key: 'logout', label: 'Sign out', isDanger: true, onSelect: vi.fn() },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Account' }));

    const menu = screen.getByRole('menu');
    const settings = screen.getByRole('menuitem', { name: 'Settings' });
    const logout = screen.getByRole('menuitem', { name: 'Sign out' });

    expect(menu.className).toContain('bg-popover');
    expect(menu.className).toContain('border-border');
    expect(settings.className).toContain('focus:text-accent-foreground');
    expect(logout.className).toContain('text-danger');
    expect(logout.className).toContain('focus:text-danger');
    expect(logout.className).not.toContain('focus:text-accent-foreground');
  });
});
