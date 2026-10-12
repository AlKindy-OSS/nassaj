/**
 * LinkModeSection.test.tsx — ADR-200 S9, brief §5: the Claude and Codex account
 * pages show the CHOSEN link mode beside the EFFECTIVE one, one line per drift
 * warning, and a confirm that says how many members switch billing with the
 * account. Real Arabic copy through a real i18next instance.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom. `NODE_ENV=test` is required.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../../../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

import { SettingsNavigationProvider } from '../../../../SettingsNavigationContext';
import { ar, appError, installFetch, plain, renderAr, type Route } from '../../../vendors-settings/vendorUiTestKit';

import LinkModeSection from './LinkModeSection';

type StatusOverrides = Record<string, unknown>;

const status = (overrides: StatusOverrides = {}) => ({
  provider: 'claude',
  enabled: true,
  chosenMode: 'subscription',
  chosenModeSource: 'user',
  effectiveMode: 'subscription',
  linkState: 'linked',
  credentials: { key: 'none', subscription: true },
  warnings: [],
  granteeCount: 0,
  ...overrides,
});

const getRoute = (data: unknown): Route => (url, method) => (
  method === 'GET' && url.endsWith('/link-mode') ? { body: { success: true, data } } : undefined
);

const putRoute = (outcome = 'linked', after: unknown = status({ chosenMode: 'api_key' })): Route => (url, method) => (
  method === 'PUT' ? { body: { success: true, data: { outcome, status: after } } } : undefined
);

function mount(data: unknown, agent: 'claude' | 'codex' = 'claude', ...routes: Route[]) {
  const writes = installFetch(fetchMock, [...routes, getRoute(data)]);
  const ui: ReactElement = <LinkModeSection agent={agent} />;
  renderAr(ui);
  return writes;
}

const radio = (name: string) => screen.findByRole('radio', { name });
const text = () => plain(document.body.textContent);

beforeEach(() => { fetchMock.mockReset(); });
afterEach(cleanup);

describe('chosen mode beside effective mode', () => {
  it('renders nothing while the unified mode is off', async () => {
    mount({ provider: 'claude', enabled: false });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('marks the chosen segment and hides the effective line when they agree and nothing is wrong', async () => {
    mount(status());
    expect((await radio(ar('linkMode.mode.subscription'))).getAttribute('aria-checked')).toBe('true');
    expect(text()).not.toContain(ar('linkMode.effective'));
  });

  it('shows the effective mode and the mismatch sentence when they differ', async () => {
    mount(status({ effectiveMode: 'api_key', warnings: ['effective_mode_mismatch'] }));
    await radio(ar('linkMode.mode.subscription'));
    expect(text()).toContain(ar('linkMode.effective'));
    expect(text()).toContain(plain(ar('linkMode.warning.mismatch', {
      harness: 'Claude Code', chosen: ar('linkMode.mode.subscription'), effective: ar('linkMode.mode.api_key'),
    })));
  });

  it('shows the fresh-login and both-present warnings', async () => {
    mount(status({ effectiveMode: 'api_key', warnings: ['fresh_subscription_login', 'subscription_also_present'] }));
    await radio(ar('linkMode.mode.subscription'));
    expect(text()).toContain(ar('linkMode.warning.freshLogin'));
    expect(text()).toContain(ar('linkMode.warning.alsoPresent'));
  });

  it('says the record is unreadable and that runs are stopped', async () => {
    mount(status({ chosenMode: null, linkState: 'unlinked', warnings: ['record_unreadable'] }));
    await radio(ar('linkMode.mode.subscription'));
    expect(text()).toContain(ar('linkMode.warning.unreadable'));
  });

  it('with no mode chosen, selects nothing and asks which one', async () => {
    mount(status({ chosenMode: null, effectiveMode: 'none', warnings: ['mode_unset'], credentials: { key: 'none', subscription: false } }));
    const subscription = await radio(ar('linkMode.mode.subscription'));
    expect(subscription.getAttribute('aria-checked')).toBe('false');
    expect((await radio(ar('linkMode.mode.api_key'))).getAttribute('aria-checked')).toBe('false');
    expect(text()).toContain(plain(ar('linkMode.unset', { harness: 'Claude Code' })));
  });

  it('API-key mode without a key says «غير مربوط — لا مفتاح» with a link to the vendor card, and no fallback hint', async () => {
    const openVendors = vi.fn();
    installFetch(fetchMock, [getRoute(status({ chosenMode: 'api_key', effectiveMode: 'none', linkState: 'unlinked' }))]);
    renderAr(
      <SettingsNavigationProvider value={{ openAgentAccount: vi.fn(), openVendors }}>
        <LinkModeSection agent="claude" />
      </SettingsNavigationProvider>,
    );
    const badge = await screen.findByText(ar('linkMode.unlinked'));
    fireEvent.click(screen.getByRole('button', { name: ar('linkMode.addKey') }));
    expect(openVendors).toHaveBeenCalledWith('anthropic');
    // D6: the unlinked line never hints at a fallback to the subscription.
    expect(badge.closest('p')!.textContent).not.toMatch(/اشتراك|الاشتراك/);
  });
});

describe('foreign key billing', () => {
  const FOREIGN = (key: string) => status({
    effectiveMode: 'api_key',
    warnings: ['foreign_key_billing'],
    credentials: { key, subscription: true },
  });

  it('names a key nassaj did not write and offers the switch-and-delete action', async () => {
    mount(FOREIGN('foreign'));
    await radio(ar('linkMode.mode.subscription'));
    expect(text()).toContain(ar('linkMode.warning.foreignBilling'));
    expect(text()).toContain(ar('linkMode.warning.foreignKey'));
    expect(text()).not.toContain(ar('linkMode.warning.adoptedKey'));
  });

  it('names an adopted key instead when that is what is there', async () => {
    mount(FOREIGN('adopted'));
    await radio(ar('linkMode.mode.subscription'));
    expect(text()).toContain(ar('linkMode.warning.adoptedKey'));
    expect(text()).not.toContain(ar('linkMode.warning.foreignKey'));
  });

  it('the action confirms, then sends subscription + removeForeignKey + confirm', async () => {
    const writes = mount(FOREIGN('foreign'), 'claude', putRoute('foreign_key_removed', status()));
    fireEvent.click(await screen.findByRole('button', { name: ar('linkMode.warning.removeForeign') }));
    const dialog = await screen.findByRole('dialog');
    expect(writes).toHaveLength(0);
    expect(plain(dialog.textContent)).toContain(plain(ar('linkMode.confirm.toSubscriptionForeign', { harness: 'Claude Code' })));
    fireEvent.click(within(dialog).getByRole('button', { name: ar('linkMode.confirm.confirm') }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe('PUT');
    expect(writes[0].body).toEqual({ mode: 'subscription', removeForeignKey: true, confirm: true });
    await waitFor(() => expect(screen.getByText(ar('linkMode.outcome.removed'))).toBeTruthy());
  });
});

describe('switching to API key', () => {
  const grantees = (count: number) => ar('linkMode.confirm.grantees', { count });

  it.each([1, 2, 3, 11])('shows %i grantee(s) in the confirm', async (count) => {
    mount(status({ granteeCount: count }));
    fireEvent.click(await radio(ar('linkMode.mode.api_key')));
    const dialog = await screen.findByRole('dialog');
    expect(plain(dialog.textContent)).toContain(plain(ar('linkMode.confirm.toKey', { harness: 'Claude Code' })));
    expect(dialog.textContent).toContain(grantees(count));
  });

  it('shows no grantee line when nobody runs on the account', async () => {
    mount(status());
    fireEvent.click(await radio(ar('linkMode.mode.api_key')));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).not.toContain(grantees(0));
    expect(dialog.textContent).not.toMatch(/سيُحاسَب/);
  });

  it('sends confirm:true only after the dialog, and reports awaiting_key', async () => {
    const writes = mount(status({ granteeCount: 3 }), 'claude', putRoute('awaiting_key'));
    fireEvent.click(await radio(ar('linkMode.mode.api_key')));
    expect(writes).toHaveLength(0);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: ar('linkMode.confirm.confirm') }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ mode: 'api_key', confirm: true });
    await waitFor(() => expect(screen.getByText(ar('linkMode.outcome.awaitingKey'))).toBeTruthy());
  });

  it('cancel changes nothing', async () => {
    const writes = mount(status());
    fireEvent.click(await radio(ar('linkMode.mode.api_key')));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: ar('vendors.link.cancel') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes).toHaveLength(0);
  });

  it('offers removing the setup-token for Claude when the mode came from one, and sends it unticked-by-default', async () => {
    const writes = mount(status({ chosenModeSource: 'setup_token' }), 'claude', putRoute());
    fireEvent.click(await radio(ar('linkMode.mode.api_key')));
    const dialog = await screen.findByRole('dialog');
    const option = within(dialog).getByRole('checkbox') as HTMLInputElement;
    expect(option.checked).toBe(false);
    fireEvent.click(option);
    fireEvent.click(within(dialog).getByRole('button', { name: ar('linkMode.confirm.confirm') }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ mode: 'api_key', removeSetupToken: true, confirm: true });
  });

  it('does not offer the setup-token option for Codex', async () => {
    mount(status({ provider: 'codex', chosenModeSource: 'setup_token' }), 'codex');
    fireEvent.click(await radio(ar('linkMode.mode.api_key')));
    expect(within(await screen.findByRole('dialog')).queryByRole('checkbox')).toBeNull();
  });

  it('surfaces a refused switch', async () => {
    mount(status(), 'claude', (url, method) => (method === 'PUT' ? appError(409, 'LINK_MODE_DISABLED', 'Link modes are not enabled on this server.') : undefined));
    fireEvent.click(await radio(ar('linkMode.mode.api_key')));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: ar('linkMode.confirm.confirm') }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Link modes are not enabled'));
  });
});

describe('members running on this account', () => {
  it('counts them when there are some', async () => {
    mount(status({ granteeCount: 4 }));
    await radio(ar('linkMode.mode.subscription'));
    expect(text()).toContain(ar('linkMode.grantees', { count: 4 }));
  });
});
