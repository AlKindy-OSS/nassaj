/**
 * T-2046 (Q4): a fenced block above MAX_HIGHLIGHT_CHARS renders as plain
 * preformatted text (no Prism tokens) and its copy button still copies it all.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/Markdown.largeCode.test.tsx
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { MAX_HIGHLIGHT_CHARS } from '../../../../syntax/highlightBudget';

import { Markdown } from './Markdown';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: null }),
}));

vi.mock('../../../../hooks/useRawExecConfig', () => ({
  useRawExecConfig: () => ({ canUseRaw: false, loading: false }),
  useRawExecQueue: () => ({ commands: [], canUseRaw: false, loading: false, refresh: () => {} }),
  invalidateRawExecConfig: () => {},
  refreshRawExecConfig: () => {},
}));

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(cleanup);

function fence(body: string): string {
  return `\`\`\`js\n${body}\n\`\`\``;
}

describe('Markdown large code blocks', () => {
  // The exact boundary is unit-tested in src/syntax/highlightBudget.test.tsx;
  // highlighting a block at the budget here takes ~25s in jsdom.
  it('still highlights an ordinary block', () => {
    const { container } = render(<Markdown>{fence('const a = 1;')}</Markdown>);
    expect(container.querySelector('pre[data-plain-code]')).toBeNull();
    expect(container.querySelector('pre')).not.toBeNull();
  });

  it('renders a block over the budget as plain text with the full content', () => {
    const body = `const a = 1;\n${'y'.repeat(MAX_HIGHLIGHT_CHARS)}`;
    const { container } = render(<Markdown>{fence(body)}</Markdown>);
    const pre = container.querySelector('pre[data-plain-code]');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe(`${body}\n`);
    expect(pre?.querySelector('.token')).toBeNull();
    expect((pre as HTMLElement).style.margin).toBe('0px');
  });

  it('copies the whole oversized block', async () => {
    const body = 'z'.repeat(MAX_HIGHLIGHT_CHARS + 1);
    render(<Markdown>{fence(body)}</Markdown>);
    fireEvent.click(screen.getByRole('button', { name: /codeBlock\.copy|copy/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${body}\n`));
  });
});
