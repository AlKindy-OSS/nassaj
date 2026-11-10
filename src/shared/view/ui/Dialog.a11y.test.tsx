import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from './Dialog';

afterEach(cleanup);

describe('Dialog accessible name and Escape hook', () => {
  it('names the dialog from DialogTitle and describes it from DialogDescription', () => {
    render(<Dialog open onOpenChange={() => undefined}><DialogContent>
      <DialogTitle>Title text</DialogTitle><DialogDescription>Helpful words</DialogDescription>
    </DialogContent></Dialog>);
    const dialog = screen.getByRole('dialog', { name: 'Title text' });
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent).toBe('Helpful words');
  });

  it('a caller-provided title id and aria-labelledby still win', () => {
    render(<Dialog open onOpenChange={() => undefined}><DialogContent aria-labelledby="own">
      <DialogTitle id="own">Mine</DialogTitle>
    </DialogContent></Dialog>);
    expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBe('own');
    expect(screen.getByRole('dialog', { name: 'Mine' })).toBeTruthy();
  });

  it('without title or description no dangling id references are emitted', () => {
    render(<Dialog open onOpenChange={() => undefined}><DialogContent aria-label="Named"><p>x</p></DialogContent></Dialog>);
    const dialog = screen.getByRole('dialog', { name: 'Named' });
    expect(dialog.hasAttribute('aria-labelledby')).toBe(false);
    expect(dialog.hasAttribute('aria-describedby')).toBe(false);
  });

  it('onEscapeKeyDown can keep the dialog open with preventDefault; otherwise Escape closes', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<Dialog open onOpenChange={onOpenChange}>
      <DialogContent onEscapeKeyDown={(e) => e.preventDefault()}><DialogTitle>T</DialogTitle></DialogContent>
    </Dialog>);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    rerender(<Dialog open onOpenChange={onOpenChange}><DialogContent><DialogTitle>T</DialogTitle></DialogContent></Dialog>);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
