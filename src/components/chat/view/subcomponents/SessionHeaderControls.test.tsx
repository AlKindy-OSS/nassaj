import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import SessionHeaderControls from './SessionHeaderControls';

afterEach(cleanup);

/** Every text node directly inside the header, ignoring whitespace-only nodes. */
const strayText = (root: Element) => [...root.childNodes]
  .filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
  .map((node) => node.textContent);

describe('SessionHeaderControls', () => {
  it('renders exactly the header controls — no wrapper, no stray text', () => {
    const { container } = render(<SessionHeaderControls><span>bar</span></SessionHeaderControls>);
    expect(container.innerHTML).toBe('<span>bar</span>');
    expect(strayText(container)).toEqual([]);
  });

  it('no longer hosts the team chat: it moved into the composer toolbar', () => {
    const { container } = render(<SessionHeaderControls><span>bar</span></SessionHeaderControls>);
    expect(container.querySelector('button')).toBeNull();
    const source = readFileSync(path.join(__dirname, 'SessionHeaderControls.tsx'), 'utf8');
    expect(source).not.toMatch(/import .*internal-session-chat/);
  });

  it('ChatInterface portals the header as one element (no JSX sibling such as a stray ",")', () => {
    const source = readFileSync(path.join(__dirname, '..', 'ChatInterface.tsx'), 'utf8');
    const portal = source.slice(source.indexOf('createPortal('), source.indexOf('sessionHeaderTarget,\n', source.indexOf('createPortal(')));
    expect(portal).toMatch(/^createPortal\(\s*<SessionHeaderControls/);
    expect(portal.trimEnd()).toMatch(/<\/SessionHeaderControls>,$/);
    expect(portal).not.toMatch(/\/>,\s*</);
  });
});
