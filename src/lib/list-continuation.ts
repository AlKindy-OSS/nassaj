export type ListContinuationAction =
  | { kind: 'continue'; insertText: string }
  | { kind: 'exit'; deleteFrom: number; deleteTo: number };

const BULLET_LIST_PATTERN = /^([ \t]*)([-*])([ \t]+)(.*)$/;
const NUMBERED_LIST_PATTERN = /^([ \t]*)([0-9]+|[٠-٩]+)([.)])([ \t]+)(.*)$/;

/**
 * Computes the smallest native-editing action needed when Enter is pressed in
 * a Markdown list item. The returned action deliberately contains no rewritten
 * full value so callers can preserve the textarea's browser undo history.
 */
export function computeListContinuation(
  fullText: string,
  cursorPos: number,
  selectionEnd: number,
): ListContinuationAction | null {
  if (cursorPos !== selectionEnd) {
    return null;
  }

  const previousNewline = fullText.lastIndexOf('\n', cursorPos - 1);
  const lineStart = previousNewline === -1 ? 0 : previousNewline + 1;
  const nextNewline = fullText.indexOf('\n', cursorPos);
  const lineEnd = nextNewline === -1 ? fullText.length : nextNewline;
  const line = fullText.slice(lineStart, lineEnd);

  const bulletMatch = BULLET_LIST_PATTERN.exec(line);
  if (bulletMatch) {
    const [, indent, marker, spaces, content] = bulletMatch;
    if (!content.trim()) {
      return { kind: 'exit', deleteFrom: lineStart, deleteTo: lineEnd };
    }
    return { kind: 'continue', insertText: `\n${indent}${marker}${spaces}` };
  }

  const numberedMatch = NUMBERED_LIST_PATTERN.exec(line);
  if (!numberedMatch) {
    return null;
  }

  const [, indent, digits, suffix, spaces, content] = numberedMatch;
  if (!content.trim()) {
    return { kind: 'exit', deleteFrom: lineStart, deleteTo: lineEnd };
  }

  const usesArabicIndicDigits = /^[٠-٩]+$/.test(digits);
  const latinDigits = usesArabicIndicDigits
    ? Array.from(digits, (digit) => String(digit.charCodeAt(0) - 0x0660)).join('')
    : digits;
  const nextLatinDigits = String(Number(latinDigits) + 1);
  const nextDigits = usesArabicIndicDigits
    ? Array.from(nextLatinDigits, (digit) => String.fromCharCode(Number(digit) + 0x0660)).join('')
    : nextLatinDigits;

  return { kind: 'continue', insertText: `\n${indent}${nextDigits}${suffix}${spaces}` };
}
