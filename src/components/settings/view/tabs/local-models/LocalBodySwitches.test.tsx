/**
 * LocalBodySwitches.test.tsx — T-2107 stage 5 acceptance, in the owner's terms:
 * "as admin, in the existing Local Models settings card, I can turn local models
 * on per agent (Claude, Codex), each off by default, with the existing warning and
 * consent"; T-2108: "I see a DeepSeek Harness switch next to them, off by default,
 * same consent".
 *
 * Run: npx vitest run src/components/settings/view/tabs/local-models/LocalBodySwitches.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { useLocalModels } from '../../../hooks/useLocalModels';

import LocalBodySwitches from './LocalBodySwitches';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => (opts?.agent ? `${key}:${opts.agent}` : key),
  }),
}));

const confirmMock = vi.fn();
vi.mock('../../../../../shared/dialogs/dialogService', () => ({
  confirmDialog: (options: unknown) => confirmMock(options),
}));

type Controller = ReturnType<typeof useLocalModels>;
type Feature = NonNullable<Controller['overview']>['feature'];
function control(feature: Partial<Feature>) {
  return {
    busy: false,
    setBodyEnabled: vi.fn().mockResolvedValue(true),
    overview: {
      servers: [], total: 0, limit: 50, offset: 0,
      feature: {
        enabled: true, consentVersion: '1', requiredConsentVersion: '1', canManage: true,
        bodies: { claude: false, codex: false, dsh: false }, ...feature,
      },
    },
  } as unknown as Controller;
}
const toggle = (agent: string) => screen.getByRole('switch', { name: `localModels.bodyOn:${agent}` });

afterEach(() => {
  confirmMock.mockReset();
  cleanup();
});

describe('per-agent local switches', () => {
  it('shows Claude Code and Codex, each off by default', () => {
    render(<LocalBodySwitches control={control({})} />);
    expect(toggle('Claude Code').getAttribute('aria-checked')).toBe('false');
    expect(toggle('Codex').getAttribute('aria-checked')).toBe('false');
  });

  it('shows DeepSeek Harness next to them, off by default (T-2108)', () => {
    render(<LocalBodySwitches control={control({})} />);
    const names = screen.getAllByRole('switch').map((node) => node.getAttribute('aria-label'));
    expect(names).toEqual(['localModels.bodyOn:Claude Code', 'localModels.bodyOn:Codex',
      'localModels.bodyOn:DeepSeek Harness']);
    expect(toggle('DeepSeek Harness').getAttribute('aria-checked')).toBe('false');
  });

  it('turning DeepSeek Harness on asks the same consent, then saves only dsh', async () => {
    confirmMock.mockResolvedValue(true);
    const c = control({});
    render(<LocalBodySwitches control={c} />);
    fireEvent.click(toggle('DeepSeek Harness'));
    await waitFor(() => expect(c.setBodyEnabled).toHaveBeenCalledWith('dsh', true));
    expect(c.setBodyEnabled).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0].message).toBe('localModels.disclosure\n\nlocalModels.consent');
  });

  it('reads an agent the server does not report yet as off', () => {
    render(<LocalBodySwitches control={control({ bodies: { claude: true, codex: false } as Feature['bodies'] })} />);
    expect(toggle('DeepSeek Harness').getAttribute('aria-checked')).toBe('false');
  });

  it('cannot turn an agent on before the feature itself is enabled', () => {
    render(<LocalBodySwitches control={control({ enabled: false })} />);
    expect((toggle('Codex') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('localModels.bodiesNeedActivation')).toBeTruthy();
  });

  it('turning Codex on repeats the disclosure and consent, then saves only Codex', async () => {
    confirmMock.mockResolvedValue(true);
    const c = control({});
    render(<LocalBodySwitches control={c} />);
    fireEvent.click(toggle('Codex'));
    await waitFor(() => expect(c.setBodyEnabled).toHaveBeenCalledWith('codex', true));
    expect(confirmMock.mock.calls[0][0].message).toContain('localModels.disclosure');
    expect(confirmMock.mock.calls[0][0].message).toContain('localModels.consent');
  });

  it('a declined consent saves nothing', async () => {
    confirmMock.mockResolvedValue(false);
    const c = control({});
    render(<LocalBodySwitches control={c} />);
    fireEvent.click(toggle('Claude Code'));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(c.setBodyEnabled).not.toHaveBeenCalled();
  });

  it('turning an agent off asks nothing', async () => {
    const c = control({ bodies: { claude: true, codex: false, dsh: false } });
    render(<LocalBodySwitches control={c} />);
    fireEvent.click(toggle('Claude Code'));
    await waitFor(() => expect(c.setBodyEnabled).toHaveBeenCalledWith('claude', false));
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('a member sees each agent state and no switch', () => {
    render(<LocalBodySwitches control={control({ canManage: false, bodies: { claude: true, codex: false, dsh: false } })} />);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('localModels.bodyIsOn')).toBeTruthy();
    expect(screen.getAllByText('localModels.bodyIsOff')).toHaveLength(2);
  });
});
