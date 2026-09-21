const XTERM_STYLE_ELEMENT_ID = 'shell-xterm-focus-style';

type ArabicCapableTerminal = {
  registerCharacterJoiner: (handler: (text: string) => [number, number][]) => number;
  deregisterCharacterJoiner: (joinerId: number) => void;
  onRender?: (handler: (event: { start: number; end: number }) => void) => { dispose: () => void };
  element?: HTMLElement | undefined;
  cols?: number;
  textarea?: HTMLTextAreaElement | undefined;
};

const ARABIC_JOINED_CELL_CLASS = 'xterm-arabic-joined-cell';

/** Arabic, Arabic Supplement/Extended and presentation-form blocks. */
function isArabicCodeUnit(code: number): boolean {
  return (
    (code >= 0x0600 && code <= 0x06ff)
    || (code >= 0x0750 && code <= 0x077f)
    || (code >= 0x0870 && code <= 0x089f)
    || (code >= 0x08a0 && code <= 0x08ff)
    || (code >= 0xfb50 && code <= 0xfdff)
    || (code >= 0xfe70 && code <= 0xfeff)
  );
}

/** Neutral characters that may occur inside one Arabic bidi/shaping run. */
function isArabicRunSeparator(code: number): boolean {
  return (
    code === 0x20
    || code === 0x09
    || code === 0x200c
    || code === 0x200d
    || (code >= 0x21 && code <= 0x2f)
    || (code >= 0x30 && code <= 0x39)
    || (code >= 0x3a && code <= 0x40)
    || (code >= 0x5b && code <= 0x60)
    || (code >= 0x7b && code <= 0x7e)
  );
}

/**
 * Returns the smallest Arabic-containing runs that xterm's DOM renderer must
 * render as one unit. Rendering Arabic cell-by-cell prevents contextual
 * shaping; joining a whole run lets the browser connect letters and apply bidi
 * ordering without changing the PTY's LTR cell model.
 */
export function getArabicCharacterJoinRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let index = 0;

  while (index < text.length) {
    if (!isArabicCodeUnit(text.charCodeAt(index))) {
      index += 1;
      continue;
    }

    const start = index;
    let lastArabicEnd = index + 1;
    index += 1;

    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (isArabicCodeUnit(code)) {
        lastArabicEnd = index + 1;
        index += 1;
        continue;
      }
      if (isArabicRunSeparator(code)) {
        index += 1;
        continue;
      }
      break;
    }

    ranges.push([start, lastArabicEnd]);
    // Separators after the last Arabic character belong to neither run.
    index = Math.max(index, lastArabicEnd);
  }

  return ranges;
}

/**
 * Counts the xterm cells occupied by an Arabic join range. Combining marks and
 * join controls belong to their preceding cell; every other character admitted
 * by the joiner is one terminal cell wide.
 */
export function getArabicRunCellCount(text: string): number {
  return Array.from(text).reduce((count, character) => {
    if (/\p{Mark}/u.test(character) || character === '\u200c' || character === '\u200d') {
      return count;
    }
    return count + 1;
  }, 0);
}

/**
 * xterm's DOM renderer compensates a joined string with `letter-spacing` as if
 * it were one programming ligature. With proportional Arabic that correction
 * is repeated between every letter, which creates the large gaps seen in long
 * Arabic output. Reserve the original terminal cells with an explicit width,
 * then let the browser shape and reorder the isolated RTL run normally.
 */
export function stabilizeArabicJoinedCell(element: HTMLElement, cellWidth: number): void {
  const text = element.textContent ?? '';
  if (![...text].some((character) => isArabicCodeUnit(character.codePointAt(0) ?? 0))) {
    return;
  }

  const cellCount = getArabicRunCellCount(text);
  if (cellCount === 0 || !Number.isFinite(cellWidth) || cellWidth <= 0) {
    return;
  }

  element.classList.add(ARABIC_JOINED_CELL_CLASS);
  element.dir = 'rtl';
  // A width on an inline span has no layout effect. xterm emits spans inline,
  // so make only the Arabic joined span an inline block to retain its cells.
  element.style.display = 'inline-block';
  element.style.width = `${cellCount * cellWidth}px`;
  element.style.letterSpacing = 'normal';
  element.style.textAlign = 'start';
  element.style.unicodeBidi = 'isolate';
}

function stabilizeRenderedArabic(
  terminal: ArabicCapableTerminal,
  renderedRows?: { start: number; end: number },
): void {
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
  const cols = terminal.cols ?? 0;
  if (!screen || cols <= 0) {
    return;
  }

  const inlineWidth = Number.parseFloat(screen.style.width);
  const screenWidth = Number.isFinite(inlineWidth) && inlineWidth > 0
    ? inlineWidth
    : screen.getBoundingClientRect().width;
  if (screenWidth <= 0) {
    return;
  }

  const cellWidth = screenWidth / cols;
  const rows = screen.querySelector<HTMLElement>('.xterm-rows')?.children;
  if (!rows) {
    return;
  }

  const start = Math.max(0, renderedRows?.start ?? 0);
  const end = Math.min(rows.length - 1, renderedRows?.end ?? rows.length - 1);
  for (let index = start; index <= end; index += 1) {
    const row = rows.item(index);
    if (!row) {
      continue;
    }
    for (const element of Array.from(row.children)) {
      if (element instanceof HTMLElement) {
        stabilizeArabicJoinedCell(element, cellWidth);
      }
    }
  }
}

/** Enables Arabic shaping and IME metadata on an already-open xterm. */
export function enableXtermArabic(terminal: ArabicCapableTerminal): () => void {
  const joinerId = terminal.registerCharacterJoiner(getArabicCharacterJoinRanges);
  const renderSubscription = terminal.onRender?.((event) => stabilizeRenderedArabic(terminal, event));
  stabilizeRenderedArabic(terminal);
  if (terminal.textarea) {
    terminal.textarea.lang = 'ar';
    terminal.textarea.setAttribute('autocapitalize', 'off');
    terminal.textarea.setAttribute('autocomplete', 'off');
    terminal.textarea.spellcheck = false;
  }
  return () => {
    renderSubscription?.dispose();
    terminal.deregisterCharacterJoiner(joinerId);
  };
}

const XTERM_FOCUS_STYLES = `
  .xterm .xterm-helper-textarea {
    transition: none !important;
    color: transparent !important;
    -webkit-text-fill-color: transparent !important;
    caret-color: transparent !important;
  }
  .xterm .xterm-screen {
    outline: none !important;
  }
  .xterm:focus .xterm-screen {
    outline: none !important;
  }
  .xterm-screen:focus {
    outline: none !important;
  }
`;

export function ensureXtermFocusStyles(): void {
  if (typeof document === 'undefined') {
    return;
  }

  if (document.getElementById(XTERM_STYLE_ELEMENT_ID)) {
    return;
  }

  const styleSheet = document.createElement('style');
  styleSheet.id = XTERM_STYLE_ELEMENT_ID;
  styleSheet.type = 'text/css';
  styleSheet.innerText = XTERM_FOCUS_STYLES;
  document.head.appendChild(styleSheet);
}
