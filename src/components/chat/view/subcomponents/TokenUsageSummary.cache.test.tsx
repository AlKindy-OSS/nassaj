import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => `${key}${options?.percent ?? options?.source ?? ''}`, i18n: { language: 'en' } }) }));
import { nativeSnapshot } from '../../hooks/contextUsagePresentation.fixtures';

import TokenUsageSummary from './TokenUsageSummary';
afterEach(cleanup);
const cache = { version: 1, provider: 'codex', sessionId: 's1', modelId: 'm1', source: 'codex.turn.completed', scope: 'turn', inputTokens: 1000, cacheReadTokens: 0, observedAt: null };
describe('cache section', () => {
 it('keeps occupancy identical at zero and full cache reuse and retains turn scope', () => {
   const props = { provider: 'codex', sessionId: 's1', modelId: 'm1' };
   const { rerender } = render(<TokenUsageSummary {...props} usage={{ contextSnapshot: nativeSnapshot({ usedTokens: 20_000 }), cacheSnapshot: cache }} />);
   const initial = screen.getByRole('progressbar').innerHTML;
   fireEvent.click(screen.getByRole('button'));
   expect(screen.getByTestId('cache-reuse').textContent).toContain('0%');
   expect(screen.getByRole('dialog').textContent).toContain('contextRot.cache.scope.turn');
   expect(screen.getByRole('dialog').textContent).toContain('contextRot.cache.sources.codex');
   expect(screen.getByRole('dialog').textContent).not.toContain('codex.turn.completed');
   expect(screen.getByRole('dialog').textContent).not.toContain('contextRot.cache.observed');
   rerender(<TokenUsageSummary {...props} usage={{ contextSnapshot: nativeSnapshot({ usedTokens: 20_000 }), cacheSnapshot: { ...cache, cacheReadTokens: 1000 } }} />);
   expect(screen.getByRole('progressbar').innerHTML).toBe(initial);
   expect(screen.getByTestId('cache-reuse').textContent).toContain('100%');
   fireEvent.keyDown(document, { key: 'Escape' });
   expect(screen.queryByRole('dialog')).toBeNull();
   expect(document.activeElement).toBe(screen.getByRole('button'));
 });
 it('shows cache with unknown context and clears incompatible model data', () => {
   const props = { provider: 'codex', sessionId: 's1', modelId: 'm1' };
   const { rerender } = render(<TokenUsageSummary {...props} usage={{ cacheSnapshot: { ...cache, cacheReadTokens: 600 } }} />);
   fireEvent.click(screen.getByRole('button'));
   expect(screen.queryByRole('progressbar')).toBeNull();
   expect(screen.getByTestId('cache-reuse').textContent).toContain('60%');
   rerender(<TokenUsageSummary {...props} modelId="m2" usage={{ cacheSnapshot: cache }} />);
   fireEvent.click(screen.getByRole('button'));
   expect(screen.getByTestId('cache-reuse').textContent).toBe('contextRot.cache.unknown');
 });
});
