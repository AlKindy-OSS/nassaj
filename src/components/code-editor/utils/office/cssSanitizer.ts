import { canonicalDataUrl } from './dataUrl';

// Untrusted CSS (docx-preview concatenates document strings such as style ids
// and font names into CSS without escaping) is re-tokenized following the
// CSS Syntax Level 3 rules, so escapes like `\75rl(` or `@\69mport` are seen
// exactly as a browser sees them. Every pass is linear: no regex backtracking.
// Output guarantees: no `@import`, no `url()`/`src()` other than allow-listed
// data: images/fonts or `#fragment` references, no image-set()/image()/
// cross-fade()/element(), and not a single `<` character (escaped as `\3c `),
// so the text can never close its `<style>` element.

/** Larger stylesheets are dropped (the document renders unstyled). */
export const MAX_CSS_CHARS = 2 * 1024 * 1024;
const MAX_FIXPOINT_PASSES = 3;
/** Larger inline style attributes are removed. */
export const MAX_STYLE_ATTRIBUTE_CHARS = 32 * 1024;

// Functions that can load resources are replaced wholesale. Matching is by
// substring of the decoded name, so look-alikes such as `<url(` or
// `x-image-set(` are neutralized too; no legitimate CSS function contains these.
const BLOCKED_FUNCTION_PARTS = ['url', 'image', 'src', 'element', 'cross-fade'];
const isBlockedFunction = (name: string): boolean => BLOCKED_FUNCTION_PARTS.some((part) => name.includes(part));
const FRAGMENT_URL = /^#[A-Za-z0-9_-]+$/;

const isWhitespace = (char: string | undefined): boolean => char === ' ' || char === '\t' || char === '\n';
const isHex = (char: string | undefined): boolean => {
  const code = char === undefined ? -1 : char.charCodeAt(0);
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
};
const isNameStart = (char: string | undefined): boolean => {
  if (char === undefined) return false;
  const code = char.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f || code >= 0x80;
};
const isNameChar = (char: string | undefined): boolean => {
  if (isNameStart(char)) return true;
  const code = char === undefined ? -1 : char.charCodeAt(0);
  return (code >= 0x30 && code <= 0x39) || code === 0x2d;
};

const hexEscape = (char: string): string => `\\${(char.codePointAt(0) ?? 0xfffd).toString(16)} `;

/** True for code points that may appear unescaped inside a serialized identifier. */
const isPlainNameChar = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
    || code === 0x2d || code === 0x5f || (code >= 0x80 && code !== 0xfffd);
};

/**
 * Serializes a DECODED identifier canonically (CSSOM "serialize an
 * identifier"): every other character becomes a hex escape. Emitting decoded
 * values rather than the raw source is what keeps `\\<url(` from becoming a
 * real `url(` once `<` is escaped.
 */
export function serializeIdentifier(value: string): string {
  let out = '';
  let index = 0;
  for (const char of value) {
    const isDigit = char >= '0' && char <= '9';
    const leadingDigit = isDigit && (index === 0 || (index === 1 && value.startsWith('-')));
    out += isPlainNameChar(char) && !leadingDigit ? char : hexEscape(char);
    index += char.length;
  }
  return out;
}

/** Serializes a DECODED string value as a double-quoted CSS string. */
export function serializeString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += char === '"' || char === '\\' || char === '<' || code < 0x20 || code === 0x7f ? hexEscape(char) : char;
  }
  return `${out}"`;
}

/** Safe replacement for a url() target, or null to neutralize it. */
function safeUrl(url: string): string | null {
  const value = url.trim();
  if (FRAGMENT_URL.test(value)) return value;
  return canonicalDataUrl(value, ['image', 'font']);
}

type Drop = { depth: number } | null;

class CssTokenizer {
  private index = 0;
  private depth = 0;
  private readonly out: string[] = [];
  private drop: Drop = null;
  private readonly css: string;
  /** Resource references seen (url/src/image-set/@import), `#fragment` urls excluded. */
  resources = 0;

  constructor(css: string) {
    // CSS input preprocessing: newlines normalized, NUL replaced.
    this.css = css.replace(/\r\n?|\f/g, '\n').replace(/\0/g, '�');
  }

  private peek(offset = 0): string | undefined {
    return this.css[this.index + offset];
  }

  private emit(text: string): void {
    if (!this.drop) this.out.push(text);
  }

  private validEscapeAt(offset: number): boolean {
    return this.peek(offset) === '\\' && this.peek(offset + 1) !== '\n';
  }

  private startsIdentAt(offset: number): boolean {
    const char = this.peek(offset);
    if (char === '-') {
      const next = this.peek(offset + 1);
      return isNameStart(next) || next === '-' || this.validEscapeAt(offset + 1);
    }
    return isNameStart(char) || this.validEscapeAt(offset);
  }

  /** Consumes an escape (the backslash already consumed); returns its value. */
  private consumeEscape(): string {
    const char = this.peek();
    if (char === undefined) return '�';
    if (!isHex(char)) {
      const codePoint = this.css.codePointAt(this.index) ?? 0xfffd;
      const text = String.fromCodePoint(codePoint);
      this.index += text.length;
      return text;
    }
    let hex = '';
    while (hex.length < 6 && isHex(this.peek())) hex += this.css[this.index++];
    if (isWhitespace(this.peek())) this.index += 1;
    const value = Number.parseInt(hex, 16);
    const invalid = value === 0 || (value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff;
    return invalid ? '�' : String.fromCodePoint(value);
  }

  /** Consumes an ident sequence; returns its decoded value. */
  private consumeName(): { value: string } {
    let value = '';
    for (;;) {
      const char = this.peek();
      if (isNameChar(char)) {
        value += char;
        this.index += 1;
      } else if (this.validEscapeAt(0)) {
        this.index += 1;
        value += this.consumeEscape();
      } else {
        break;
      }
    }
    return { value };
  }

  /** Consumes a string token (opening quote at index); returns its decoded value. */
  private consumeString(): { value: string } {
    const quote = this.css[this.index++];
    let value = '';
    for (;;) {
      const char = this.peek();
      if (char === undefined || char === quote) {
        if (char === quote) this.index += 1;
        break;
      }
      if (char === '\n') break; // bad-string: ends before the newline
      this.index += 1;
      if (char !== '\\') {
        value += char;
      } else if (this.peek() === '\n') {
        this.index += 1;
      } else if (this.peek() !== undefined) {
        value += this.consumeEscape();
      }
    }
    return { value };
  }

  private skipWhitespace(): void {
    while (isWhitespace(this.peek())) this.index += 1;
  }

  private skipComment(): void {
    const end = this.css.indexOf('*/', this.index + 2);
    this.index = end === -1 ? this.css.length : end + 2;
  }

  /** Skips to the `)` closing the function whose `(` was just consumed. */
  private skipBalanced(): void {
    let depth = 1;
    while (this.index < this.css.length) {
      const char = this.peek();
      if (char === '"' || char === "'") this.consumeString();
      else if (char === '/' && this.peek(1) === '*') this.skipComment();
      else if (char === '\\') this.index += 2;
      else {
        this.index += 1;
        if (char === '(') depth += 1;
        else if (char === ')' && (depth -= 1) === 0) return;
      }
    }
  }

  /** Consumes the remnants of a bad url up to and including `)`. */
  private skipBadUrl(): void {
    while (this.index < this.css.length) {
      const char = this.css[this.index++];
      if (char === ')') return;
      if (char === '\\' && this.peek() !== undefined && this.peek() !== '\n') this.consumeEscape();
    }
  }

  /** Consumes the argument of `url(`; returns its decoded value or null if malformed. */
  private consumeUrlArgument(): string | null {
    this.skipWhitespace();
    const first = this.peek();
    if (first === '"' || first === "'") {
      const { value } = this.consumeString();
      this.skipWhitespace();
      if (this.peek() === ')') {
        this.index += 1;
        return value;
      }
      this.skipBalanced();
      return null;
    }
    let value = '';
    for (;;) {
      const char = this.peek();
      if (char === undefined) return value;
      this.index += 1;
      if (char === ')') return value;
      if (isWhitespace(char)) {
        this.skipWhitespace();
        if (this.peek() === undefined) return value;
        if (this.peek() === ')') {
          this.index += 1;
          return value;
        }
        this.skipBadUrl();
        return null;
      }
      if (char === '"' || char === "'" || char === '(' || char.charCodeAt(0) < 0x20 || char === '\x7f') {
        this.skipBadUrl();
        return null;
      }
      if (char === '\\') {
        if (this.peek() === '\n') {
          this.skipBadUrl();
          return null;
        }
        value += this.consumeEscape();
      } else {
        value += char;
      }
    }
  }

  private handleIdentLike(): void {
    const { value } = this.consumeName();
    const name = value.toLowerCase();
    if (this.peek() !== '(') {
      this.emit(serializeIdentifier(value));
      return;
    }
    this.index += 1;
    if (name === 'url') {
      const target = this.consumeUrlArgument();
      const safe = target === null ? null : safeUrl(target);
      if (safe === null || !safe.startsWith('#')) this.resources += 1;
      this.emit(safe === null ? 'none' : `url("${safe}")`);
    } else if (isBlockedFunction(name)) {
      this.skipBalanced();
      this.resources += 1;
      this.emit('none');
    } else {
      this.emit(`${serializeIdentifier(value)}(`);
      this.depth += 1;
    }
  }

  private handleAtKeyword(): void {
    this.index += 1;
    const { value } = this.consumeName();
    // @import is the only at-rule that fetches by itself; drop the statement
    // (look-alike names such as `@<import` too).
    if (value.toLowerCase().includes('import') && !this.drop) {
      this.drop = { depth: this.depth };
      this.resources += 1;
    } else this.emit(`@${serializeIdentifier(value)}`);
  }

  /** Tracks nesting and ends a dropped @import statement at its `;` or block. */
  private handleDelimiter(char: string): void {
    this.index += 1;
    const opening = char === '(' || char === '[' || char === '{';
    const closing = char === ')' || char === ']' || char === '}';
    if (this.drop && this.depth === this.drop.depth && (char === ';' || closing)) {
      this.drop = null;
      if (char === ';') return;
    }
    if (opening) this.depth += 1;
    if (closing) this.depth = Math.max(0, this.depth - 1);
    this.emit(char);
    if (this.drop && char === '}' && this.depth === this.drop.depth) this.drop = null;
  }

  run(): string {
    while (this.index < this.css.length) {
      const char = this.css[this.index];
      if (char === '/' && this.peek(1) === '*') {
        this.skipComment();
        this.emit('/**/'); // an empty comment keeps tokens apart, as the original did
      } else if (char === '"' || char === "'") {
        this.emit(serializeString(this.consumeString().value));
      } else if (char === '@' && this.startsIdentAt(1)) {
        this.handleAtKeyword();
      } else if (this.startsIdentAt(0)) {
        this.handleIdentLike();
      } else {
        this.handleDelimiter(char);
      }
    }
    // `\3c ` is the CSS escape for `<`: valid in strings and identifiers alike.
    return this.out.join('').replace(/</g, '\\3c ');
  }
}

/** One tokenizer pass; see the module comment for the guarantees. */
export function sanitizeCssText(css: string): string {
  // The serialization is canonical, so a second pass normally changes nothing;
  // re-running until stable makes that a checked property, not an assumption.
  let current = new CssTokenizer(css).run();
  for (let pass = 0; pass < MAX_FIXPOINT_PASSES; pass += 1) {
    const next = new CssTokenizer(current).run();
    if (next === current) return current;
    current = next;
  }
  return '';
}

type ConstructableSheet = { replaceSync(text: string): void; cssRules: ArrayLike<{ cssText: string }> };

/** Re-serializes CSS through the browser's CSSOM when constructable sheets exist. */
function reserialize(css: string): string | null {
  const Sheet = (globalThis as { CSSStyleSheet?: new () => ConstructableSheet }).CSSStyleSheet;
  if (typeof Sheet !== 'function') return null;
  try {
    const sheet = new Sheet();
    if (typeof sheet.replaceSync !== 'function') return null;
    sheet.replaceSync(css); // ignores @import by specification
    return Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
  } catch {
    return null;
  }
}

/**
 * Sanitizes a stylesheet: a tokenizer pass, then (in browsers) a CSSOM
 * round-trip that canonicalizes escapes, then a second tokenizer pass over
 * the browser's own serialization. Oversized CSS is dropped.
 */
export function sanitizeStylesheet(css: string): string {
  if (css.length > MAX_CSS_CHARS) return '';
  const first = sanitizeCssText(css);
  const canonical = reserialize(first);
  return canonical === null ? first : sanitizeCssText(canonical);
}

/** Sanitizes an inline `style` attribute value; null means remove it. */
export function sanitizeStyleAttribute(style: string): string | null {
  if (style.length > MAX_STYLE_ATTRIBUTE_CHARS) return null;
  const clean = sanitizeCssText(style).trim();
  return clean === '' ? null : clean;
}

/**
 * True when a value, read as CSS, references any resource (url(), src(),
 * image-set() …), even a safe one. Used to strip SVG presentation attributes
 * such as `fill="url(...)"` unless they point at an in-document `#fragment`.
 */
export function referencesExternalResource(value: string): boolean {
  // Every resource reference is a function or at-rule: both need a literal `(` or `@`.
  if (!value.includes('(') && !value.includes('@')) return false;
  const tokenizer = new CssTokenizer(value);
  tokenizer.run();
  return tokenizer.resources > 0;
}
