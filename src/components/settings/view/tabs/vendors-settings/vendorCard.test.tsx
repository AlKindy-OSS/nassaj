/**
 * vendorCard.test.tsx — ADR-200 S9: the vendor card as the user meets it.
 *
 * One key per vendor, a «يغذّي:» badge per harness, a vendor-wide delete that
 * names its blast radius, a replace confirm for keys nassaj did not write, and
 * the D9 conflict chooser. Real Arabic copy through a real i18next instance.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom. `NODE_ENV=test` is required.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { vendorsByCompany } from '../../../../../../shared/vendors';
import settingsAr from '../../../../../i18n/locales/ar/settings.json';
import settingsEn from '../../../../../i18n/locales/en/settings.json';

const fetchMock = vi.fn();
vi.mock('../../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

import CompanyCredentialCard from './CompanyCredentialCard';
import { ar, appError, installFetch, plain, renderAr, type Recorded, type Route } from './vendorUiTestKit';

type SlotFixture = { vendorId: string; provider: string; target?: string; configured: boolean; subscription?: boolean };

const ANTHROPIC_SLOTS: SlotFixture[] = [
  { vendorId: 'anthropic', provider: 'claude', configured: true },
  { vendorId: 'anthropic-opencode', provider: 'opencode', target: 'anthropic', configured: true },
];

const company = (id: string) => vendorsByCompany().find((entry) => entry.id === id)!;

/** `GET /company/:id/key` answering `data`; every other request is the caller's route. */
function statusRoute(data: Record<string, unknown>): Route {
  return (url, method) => (method === 'GET' && /\/company\/[^/]+\/key$/.test(url)
    ? { body: { success: true, data: { writable: true, ...data } } }
    : undefined);
}

function mount(id: string, data: Record<string, unknown>, ...routes: Route[]): Recorded[] {
  const writes = installFetch(fetchMock, [...routes, statusRoute(data)]);
  renderAr(<CompanyCredentialCard company={company(id)} />);
  return writes;
}

const feedsText = () => plain(screen.getByTestId('vendor-feeds').textContent);
const field = (id: string) => document.getElementById(`company-api-key-${id}`) as HTMLInputElement;

beforeEach(() => { fetchMock.mockReset(); });
afterEach(cleanup);

describe('the card has no placement controls left', () => {
  it('renders no checkbox, no «يُكتب في» and no subscription notice for Anthropic', async () => {
    mount('anthropic', { slots: ANTHROPIC_SLOTS });
    await waitFor(() => expect(screen.getByTestId('vendor-feeds')).toBeTruthy());

    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('يُكتب في');
    expect(document.body.textContent).not.toContain('داخلٌ باشتراكه');
  });

  it('drops the removed keys from every locale bundle', () => {
    const removed = ['storedInLine', 'removeFrom', 'slots', 'kind', 'status'];
    for (const bundle of [settingsAr, settingsEn]) {
      for (const key of removed) expect((bundle.vendors as Record<string, unknown>)[key]).toBeUndefined();
      const companyKeys = bundle.vendors.company as Record<string, unknown>;
      for (const key of ['subscriptionNotice', 'subscriptionOverride', 'showSlots', 'hideSlots', 'detailToggle']) {
        expect(companyKeys[key]).toBeUndefined();
      }
    }
  });
});

describe('«يغذّي:» badge states', () => {
  const STATES: Array<[string, string]> = [
    ['linked', 'مرتبط'],
    ['stale', 'تغيّر خارج نسّاج'],
    ['failed', 'تعذّرت الكتابة'],
    ['tombstone', 'الإزالة معلّقة'],
    ['foreign_credential', 'مفتاح آخر موجود'],
    ['adopted', 'مفتاح متبنّى'],
    ['kept_on_subscription', 'باقٍ على الاشتراك'],
    ['mode_unset', 'لم يُختر نمط الربط'],
    ['login_present', 'داخل بتسجيل دخول'],
    ['shared_scope_refused', 'مشترك مع الفريق'],
  ];

  it.each(STATES)('renders %s as «%s» beside the harness name', async (state, label) => {
    mount('anthropic', {
      slots: ANTHROPIC_SLOTS,
      projections: [
        { vendorId: 'anthropic', provider: 'claude', state },
        { vendorId: 'anthropic-opencode', provider: 'opencode', target: 'anthropic', state: 'linked' },
      ],
    });
    await waitFor(() => expect(feedsText()).toContain(`Claude Code · ${label}`));
    expect(feedsText()).toContain('OpenCode · مرتبط');
    expect(feedsText().startsWith(ar('vendors.link.feeds'))).toBe(true);
  });

  it('shows «مرتبط» from `configured` alone when the server sends no projections (flag off)', async () => {
    mount('anthropic', {
      slots: [
        { vendorId: 'anthropic', provider: 'claude', configured: false },
        { vendorId: 'anthropic-opencode', provider: 'opencode', target: 'anthropic', configured: true },
      ],
    });
    await waitFor(() => expect(feedsText()).toContain('OpenCode · مرتبط'));
    expect(feedsText()).not.toContain('Claude Code');
  });

  it('takes the badge from the last Save result: kept_on_subscription', async () => {
    mount(
      'anthropic',
      { slots: [{ ...ANTHROPIC_SLOTS[0], configured: false }, { ...ANTHROPIC_SLOTS[1], configured: false }] },
      (url, method) => (method === 'POST' && url.endsWith('/company/anthropic/key')
        ? { body: { success: true, data: { slots: [
          { vendorId: 'anthropic', provider: 'claude', outcome: 'kept_on_subscription' },
          { vendorId: 'anthropic-opencode', provider: 'opencode', target: 'anthropic', outcome: 'linked' },
        ] } } }
        : undefined),
    );
    await waitFor(() => expect(field('anthropic')).not.toBeNull());
    fireEvent.change(field('anthropic'), { target: { value: 'sk-ant-api03-x' } });
    fireEvent.click(screen.getByLabelText('احفظ مفتاح Anthropic'));

    await waitFor(() => expect(feedsText()).toContain('Claude Code · باقٍ على الاشتراك'));
    expect(feedsText()).toContain('OpenCode · مرتبط');
  });

  it('shows the engine-pin badge on an AES-only vendor and not on OpenRouter', async () => {
    mount('moonshot', { slots: [{ vendorId: 'moonshot', provider: 'kimi', configured: true }] });
    await waitFor(() => expect(screen.getByTestId('vendor-feeds')).toBeTruthy());
    expect(feedsText()).toContain(ar('vendors.link.enginePin.badge'));
    cleanup();

    mount('openrouter', { slots: [{ vendorId: 'openrouter', provider: 'opencode', target: 'openrouter', configured: true }] });
    await waitFor(() => expect(screen.getByTestId('vendor-feeds')).toBeTruthy());
    expect(feedsText()).not.toContain(ar('vendors.link.enginePin.badge'));
  });

  it('keeps the engine-pin note under the row after a Save that links an AES-only slot', async () => {
    mount(
      'moonshot',
      { slots: [{ vendorId: 'moonshot', provider: 'kimi', configured: false }] },
      (url, method) => (method === 'POST'
        ? { body: { success: true, data: { slots: [{ vendorId: 'moonshot', provider: 'kimi', outcome: 'linked' }] } } }
        : undefined),
    );
    await waitFor(() => expect(field('moonshot')).not.toBeNull());
    fireEvent.change(field('moonshot'), { target: { value: 'sk-moon-1' } });
    fireEvent.click(screen.getByLabelText('احفظ مفتاح Moonshot'));
    await waitFor(() => expect(screen.getAllByText(ar('vendors.link.enginePin.tooltip')).length).toBe(1));
  });
});

describe('Save', () => {
  it('sends the key alone: no vendorIds, no per-place choice', async () => {
    const writes = mount('anthropic', { slots: ANTHROPIC_SLOTS });
    await waitFor(() => expect(field('anthropic')).not.toBeNull());
    fireEvent.change(field('anthropic'), { target: { value: 'sk-ant-api03-x' } });
    fireEvent.click(screen.getByLabelText('احفظ مفتاح Anthropic'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ apiKey: 'sk-ant-api03-x' });
  });

  it('explains a refused subscription token inline under the field', async () => {
    mount('anthropic', { slots: ANTHROPIC_SLOTS }, (url, method) => (method === 'POST'
      ? appError(400, 'SUBSCRIPTION_TOKEN_FORBIDDEN_TARGET')
      : undefined));
    await waitFor(() => expect(field('anthropic')).not.toBeNull());
    fireEvent.change(field('anthropic'), { target: { value: 'sk-ant-oat01-secret' } });
    fireEvent.click(screen.getByLabelText('احفظ مفتاح Anthropic'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(ar('vendors.link.error.subscriptionToken')));
  });

  it('says «محاولات كثيرة» on a 429', async () => {
    mount('anthropic', { slots: ANTHROPIC_SLOTS }, (url, method) => (method === 'POST'
      ? appError(429, 'VENDOR_KEY_RATE_LIMITED')
      : undefined));
    await waitFor(() => expect(field('anthropic')).not.toBeNull());
    fireEvent.change(field('anthropic'), { target: { value: 'sk-ant-api03-x' } });
    fireEvent.click(screen.getByLabelText('احفظ مفتاح Anthropic'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(ar('vendors.link.error.rateLimited')));
  });
});

describe('replacing a key nassaj did not write', () => {
  const FOREIGN = {
    slots: ANTHROPIC_SLOTS,
    projections: [
      { vendorId: 'anthropic', provider: 'claude', state: 'foreign_credential' },
      { vendorId: 'anthropic-opencode', provider: 'opencode', target: 'anthropic', state: 'linked' },
    ],
  };

  it('needs a pasted key, then a confirm, then re-sends Save with replaceForeignKey', async () => {
    const writes = mount('anthropic', FOREIGN);
    const replace = await screen.findByRole('button', { name: ar('vendors.link.replace') });
    expect((replace as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(field('anthropic'), { target: { value: 'sk-ant-api03-new' } });
    expect((replace as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(replace);

    const dialog = await screen.findByRole('dialog');
    expect(plain(dialog.textContent)).toContain(
      plain(ar('vendors.link.replaceDialog.body', { harness: 'Claude Code', company: 'Anthropic' })),
    );
    expect(writes).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: ar('vendors.link.replaceDialog.confirm') }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ apiKey: 'sk-ant-api03-new', replaceForeignKey: true });
  });
});

describe('vendor-wide delete', () => {
  const LINKED = {
    slots: ANTHROPIC_SLOTS,
    projections: [
      { vendorId: 'anthropic', provider: 'claude', state: 'linked' },
      { vendorId: 'anthropic-opencode', provider: 'opencode', target: 'anthropic', state: 'adopted' },
    ],
  };

  it('lists what will be removed and the fixed no-fallback line, and sends no removeForeignKey by default', async () => {
    const writes = mount('anthropic', LINKED);
    fireEvent.click(await screen.findByLabelText('احذف مفتاح Anthropic'));

    const dialog = await screen.findByRole('dialog');
    const text = plain(dialog.textContent);
    expect(text).toContain(plain(ar('vendors.link.delete.title', { company: 'Anthropic' })));
    expect(text).toContain(ar('vendors.link.delete.removedFrom'));
    expect(text).toContain('Claude Code');
    expect(text).toContain(ar('vendors.link.delete.fixedLine'));
    expect(text).toContain(ar('vendors.link.delete.foreignTitle'));

    const toggle = within(dialog).getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await waitFor(() => expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: ar('vendors.link.cancel') }),
    ));

    fireEvent.click(within(dialog).getByRole('button', { name: ar('vendors.link.delete.confirm') }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe('DELETE');
    expect(writes[0].url).not.toContain('vendorIds');
    expect(writes[0].url).not.toContain('removeForeignKey');
  });

  it('sends removeForeignKey=true only after the foreign toggle is switched on', async () => {
    const writes = mount('anthropic', LINKED);
    fireEvent.click(await screen.findByLabelText('احذف مفتاح Anthropic'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('switch'));
    fireEvent.click(within(dialog).getByRole('button', { name: ar('vendors.link.delete.confirm') }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].url).toContain('removeForeignKey=true');
  });

  it('cancelling sends nothing', async () => {
    const writes = mount('anthropic', LINKED);
    fireEvent.click(await screen.findByLabelText('احذف مفتاح Anthropic'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: ar('vendors.link.cancel') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes).toHaveLength(0);
  });

  it('explains a stale client refused with 409 VENDOR_DELETE_IS_VENDOR_WIDE', async () => {
    mount('anthropic', LINKED, (url, method) => (method === 'DELETE'
      ? appError(409, 'VENDOR_DELETE_IS_VENDOR_WIDE')
      : undefined));
    fireEvent.click(await screen.findByLabelText('احذف مفتاح Anthropic'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: ar('vendors.link.delete.confirm') }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(ar('vendors.link.error.vendorWide')));
  });

  it('notes a kept foreign key and a retried removal after the delete', async () => {
    mount('anthropic', LINKED, (url, method) => (method === 'DELETE'
      ? { body: { success: true, data: { slots: [
        { vendorId: 'anthropic', provider: 'claude', outcome: 'removed' },
        { vendorId: 'anthropic-opencode', provider: 'opencode', target: 'anthropic', outcome: 'adopted_credential' },
      ] } } }
      : undefined));
    fireEvent.click(await screen.findByLabelText('احذف مفتاح Anthropic'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: ar('vendors.link.delete.confirm') }));
    await waitFor(() => expect(screen.getByText(ar('vendors.link.deleteNote.kept'))).toBeTruthy());
  });
});

describe('D9 migration conflict', () => {
  const CONFLICT = {
    slots: ANTHROPIC_SLOTS,
    migrationConflict: {
      sources: [
        { harness: 'claude', target: null, group: 0 },
        { harness: 'opencode', target: 'anthropic', group: 0 },
        { harness: 'codex', target: null, group: 1 },
        { harness: 'store', target: null, group: null },
      ],
    },
  };

  it('merges equal groups, disables a subscription token, and posts the first source of the chosen group', async () => {
    const writes = mount('anthropic', CONFLICT);
    const radios = await screen.findAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios.map((radio) => (radio as HTMLInputElement).disabled)).toEqual([false, false, true]);
    expect(plain(document.body.textContent)).toContain('Claude Code · OpenCode (anthropic)');

    const choose = screen.getByRole('button', { name: ar('vendors.link.conflict.useThis') }) as HTMLButtonElement;
    expect(choose.disabled).toBe(true);
    fireEvent.click(radios[0]);
    fireEvent.click(choose);

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].url).toMatch(/\/company\/anthropic\/key\/conflict$/);
    expect(writes[0].body).toEqual({ harness: 'claude', target: null });
  });

  it('shows the source-not-found message', async () => {
    mount('anthropic', CONFLICT, (url, method) => (method === 'POST' && url.endsWith('/conflict')
      ? appError(409, 'VENDOR_MIGRATION_SOURCE_NOT_FOUND')
      : undefined));
    const radios = await screen.findAllByRole('radio');
    fireEvent.click(radios[1]);
    fireEvent.click(screen.getByRole('button', { name: ar('vendors.link.conflict.useThis') }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(ar('vendors.link.error.sourceNotFound')));
  });
});
