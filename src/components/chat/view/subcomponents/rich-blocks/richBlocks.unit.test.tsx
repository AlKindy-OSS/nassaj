/**
 * T-2040 / ADR-211 — unit tests for the rich-block helpers, the frame document,
 * the frame slot cap, the sandbox component and RichCodeBlock's gating.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/rich-blocks/richBlocks.unit.test.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { isClosedFenceSource, parseSpec, richLangOf } from './richBlockLangs';
import { isNumericColumn, nextSortState, parseCellNumber, sortRowOrder } from './tableSort';
import {
  buildFrameDocument, clampFrameHeight, escapeInlineScript, FRAME_CHANNEL, FRAME_CSP, MAX_FRAME_HEIGHT, MIN_FRAME_HEIGHT,
  READY_AFTER_LOAD_MS, READY_TIMEOUT_MS,
} from './frameDocument';
import { acquireFrameSlot, liveFrameCount, MAX_LIVE_FRAMES } from './frameSlots';
import { interpreterAsClassicScript } from './vizLibraries';
import { checkSpecBudget, MAX_SEQUENCE_ROWS, stripEmbedOptions } from './specGuards';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => (opts && opts.defaultValue) || key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../../../contexts/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));

vi.mock('./vizLibraries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadVizLibraries: () => Promise.resolve({ scripts: ['/*lib*/'], fontCss: '' }),
}));

afterEach(cleanup);

describe('richLangOf', () => {
  it('matches exact fence languages only', () => {
    expect(richLangOf('language-mermaid')).toBe('mermaid');
    expect(richLangOf('language-vega-lite')).toBe('vega-lite');
    expect(richLangOf('language-vega')).toBe('vega');
    expect(richLangOf('language-d3')).toBe('d3');
    expect(richLangOf('language-D3')).toBe('d3');
    expect(richLangOf('language-d3js')).toBeNull();
    expect(richLangOf('language-vega-lite-x')).toBeNull();
    expect(richLangOf('language-bash')).toBeNull();
    expect(richLangOf(undefined)).toBeNull();
  });
});

describe('isClosedFenceSource', () => {
  it.each([
    ['```mermaid\nA\n```', true],
    ['~~~vega\n{}\n~~~', true],
    ['````d3\nx\n`````', true],
    ['> ```mermaid\n> A\n> ```', true],
    ['- ```mermaid\n  A\n  ```', true],
    ['```mermaid\nA\n', false],
    ['```mermaid\nA', false],
    ['```mermaid', false],
    ['````d3\nx\n```', false],
    ['```d3\nx\n~~~', false],
    ['```d3\nx\n``` trailing', false],
  ])('%j → %s', (source, expected) => {
    expect(isClosedFenceSource(source)).toBe(expected);
  });
});

describe('tableSort', () => {
  it('parses Arabic-Indic, Persian, separators and percent', () => {
    expect(parseCellNumber('١٢٣')).toBe(123);
    expect(parseCellNumber('۴۵')).toBe(45);
    expect(parseCellNumber('٣٫٥')).toBe(3.5);
    expect(parseCellNumber('١٬٢٣٤')).toBe(1234);
    expect(parseCellNumber('1,234,567')).toBe(1234567);
    expect(parseCellNumber('45%')).toBe(45);
    expect(parseCellNumber('٪٤٥')).toBe(45);
    expect(parseCellNumber('−3')).toBe(-3);
    expect(parseCellNumber('1e3')).toBe(1000);
    expect(parseCellNumber('v1.2')).toBeNull();
    expect(parseCellNumber('12 KB')).toBeNull();
    expect(parseCellNumber('')).toBeNull();
  });

  it('detects numeric columns ignoring empty cells', () => {
    expect(isNumericColumn(['1', '', '٢'])).toBe(true);
    expect(isNumericColumn(['1', 'x'])).toBe(false);
    expect(isNumericColumn(['', ' '])).toBe(false);
  });

  it('sorts stably, empties last in both directions', () => {
    const cells = ['b', '', 'a', 'B', 'a'];
    expect(sortRowOrder(cells, { column: 0, direction: 'ascending' }, 'en')).toEqual([2, 4, 0, 3, 1]);
    expect(sortRowOrder(cells, { column: 0, direction: 'descending' }, 'en')).toEqual([0, 3, 2, 4, 1]);
    expect(sortRowOrder(cells, null, 'en')).toEqual([0, 1, 2, 3, 4]);
  });

  it('uses numeric collation for mixed text', () => {
    expect(sortRowOrder(['item 10', 'item 2', 'item 1'], { column: 0, direction: 'ascending' }, 'ar'))
      .toEqual([2, 1, 0]);
  });

  it('cycles through three states and restarts on a new column', () => {
    const a = nextSortState(null, 1);
    expect(a).toEqual({ column: 1, direction: 'ascending' });
    const d = nextSortState(a, 1);
    expect(d).toEqual({ column: 1, direction: 'descending' });
    expect(nextSortState(d, 1)).toBeNull();
    expect(nextSortState(d, 0)).toEqual({ column: 0, direction: 'ascending' });
  });
});

describe('frame document', () => {
  it('carries the exact CSP and no network-capable source', () => {
    expect(FRAME_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; "
      + "font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'",
    );
    const html = buildFrameDocument({ kind: 'vega', nonce: 'n1', libraries: ['/*lib*/'], fontCss: '' });
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`);
    expect(html).not.toMatch(/unsafe-eval|<script[^>]+src=|https?:\/\//);
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'));
  });

  it('escapes sequences that could close or re-mode the inline script', () => {
    expect(escapeInlineScript('a="</script><img src=x>";b="<!--"')).toBe('a="<\\/script><img src=x>";b="<\\!--"');
    expect(escapeInlineScript('</SCRIPT>')).toBe('<\\/SCRIPT>');
    const html = buildFrameDocument({
      kind: 'd3', nonce: 'n', libraries: [], fontCss: '', userCode: 'x = "</script><script>alert(1)</script>"',
    });
    // Only the document's own closing tags remain.
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).toContain('window.__nassajD3=(function(d3, root, width, height){');
  });

  it('places D3 code inside the wrapper function body', () => {
    const html = buildFrameDocument({ kind: 'd3', nonce: 'n', libraries: [], fontCss: '', userCode: 'root.textContent = 1;' });
    expect(html).toMatch(/window\.__nassajD3=\(function\(d3, root, width, height\)\{\nroot\.textContent = 1;\n\}\);/);
  });
});

describe('vega-interpreter rewrite', () => {
  it('turns the ESM file into a classic script, and fails closed on an unknown shape', () => {
    const esm = "import { ascending, isString, DisallowedObjectProperties } from 'vega-util';\n"
      + 'function expression(){}\nexport { expression as expressionInterpreter };\n//# sourceMappingURL=x.map';
    const out = interpreterAsClassicScript(esm);
    expect(out).not.toMatch(/^\s*(import|export)\b/m);
    expect(out).toContain('self.vegaInterpreter = { expressionInterpreter: expression };');
    expect(out).not.toContain('sourceMappingURL');
    expect(() => interpreterAsClassicScript('export default 1')).toThrow();
  });
});

describe('frame slots', () => {
  it(`grants at most ${MAX_LIVE_FRAMES} and hands freed slots on in order`, () => {
    const granted: number[] = [];
    const releases = Array.from({ length: MAX_LIVE_FRAMES + 2 }, (_, i) => acquireFrameSlot(() => granted.push(i)));
    expect(granted).toHaveLength(MAX_LIVE_FRAMES);
    expect(liveFrameCount()).toBe(MAX_LIVE_FRAMES);
    releases[MAX_LIVE_FRAMES + 1](); // cancel a waiter
    releases[0]();
    expect(granted.at(-1)).toBe(MAX_LIVE_FRAMES);
    releases.forEach((r) => r());
    expect(liveFrameCount()).toBe(0);
  });
});

describe('VizSandbox', () => {
  it('clamps reported heights', () => {
    expect(clampFrameHeight(5)).toBe(MIN_FRAME_HEIGHT);
    expect(clampFrameHeight(99999)).toBe(MAX_FRAME_HEIGHT);
    expect(clampFrameHeight(300.4)).toBe(300);
    expect(clampFrameHeight('300')).toBeNull();
    expect(clampFrameHeight(NaN)).toBeNull();
  });

  it('renders an allow-scripts-only, no-referrer frame and ignores foreign messages', async () => {
    const { default: VizSandbox } = await import('./VizSandbox');
    const onError = vi.fn();
    render(<VizSandbox kind="vega-lite" spec={{ mark: 'bar' }} onError={onError} />);
    const frame = (await screen.findByTitle(/vega-lite/)) as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('srcdoc')).toContain(FRAME_CSP);
    const nonce = /var NONCE="([0-9a-f]{32})"/.exec(frame.getAttribute('srcdoc') ?? '')?.[1];
    expect(nonce).toBeTruthy();
    await act(async () => {}); // flush the listener effect

    // A message from another window — even with the right nonce — is ignored.
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { channel: FRAME_CHANNEL, nonce, type: 'error', message: 'spoof' }, source: window,
      }));
    });
    expect(onError).not.toHaveBeenCalled();

    // From the frame's own window it is honoured.
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { channel: FRAME_CHANNEL, nonce, type: 'height', height: 5000 }, source: frame.contentWindow,
      }));
    });
    expect(frame.style.height).toBe(`${MAX_FRAME_HEIGHT}px`);
  });

  it('reports a timeout when the frame never says ready', async () => {
    vi.useFakeTimers();
    try {
      const { default: VizSandbox } = await import('./VizSandbox');
      const onError = vi.fn();
      render(<VizSandbox kind="vega" spec={{}} onError={onError} />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      act(() => { vi.advanceTimersByTime(READY_TIMEOUT_MS + 1); });
      expect(onError).toHaveBeenCalledWith('timeout');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('parseSpec', () => {
  it('accepts JSON objects only', () => {
    expect(parseSpec('{"mark":"bar"}')).toEqual({ spec: { mark: 'bar' } });
    expect('error' in parseSpec('[1]')).toBe(true);
    expect('error' in parseSpec('{mark: bar}')).toBe(true);
  });
});

describe('RichCodeBlock', () => {
  it('shows source and an error for an invalid Vega-Lite spec, no frame', async () => {
    const { default: RichCodeBlock } = await import('./RichCodeBlock');
    render(<RichCodeBlock lang="vega-lite" source="{not json" />);
    expect(screen.getByText('This block could not be rendered')).toBeTruthy();
    expect(screen.getByText('{not json')).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('runs nothing for D3 until Run is clicked', async () => {
    const { default: RichCodeBlock } = await import('./RichCodeBlock');
    render(<RichCodeBlock lang="d3" source="root.textContent = 'x';" />);
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Run D3/ }));
    expect(await screen.findByTitle(/d3/)).toBeTruthy();
  });

  it('shows oversized blocks as source only', async () => {
    const { default: RichCodeBlock } = await import('./RichCodeBlock');
    render(<RichCodeBlock lang="vega" source={'{"a":"' + 'x'.repeat(70 * 1024) + '"}'} />);
    expect(screen.getByText('too large')).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('spec guards (M4/M2)', () => {
  it('rejects oversized or unbounded sequences, vega and vega-lite', () => {
    expect(checkSpecBudget({ transforms: [{ type: 'sequence', start: 0, stop: 1e9 }] })).toMatch(/sequence/);
    expect(checkSpecBudget({ data: { sequence: { start: 0, stop: 1e9, as: 'x' } } })).toMatch(/sequence/);
    expect(checkSpecBudget({ data: [{ transform: [{ type: 'sequence', stop: { signal: 'n' } }] }] })).toMatch(/sequence/);
    expect(checkSpecBudget({ data: { sequence: { start: 0, stop: MAX_SEQUENCE_ROWS } } })).toBeNull();
    expect(checkSpecBudget({ transform: [{ type: 'sequence', start: 0, stop: 5000 }, { type: 'cross' }] })).toMatch(/sequence/);
    expect(checkSpecBudget({ transform: [{ type: 'sequence', start: 0, stop: 500 }, { type: 'cross' }] })).toBeNull();
  });

  it('rejects timer event streams in any form', () => {
    expect(checkSpecBudget({ signals: [{ name: 't', on: [{ events: 'timer{16}', update: 't+1' }] }] })).toMatch(/timer/);
    expect(checkSpecBudget({ signals: [{ name: 't', on: [{ events: { type: 'timer', throttle: 1 }, update: '1' }] }] }))
      .toMatch(/timer/);
    expect(checkSpecBudget({ params: [{ name: 'p', select: { type: 'point', on: 'timer' } }] })).toMatch(/timer/);
    expect(checkSpecBudget({ title: 'Kitchen timer usage', mark: 'bar' })).toBeNull();
    expect(checkSpecBudget({ signals: [{ name: 'c', on: [{ events: 'click', update: '1' }] }] })).toBeNull();
  });

  it('strips usermeta.embedOptions but keeps other usermeta', () => {
    const spec = { mark: 'bar', usermeta: { embedOptions: { ast: false, actions: true }, note: 1 } };
    expect(stripEmbedOptions(spec)).toEqual({ mark: 'bar', usermeta: { note: 1 } });
    expect(spec.usermeta.embedOptions).toBeDefined(); // input untouched
    const html = buildFrameDocument({ kind: 'vega', nonce: 'n', libraries: [], fontCss: '' });
    expect(html).toContain('delete spec.usermeta.embedOptions');
    expect(html).toMatch(/actions:false,renderer:'svg',ast:true/);
  });
});

describe('VizSandbox guards (M1/M7)', () => {
  async function mountFrame() {
    const { default: VizSandbox } = await import('./VizSandbox');
    const onError = vi.fn();
    render(<VizSandbox kind="vega-lite" spec={{ mark: 'bar' }} onError={onError} />);
    const frame = (await screen.findByTitle(/vega-lite/)) as HTMLIFrameElement;
    await act(async () => {});
    return { frame, onError };
  }

  // jsdom may also fire the frame's natural first `load`; two more loads are a
  // navigation either way. The real-browser checks cover the no-false-positive side.
  it('drops the frame and reports when it loads another document (self-navigation)', async () => {
    const { frame, onError } = await mountFrame();
    act(() => { fireEvent.load(frame); });
    act(() => { fireEvent.load(frame); });
    expect(onError).toHaveBeenCalledWith('navigated');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('keeps the post-load ready window shorter than the overall cap', () => {
    expect(READY_AFTER_LOAD_MS).toBeLessThan(READY_TIMEOUT_MS);
    expect(READY_TIMEOUT_MS).toBeGreaterThanOrEqual(10000);
  });
});

describe('RichCodeBlock lifecycle (M3/M7)', () => {
  it('binds D3 consent to the exact source', async () => {
    const { default: RichCodeBlock } = await import('./RichCodeBlock');
    const { rerender } = render(<RichCodeBlock lang="d3" source="a();" />);
    fireEvent.click(screen.getByRole('button', { name: /Run D3/ }));
    await screen.findByTitle(/d3/);
    rerender(<RichCodeBlock lang="d3" source="b();" />);
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('button', { name: /Run D3/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Run D3/ }).title).toMatch(/code written in this message/);
  });

  it('builds a fresh frame when the spec changes and clears errors bound to the old source', async () => {
    const { default: RichCodeBlock } = await import('./RichCodeBlock');
    const { rerender } = render(<RichCodeBlock lang="vega-lite" source='{"mark":"bar"}' />);
    const first = await screen.findByTitle(/vega-lite/);
    rerender(<RichCodeBlock lang="vega-lite" source='{"mark":"line"}' />);
    const second = await screen.findByTitle(/vega-lite/);
    expect(second).not.toBe(first);
    expect(second.getAttribute('srcdoc')).not.toBe(first.getAttribute('srcdoc')); // new nonce
  });

  it('shows the budget error for a runaway spec without a frame', async () => {
    const { default: RichCodeBlock } = await import('./RichCodeBlock');
    render(<RichCodeBlock lang="vega" source='{"data":[{"name":"d","transform":[{"type":"sequence","start":0,"stop":1000000000}]}]}' />);
    expect(screen.getByText(/sequence too large/)).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('offers Retry after a timeout and rebuilds the frame', async () => {
    const { default: RichCodeBlock } = await import('./RichCodeBlock');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<RichCodeBlock lang="vega-lite" source='{"mark":"bar"}' />);
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(document.querySelector('iframe')).not.toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 1); });
      const retry = screen.getByRole('button', { name: /Retry/ });
      expect(document.querySelector('iframe')).toBeNull();
      fireEvent.click(retry);
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(document.querySelector('iframe')).not.toBeNull();
      expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
