/**
 * T-2037 — the dialog's verbatim block: LTR, monospace, plain text (never
 * markup), and part of the dialog's accessible description.
 * Run: NODE_ENV=test npx vitest run src/shared/view/ui/ConfirmDialog.code.test.tsx
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './ConfirmDialog';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(cleanup);

describe('ConfirmDialog code block', () => {
  it('renders the command verbatim in an LTR block inside an RTL document', () => {
    document.documentElement.dir = 'rtl';
    const command = '<b>systemctl</b> restart nginx && echo "`x`"';
    render(
      <ConfirmDialog title="t" message="m" code={command} tone="danger" onConfirm={() => {}} onCancel={() => {}} />,
    );
    const block = screen.getByTestId('confirm-dialog-code');
    expect(block.getAttribute('dir')).toBe('ltr');
    expect(block.textContent).toBe(command);
    expect(block.querySelector('b')).toBeNull();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.getAttribute('aria-describedby')).toContain(block.id);
    document.documentElement.dir = '';
  });

  it('omits the block without code', () => {
    render(<ConfirmDialog message="m" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.queryByTestId('confirm-dialog-code')).toBeNull();
  });
});
