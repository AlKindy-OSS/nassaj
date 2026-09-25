/**
 * T-1853: a session row that still names a retired provider renders a neutral
 * grey tile — never Claude's mark, which would misattribute the run.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RETIRED_PROVIDER_IDS } from '../../../shared/retiredProviders';

import SessionProviderLogo from './SessionProviderLogo';

afterEach(cleanup);

const tileFill = (container: HTMLElement): string | null =>
  container.querySelector('svg > rect')?.getAttribute('fill') ?? null;

describe('SessionProviderLogo — retired providers', () => {
  for (const retired of RETIRED_PROVIDER_IDS) {
    it(`${retired} renders the neutral retired tile, not the Claude mark`, () => {
      const { container: retiredView } = render(<SessionProviderLogo provider={retired} />);
      const retiredMarkup = retiredView.innerHTML;
      expect(tileFill(retiredView)).toBe('#6B7280');
      expect(retiredView.textContent).toBe('?');
      cleanup();

      const { container: claudeView } = render(<SessionProviderLogo provider="claude" />);
      expect(claudeView.innerHTML).not.toBe(retiredMarkup);
    });
  }
});
