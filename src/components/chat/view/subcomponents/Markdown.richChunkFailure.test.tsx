/**
 * T-2040 M5 — a failed RichCodeBlock chunk load must degrade to plain source,
 * never reject into MainContent's error boundary.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/Markdown.richChunkFailure.test.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import { Markdown } from './Markdown';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key }),
}));

vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: null }),
}));

// Simulates an offline / stale-deployment chunk: the dynamic import rejects.
vi.mock('./rich-blocks/RichCodeBlock', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

afterEach(cleanup);

describe('rich block chunk failure', () => {
  it('renders the fence source instead of throwing', async () => {
    render(<Markdown>{'before\n\n```mermaid\ngraph TD; A-->B\n```\n\nafter'}</Markdown>);
    expect(await screen.findByText('graph TD; A-->B')).toBeTruthy();
    expect(screen.getByText('after')).toBeTruthy();
  });
});
