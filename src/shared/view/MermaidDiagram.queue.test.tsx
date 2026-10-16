/**
 * T-2040 — Mermaid render queue: serialized, skips unmounted diagrams, and
 * pins the keys a `%%{init}%%` directive may not change.
 *
 * Run: NODE_ENV=test npx vitest run src/shared/view/MermaidDiagram.queue.test.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

import MermaidDiagram from './MermaidDiagram';

const calls: string[] = [];
const initialize = vi.fn();
let release: (() => void) | null = null;

vi.mock('mermaid', () => ({
  default: {
    initialize: (cfg: unknown) => initialize(cfg),
    render: (_id: string, code: string) => {
      calls.push(code);
      return new Promise((resolve) => {
        release = () => resolve({ svg: `<svg data-code="${code}"></svg>` });
      });
    },
  },
}));

vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));

afterEach(cleanup);

const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

describe('MermaidDiagram queue', () => {
  it('renders one at a time, skips diagrams unmounted while queued, pins secure keys', async () => {
    const first = render(<MermaidDiagram code="A" />);
    const second = render(<MermaidDiagram code="B" />);
    render(<MermaidDiagram code="C" />);
    await flush();
    expect(calls).toEqual(['A']); // B and C wait for A

    second.unmount(); // B leaves the queue before its turn
    await act(async () => { release?.(); });
    await flush();
    expect(calls).toEqual(['A', 'C']);
    expect(first.container.querySelector('svg')?.getAttribute('data-code')).toBe('A');

    const cfg = initialize.mock.calls[0][0] as { secure: string[]; securityLevel: string; htmlLabels: boolean };
    expect(cfg.securityLevel).toBe('strict');
    expect(cfg.htmlLabels).toBe(false);
    expect(cfg.secure).toEqual(expect.arrayContaining(['securityLevel', 'htmlLabels', 'maxTextSize', 'maxEdges']));
  });
});
