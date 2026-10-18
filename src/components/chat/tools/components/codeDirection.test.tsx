/**
 * B-1665: code inside RTL chat rows must stay LTR-isolated and wrap only at
 * the box edge. `break-all` split "sudo"/"hook" mid-word, and wrapped Bash
 * lines inherited the RTL row and aligned right.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import postcss from 'postcss';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OneLineDisplay } from './OneLineDisplay';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(cleanup);

const chatCodeRules = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(resolve(here, '../../../../index.css'), 'utf8');
  const decls: Record<string, string> = {};
  postcss.parse(css).walkRules((rule) => {
    if (rule.selectors.includes('.chat-message pre') || rule.selectors.includes('.chat-message code')) {
      rule.walkDecls((decl) => { decls[decl.prop] = decl.value; });
    }
  });
  return decls;
})();

describe('code direction and wrapping (B-1665)', () => {
  it('the terminal-style Bash line is LTR on its block and code, without break-all', () => {
    render(
      <div dir="rtl">
        <OneLineDisplay toolName="Bash" value="sudo systemctl status hook" style="terminal" wrapText />
      </div>,
    );
    const code = screen.getByText('sudo systemctl status hook').closest('code') as HTMLElement;
    expect(code.getAttribute('dir')).toBe('ltr');
    expect(code.parentElement?.getAttribute('dir')).toBe('ltr');
    expect(code.className).not.toContain('break-all');
    expect(code.className).toContain('[overflow-wrap:anywhere]');
  });

  it('the one-line path value is LTR and does not break at any letter', () => {
    render(<OneLineDisplay toolName="Read" value="/home/operator/ملف.ts" wrapText />);
    const value = screen.getByText('/home/operator/ملف.ts');
    expect(value.getAttribute('dir')).toBe('ltr');
    expect(value.className).not.toContain('break-all');
  });

  it('the global .chat-message pre/code rule wraps at the edge and forces no direction', () => {
    expect(chatCodeRules['word-break']).toBe('normal');
    expect(chatCodeRules['overflow-wrap']).toBe('anywhere');
    // A CSS `direction` here would override dir="rtl" on deliberate RTL <pre> (skill bodies).
    expect(chatCodeRules.direction).toBeUndefined();
    expect(chatCodeRules['text-align']).toBeUndefined();
  });
});
