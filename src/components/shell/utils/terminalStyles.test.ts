import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  enableXtermArabic,
  getArabicCharacterJoinRanges,
  getArabicRunCellCount,
  stabilizeArabicJoinedCell,
} from './terminalStyles';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Arabic xterm support', () => {
  it('joins an Arabic sentence with neutral spaces and punctuation as one shaping run', () => {
    expect(getArabicCharacterJoinRanges('printf: مرحباً بكم 123! done')).toEqual([[8, 18]]);
  });

  it('keeps Latin command syntax outside the Arabic shaping range', () => {
    expect(getArabicCharacterJoinRanges('echo مرحبا && pwd')).toEqual([[5, 10]]);
  });

  it('finds separate Arabic runs around Latin text', () => {
    expect(getArabicCharacterJoinRanges('أهلاً npm test ثم انتهى')).toEqual([
      [0, 5],
      [15, 23],
    ]);
  });

  it('does not count Arabic combining marks and join controls as terminal cells', () => {
    expect(getArabicRunCellCount('مرحباً')).toBe(5);
    expect(getArabicRunCellCount('لا\u200dحقاً')).toBe(5);
  });

  it('reserves the original cells while removing xterm letter-spacing from an RTL run', () => {
    const element = document.createElement('span');
    element.textContent = 'مرحباً 123 بكم';
    element.style.letterSpacing = '38px';

    stabilizeArabicJoinedCell(element, 8);

    expect(element.classList.contains('xterm-arabic-joined-cell')).toBe(true);
    expect(element.dir).toBe('rtl');
    expect(element.style.display).toBe('inline-block');
    expect(element.style.width).toBe('104px');
    expect(element.style.letterSpacing).toBe('normal');
    expect(element.style.textAlign).toBe('start');
    expect(element.style.unicodeBidi).toBe('isolate');
  });

  it('leaves Latin and ANSI-oriented terminal spans unchanged', () => {
    const element = document.createElement('span');
    element.textContent = 'npm test -- --runInBand';
    element.style.letterSpacing = '0.25px';

    stabilizeArabicJoinedCell(element, 8);

    expect(element.className).toBe('');
    expect(element.dir).toBe('');
    expect(element.style.display).toBe('');
    expect(element.style.width).toBe('');
    expect(element.style.letterSpacing).toBe('0.25px');
  });

  it('registers and cleanly deregisters the joiner while preparing the IME textarea', () => {
    const registerCharacterJoiner = vi.fn(() => 17);
    const deregisterCharacterJoiner = vi.fn();
    const textarea = document.createElement('textarea');

    const dispose = enableXtermArabic({ registerCharacterJoiner, deregisterCharacterJoiner, textarea });

    expect(registerCharacterJoiner).toHaveBeenCalledWith(getArabicCharacterJoinRanges);
    expect(textarea.lang).toBe('ar');
    expect(textarea.spellcheck).toBe(false);
    expect(textarea.getAttribute('autocapitalize')).toBe('off');

    dispose();
    expect(deregisterCharacterJoiner).toHaveBeenCalledWith(17);
  });

  it('stabilizes ANSI-split Arabic spans, follows resize, and only scans rendered rows', () => {
    const terminalElement = document.createElement('div');
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    screen.style.width = '800px';
    const rows = document.createElement('div');
    rows.className = 'xterm-rows';
    const row = document.createElement('div');
    const arabicWarning = document.createElement('span');
    arabicWarning.className = 'xterm-fg-3';
    arabicWarning.textContent = 'تحذير';
    arabicWarning.style.letterSpacing = '12px';
    const arabicBody = document.createElement('span');
    arabicBody.textContent = 'أهلاً بكم';
    arabicBody.style.letterSpacing = '20px';
    const latin = document.createElement('span');
    latin.textContent = ' npm test';
    latin.style.letterSpacing = '0.2px';
    row.append(arabicWarning, arabicBody, latin);
    rows.appendChild(row);
    screen.appendChild(rows);
    terminalElement.appendChild(screen);
    const measureScreen = vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue({
      width: 800,
      height: 400,
      x: 0,
      y: 0,
      top: 0,
      right: 800,
      bottom: 400,
      left: 0,
      toJSON: () => ({}),
    });

    let renderHandler: ((event: { start: number; end: number }) => void) | undefined;
    const disposeRender = vi.fn();
    const deregisterCharacterJoiner = vi.fn();
    const terminal = {
      registerCharacterJoiner: () => 19,
      deregisterCharacterJoiner,
      element: terminalElement,
      cols: 80,
      onRender: (handler: (event: { start: number; end: number }) => void) => {
        renderHandler = handler;
        return { dispose: disposeRender };
      },
    };
    const dispose = enableXtermArabic(terminal);

    expect(measureScreen).not.toHaveBeenCalled();
    expect(arabicWarning.classList.contains('xterm-fg-3')).toBe(true);
    expect(arabicWarning.classList.contains('xterm-arabic-joined-cell')).toBe(true);
    expect(arabicWarning.style.width).toBe('50px');
    expect(arabicBody.dir).toBe('rtl');
    expect(arabicBody.style.width).toBe('80px');
    expect(arabicBody.style.letterSpacing).toBe('normal');
    expect(latin.dir).toBe('');
    expect(latin.style.width).toBe('');
    expect(latin.style.letterSpacing).toBe('0.2px');

    const untouchedRow = document.createElement('div');
    const notRenderedYet = document.createElement('span');
    notRenderedYet.textContent = 'صف غير مرسوم';
    notRenderedYet.style.letterSpacing = '15px';
    untouchedRow.appendChild(notRenderedYet);
    rows.appendChild(untouchedRow);

    terminal.cols = 100;
    screen.style.width = '600px';
    renderHandler?.({ start: 0, end: 0 });

    expect(arabicWarning.style.width).toBe('30px');
    expect(arabicBody.style.width).toBe('48px');
    expect(notRenderedYet.dir).toBe('');
    expect(notRenderedYet.style.width).toBe('');
    expect(notRenderedYet.style.letterSpacing).toBe('15px');
    expect(measureScreen).not.toHaveBeenCalled();

    dispose();
    expect(disposeRender).toHaveBeenCalledOnce();
    expect(deregisterCharacterJoiner).toHaveBeenCalledWith(19);
  });

  it('keeps a real xterm DOM cursor to one cell when it moves inside Arabic', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      fillRect: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
      measureText: (text: string) => ({ width: text.length * 8 }),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function width(this: HTMLElement) {
      return this.classList.contains('xterm-char-measure-element') ? 8 : 400;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function height(this: HTMLElement) {
      return this.classList.contains('xterm-char-measure-element') ? 16 : 100;
    });

    const container = document.createElement('div');
    container.style.width = '400px';
    container.style.height = '100px';
    document.body.appendChild(container);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
      const isMeasureElement = this.classList.contains('xterm-char-measure-element');
      const width = isMeasureElement ? 8 : 400;
      const height = isMeasureElement ? 16 : 100;
      return {
        width,
        height,
        x: 0,
        y: 0,
        top: 0,
        right: width,
        bottom: height,
        left: 0,
        toJSON: () => ({}),
      };
    });

    const { Terminal } = await import('@xterm/xterm');
    const terminal = new Terminal({ cols: 20, rows: 3, allowProposedApi: true });
    let disableArabic: (() => void) | undefined;
    try {
      terminal.open(container);
      terminal.focus();
      disableArabic = enableXtermArabic(terminal);
      await new Promise<void>((resolve) => terminal.write('مرحبا\u001b[3D', resolve));
      terminal.refresh(0, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const cursor = container.querySelector<HTMLElement>('.xterm-rows .xterm-cursor');
      const renderedScreen = container.querySelector<HTMLElement>('.xterm-screen');
      const renderedCellWidth = Number.parseFloat(renderedScreen?.style.width ?? '') / terminal.cols;
      expect(cursor, container.innerHTML).not.toBeNull();
      expect(cursor?.textContent).toBe('ح');
      expect(Number.parseFloat(cursor?.style.width ?? '')).toBeCloseTo(renderedCellWidth);
      expect(cursor?.textContent).not.toContain('مرحبا');
    } finally {
      disableArabic?.();
      terminal.dispose();
      container.remove();
    }
  });
});
