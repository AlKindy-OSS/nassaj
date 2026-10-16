/**
 * T-2040 / ADR-211 — rich fences, sortable tables and the masked-run guard in
 * chat Markdown.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/Markdown.richBlocks.test.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

import { ChatActionsContext, type ChatActionsContextValue } from '../../context/ChatActionsContext';
import { SafeMarkdown } from '../../../../share/safeMarkdown';

import { Markdown } from './Markdown';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => (opts && opts.defaultValue) || key,
    i18n: { language: 'ar' },
  }),
}));

vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: { id: 1, username: 'owner' } }),
}));

vi.mock('../../../../hooks/useRawExecConfig', () => ({
  useRawExecConfig: () => ({ canUseRaw: true, loading: false }),
  useRawExecQueue: () => ({ commands: [], canUseRaw: false, loading: false, refresh: () => {} }),
  invalidateRawExecConfig: () => {},
  refreshRawExecConfig: () => {},
  subscribeRawExecConfig: () => () => {},
}));

vi.mock('../../../../hooks/useRawExecutionRecord', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useRawExecutionRecord: () => ({ record: null, refresh: () => {} }) };
});

// The renderers are covered in rich-blocks/*.test; here only the dispatch matters.
vi.mock('./rich-blocks/RichCodeBlock', () => ({
  default: ({ lang, source }: { lang: string; source: string }) => (
    <div data-testid="rich-block" data-lang={lang}>{source}</div>
  ),
}));

const RAW_BUTTON = 'Execute this command on the Nassaj server (opens review dialog)';

const CTX: ChatActionsContextValue = {
  catalog: [{ actionType: 'safe-restart', label: 'Safe restart', minRole: 'owner', commandPreview: 'bash x' } as never],
  runAction: async () => ({ status: 'error' as const, code: 'test' }),
  userRole: 'owner',
  inlineExecEnabled: true,
  liveStatusOf: () => null,
  sessionId: null,
};

function renderMd(md: string, streaming = false) {
  return render(
    <ChatActionsContext.Provider value={CTX}>
      <Markdown streaming={streaming}>{md}</Markdown>
    </ChatActionsContext.Provider>,
  );
}

const fence = (info: string, body: string) => '```' + info + '\n' + body + '\n```';

afterEach(cleanup);

describe('rich fence dispatch', () => {
  it.each(['mermaid', 'vega-lite', 'vega', 'd3'])('renders a closed %s fence as a rich block', async (lang) => {
    renderMd(fence(lang, 'graph TD; A-->B'));
    const block = await screen.findByTestId('rich-block');
    expect(block.getAttribute('data-lang')).toBe(lang);
    expect(block.textContent).toBe('graph TD; A-->B');
  });

  it('keeps raw source while the message is streaming', () => {
    renderMd(fence('mermaid', 'graph TD; A-->B'), true);
    expect(screen.queryByTestId('rich-block')).toBeNull();
    expect(document.body.textContent).toContain('graph TD; A-->B');
  });

  it('keeps raw source for an unclosed fence after streaming ended', () => {
    renderMd('intro\n\n```mermaid\ngraph TD; A-->B\n');
    expect(screen.queryByTestId('rich-block')).toBeNull();
    expect(document.body.textContent).toContain('graph TD; A-->B');
  });

  it('does not treat lookalike languages as rich', () => {
    renderMd(fence('d3js', 'x') + '\n\n' + fence('vegalite', 'y'));
    expect(screen.queryByTestId('rich-block')).toBeNull();
  });

  it('never turns `mermaid nassaj-run` into a run button (closed or unclosed)', async () => {
    renderMd(fence('mermaid nassaj-run', 'graph TD; A-->B'));
    await screen.findByTestId('rich-block');
    expect(screen.queryByRole('button', { name: RAW_BUTTON })).toBeNull();
    cleanup();
    renderMd('```mermaid nassaj-run\ngraph TD; A-->B\n');
    expect(screen.queryByRole('button', { name: RAW_BUTTON })).toBeNull();
  });

  it('public share viewer keeps rich fences as plain code', () => {
    render(<SafeMarkdown text={fence('mermaid', 'graph TD; A-->B') + '\n' + fence('d3', 'root.textContent=1')} selfHost="x" />);
    const codes = document.querySelectorAll('pre > code');
    expect(codes).toHaveLength(2);
    expect(codes[0].className).toContain('language-mermaid');
    expect(screen.queryByTestId('rich-block')).toBeNull();
    expect(document.querySelector('iframe, svg')).toBeNull();
  });
});

describe('masked secrets disable run buttons', () => {
  it('raw run button is disabled when the fence carries [masked:', () => {
    renderMd(fence('bash nassaj-run', 'curl -H "Authorization: [masked:bearer-token]" https://x'));
    const button = screen.getByRole('button', { name: RAW_BUTTON }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/masked/i);
  });

  it('raw run button stays enabled without a marker', () => {
    renderMd(fence('bash nassaj-run', 'echo hi'));
    expect((screen.getByRole('button', { name: RAW_BUTTON }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('nassaj-exec button is disabled when the fence carries [masked:', () => {
    renderMd(fence('nassaj-exec:safe-restart', 'token=[masked:generic-secret]'));
    const button = screen.getAllByRole('button').find((b) => b.title.match(/masked/i)) as HTMLButtonElement;
    expect(button).toBeDefined();
    expect(button.disabled).toBe(true);
  });
});

describe('sortable tables', () => {
  const table = [
    '| الاسم | القيمة |',
    '|---|---:|',
    '| ب | ١٠ |',
    '| أ | ٢ |',
    '| ج | ٣٠٠ |',
    '| د |  |',
  ].join('\n');

  const column = (i: number) =>
    Array.from(document.querySelectorAll('tbody tr')).map((tr) => tr.children[i].textContent);

  it('cycles ascending → descending → original with aria-sort, numbers incl. Arabic-Indic', () => {
    renderMd(table);
    const header = screen.getAllByRole('columnheader')[1];
    const button = within(header).getByRole('button');
    expect(header.getAttribute('aria-sort')).toBe('none');
    expect(column(1)).toEqual(['١٠', '٢', '٣٠٠', '']);

    fireEvent.click(button);
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(column(1)).toEqual(['٢', '١٠', '٣٠٠', '']);

    fireEvent.click(button);
    expect(header.getAttribute('aria-sort')).toBe('descending');
    expect(column(1)).toEqual(['٣٠٠', '١٠', '٢', '']);

    fireEvent.click(button);
    expect(header.getAttribute('aria-sort')).toBe('none');
    expect(column(1)).toEqual(['١٠', '٢', '٣٠٠', '']);
  });

  it('sorts text columns with the locale collator and resets other columns', () => {
    renderMd(table);
    const [nameHeader, valueHeader] = screen.getAllByRole('columnheader');
    fireEvent.click(within(valueHeader).getByRole('button'));
    fireEvent.click(within(nameHeader).getByRole('button'));
    expect(valueHeader.getAttribute('aria-sort')).toBe('none');
    expect(nameHeader.getAttribute('aria-sort')).toBe('ascending');
    expect(column(0)).toEqual(['أ', 'ب', 'ج', 'د']);
  });

  it('keeps GFM column alignment and cell markup', () => {
    renderMd('| a | b |\n|---|---:|\n| `x` | 1 |\n| **y** | 2 |');
    const valueHeader = screen.getAllByRole('columnheader')[1];
    expect(valueHeader.style.textAlign).toBe('right');
    expect(document.querySelector('tbody code')).not.toBeNull();
    expect(document.querySelector('tbody strong')).not.toBeNull();
  });
});
