/**
 * T-2046 (Q4): highlight budget boundary and the plain renderer's frame.
 *
 * Run: NODE_ENV=test npx vitest run src/syntax/highlightBudget.test.tsx
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import { exceedsHighlightBudget, MAX_HIGHLIGHT_CHARS } from './highlightBudget';
import { PlainCodeBlock } from './PlainCodeBlock';

afterEach(cleanup);

describe('exceedsHighlightBudget', () => {
  it('is false up to and at the budget', () => {
    expect(exceedsHighlightBudget('')).toBe(false);
    expect(exceedsHighlightBudget('a'.repeat(MAX_HIGHLIGHT_CHARS))).toBe(false);
  });

  it('is true one character over, including a single minified line', () => {
    expect(exceedsHighlightBudget('a'.repeat(MAX_HIGHLIGHT_CHARS + 1))).toBe(true);
  });

  it('counts characters, not lines', () => {
    expect(exceedsHighlightBudget('\n'.repeat(5000))).toBe(false);
  });
});

describe('PlainCodeBlock', () => {
  it('renders children verbatim with custom pre and code styles over the theme', () => {
    const { container } = render(
      <PlainCodeBlock
        language="js"
        customStyle={{ margin: 0, padding: '1rem' }}
        codeTagProps={{ style: { fontFamily: 'monospace' } }}
      >
        {'<script>alert(1)</script>'}
      </PlainCodeBlock>,
    );
    const pre = container.querySelector('pre') as HTMLElement;
    const code = pre.querySelector('code') as HTMLElement;
    expect(code.textContent).toBe('<script>alert(1)</script>');
    expect(container.querySelector('script')).toBeNull();
    expect(pre.style.padding).toBe('1rem');
    expect(code.style.fontFamily).toBe('monospace');
    expect(pre.style.background || pre.style.backgroundColor).not.toBe('');
  });
});
