/**
 * T-2046 (Q7): shared Mermaid zoom dialog — open, Escape/backdrop/close,
 * focus hand-off, label override, and wiki CSS hooks.
 *
 * Run: NODE_ENV=test npx vitest run src/shared/view/ZoomableMermaidDiagram.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

import ZoomableMermaidDiagram from './ZoomableMermaidDiagram';

vi.mock('./MermaidDiagram', () => ({
  default: ({ code, framed }: { code: string; framed?: boolean }) => (
    <div data-testid="mermaid" data-framed={String(framed ?? true)}>{code}</div>
  ),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

afterEach(cleanup);

function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Zoom diagram' }));
  return screen.getByRole('dialog', { name: 'Zoomed Mermaid diagram' });
}

describe('ZoomableMermaidDiagram', () => {
  it('renders the inline diagram with its framing and no dialog', () => {
    render(<ZoomableMermaidDiagram code="graph TD;A-->B" framed={false} />);
    expect(screen.getAllByTestId('mermaid')).toHaveLength(1);
    expect(screen.getByTestId('mermaid').dataset.framed).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a modal dialog with a second copy and focuses close', async () => {
    render(<ZoomableMermaidDiagram code="graph TD;A-->B" />);
    const dialog = openDialog();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getAllByTestId('mermaid')).toHaveLength(2);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' })));
  });

  it('closes on Escape without letting it bubble, and returns focus to zoom', async () => {
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    render(<ZoomableMermaidDiagram code="x" />);
    openDialog();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Zoom diagram' })));
    window.removeEventListener('keydown', outer);
  });

  it('ignores other keys and closes on backdrop and close button', () => {
    render(<ZoomableMermaidDiagram code="x" />);
    openDialog();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mermaid-zoom-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('uses label overrides and wiki hooks when given', () => {
    const { container } = render(
      <ZoomableMermaidDiagram
        code="x"
        labels={{ zoom: 'تكبير المخطط', zoomedAria: 'مخطط مكبَّر', close: 'إغلاق' }}
        inlineWrapperProps={{ 'data-wiki-mermaid': 'true' }}
        overlayClassName="wiki-mermaid-overlay"
      />,
    );
    expect(container.querySelector('[data-wiki-mermaid="true"] [data-testid="mermaid"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'تكبير المخطط' }));
    expect(screen.getByRole('dialog', { name: 'مخطط مكبَّر' }).querySelector('.wiki-mermaid-overlay')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'إغلاق' })).toBeTruthy();
  });
});
