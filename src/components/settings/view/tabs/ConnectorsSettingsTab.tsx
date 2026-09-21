import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ExternalLink,
  Info,
  Link2,
  Loader2,
  Plus,
  RotateCw,
  Trash2,
  Users,
} from 'lucide-react';

import { cn } from '../../../../lib/utils';
import {
  connectorAdditionalFieldsPayload,
  loadConnectors,
  useConnectorsSnapshot,
  type Connector,
  type ConnectorCatalogEntry as CatalogEntry,
} from '../../../../stores/connectorsStore';
import { authenticatedFetch } from '../../../../utils/api';
import { Button, Input, Tooltip } from '../../../../shared/view/ui';
import { useOptionalAuth } from '../../../auth/context/AuthContext';
import SettingsCollapsible from '../SettingsCollapsible';
import SettingsSection from '../SettingsSection';

import { placementPresentation, targetPresentation } from './connectorPlacementState';
import ConnectorsSettingsTabM1 from './ConnectorsSettingsTabM1';

import { staticAssetUrl } from '@/lib/static-asset-url';

/**
 * ConnectorsSettingsTab — connect an external platform with one API key.
 *
 * THE FORM IS TWO DECISIONS, NOT SEVEN. Earlier this page asked for an id, a
 * transport, a command, arguments, and an environment variable name — packaging
 * knowledge that belongs to the platform, not to the person pasting a key. Now
 * the member picks a platform from the catalog (which carries all of that) and
 * answers the only question that is genuinely theirs: is this key MINE or the
 * TEAM's. A collapsed "custom platform" path stays for anything unlisted, so the
 * catalog is a shortcut rather than a ceiling.
 *
 * ALL COPY GOES THROUGH i18n. An earlier revision hardcoded Arabic, which meant
 * a member reading nassaj in English got an Arabic settings page — the strings
 * live in `settings.connectorsSettings` across every locale instead.
 *
 * A PLATFORM MOVES DOWN ONLY WHEN IT IS ACTUALLY CONNECTED (owner request,
 * 2026-08-07). "Added" used to mean "a row exists", so one tap on a tile filed
 * the platform under the connected list carrying a "No key" badge — three of
 * them stacked in the owner's install, all announcing work that had not
 * happened. A platform now stays in the grid, with its own key form opening in
 * the tile's place, until the credential is stored or the grant is back; the
 * list below is the answer to "what is connected", not "what did I tap".
 *
 * WHY PERSONAL IS THE DEFAULT. A shared key is spent by everyone and revoked for
 * everyone; a personal one touches nobody else's tree. Defaulting to the choice
 * with the smaller blast radius means a careless click cannot hand a colleague a
 * credential — and platforms whose terms require individual sign-in (Canva,
 * GitHub, Figma…) refuse sharing outright, which the picker shows before the
 * member commits rather than as an error afterwards.
 */

// The shapes live in the store now, beside the fetch that produces them.
type CredentialMode = Connector['credentialMode'];

const PLACEMENT_LABELS: Record<string, string> = {
  available: 'Tools ready for the next session',
  notConfigured: 'Account not linked',
  paused: 'Tool setup paused',
  untracked: 'Tool setup not tracked',
  pending: 'Tool setup pending',
  reconciling: 'Setting up tools…',
  partial: 'Tools ready on some engines',
  degraded: 'Tool setup needs attention',
  blocked: 'Tool setup blocked',
};

const PLACEMENT_NOTES: Record<string, string> = {
  available: 'The tools are configured for new sessions.',
  notConfigured: 'Link the account before tools can be configured.',
  paused: 'This connector is paused, so its tools are not being configured.',
  untracked: 'The account is linked, but no tool-placement record exists yet.',
  pending: 'The account is linked. Tool setup is waiting for its first verified pass.',
  reconciling: 'The account is linked and tool setup is in progress.',
  partial: 'The account is linked, but only some required engines have the tools.',
  degraded: 'The account is linked, but tool setup did not verify successfully.',
  blocked: 'The account is linked, but the server blocked tool setup until its reported cause is cleared.',
};

const TARGET_STATE_LABELS: Record<string, string> = {
  healthy: 'Ready',
  blocked: 'Blocked',
  degraded: 'Needs attention',
  working: 'In progress',
  untracked: 'Not tracked',
  pending: 'Pending',
};

function LegacyConnectorsSettingsTab() {
  const { t, i18n } = useTranslation('settings');
  const auth = useOptionalAuth();
  const canManageConnectorApps = auth?.user?.role === 'owner';

  // Even the separator is locale-specific ('، ' in Arabic, ', ' in English), so
  // the list is formatted rather than joined with a pinned string.
  const formatList = useCallback(
    (items: string[]) => {
      // `Intl.ListFormat` landed in ES2021 and this project targets ES2020, so
      // the type is absent from `lib` even though every browser the UI supports
      // ships it. Reached for locally rather than by widening `lib` in the shared
      // tsconfig: one narrow cast beats changing what every file in the app sees.
      const ListFormat = (
        Intl as typeof Intl & {
          ListFormat?: new (
            locale?: string,
            options?: { style?: string; type?: string },
          ) => { format(items: string[]): string };
        }
      ).ListFormat;
      if (!ListFormat) return items.join(', ');
      try {
        return new ListFormat(i18n.language, {
          style: 'short',
          type: 'conjunction',
        }).format(items);
      } catch {
        return items.join(', ');
      }
    },
    [i18n.language],
  );

  /**
   * A platform's own copy, translated.
   *
   * The catalog is CODE — it lives beside the packaging it describes and is
   * therefore written in English like the rest of the server. Rendering it
   * directly is what produced the mixed-language page a member reported twice:
   * English headings over Arabic summaries, or the reverse. So the display text
   * comes from i18n keyed by service, and falls back to the catalog value for a
   * platform nobody has translated yet — a missing translation shows the English
   * line rather than a blank card.
   */
  const platformText = useCallback(
    (
      entry: { service: string; summary?: string; keyLabel?: string; displayName?: string },
      field: 'summary' | 'keyLabel' | 'displayName',
    ) => {
      const key = `connectorsSettings.platforms.${entry.service}.${field}`;
      const translated = t(key, { defaultValue: '' });
      return translated || entry[field] || '';
    },
    [t],
  );

  // Usually already full: the settings dialog starts this fetch when it opens.
  const { connectors, catalog, targets, catalogSchemaVersion, ready, loading: fetching, error: fetchError }
    = useConnectorsSnapshot();
  // Only a WRITE gets its own error line here; read failures are the store's.
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [setupNeededOpen, setSetupNeededOpen] = useState(false);
  const oauthStartInFlight = useRef(false);

  /**
   * The SERVICE whose key form is open, if any — one form on this page, and it
   * is rendered wherever its platform currently lives: in the grid tile's place
   * while the platform is not connected yet, and inside the connected card's
   * body when an existing key is being rotated. Never both, because a platform
   * is in exactly one of those two lists.
   *
   * Keyed by service rather than by row because the form now opens BEFORE any
   * row exists: the first thing a member does with a key platform is fill this
   * in, and only saving it creates the connector.
   */
  type FormSubject = { service: string; rowId: string | null; anchorId?: string };
  const [picking, setPicking] = useState<FormSubject | null>(null);
  const [mode, setMode] = useState<CredentialMode>('per_member');
  const [accountLabel, setAccountLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [extras, setExtras] = useState<Record<string, string>>({});

  /**
   * The row whose deletion is armed, by id.
   *
   * Deleting a connector is not undoable in the one case that matters: a SHARED
   * key is swept from every member's tree and its only copy leaves the store —
   * nothing in nassaj can read it back, so a mis-tap costs the whole install a
   * working connector and nobody has the string to restore it (WCAG 3.3.4). The
   * arm-then-confirm pair is inline rather than a dialog because this page lives
   * inside a modal already, and a modal over a modal is a focus trap over a
   * focus trap.
   */
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  /**
   * What just happened, announced to assistive technology.
   *
   * Storing a key or removing a connector changed the page silently: the form
   * folded, the platform moved between two lists, and a screen-reader user was
   * told nothing at all (WCAG 4.1.3). The region is permanent and only its text
   * changes — a live region mounted at the same moment as its message is a
   * message nobody hears.
   */
  const [announcement, setAnnouncement] = useState('');

  /**
   * The open form, so focus can follow the member into it.
   *
   * Opening the form replaced the very button that had focus, which drops focus
   * to `document.body`; and since the settings shell is not a programmatic
   * dialog (B-559), the next Tab restarted from the top of the page BEHIND the
   * modal. Focus is moved into the form instead, and the form is scrolled into
   * view — it can open far below the fold in a long grid.
   */
  const formRef = useRef<HTMLDivElement | null>(null);
  /**
   * Which added cards are expanded, by connector id. Everything starts closed.
   *
   * The first revision opened whatever still needed something, on the theory
   * that an unfinished connector wants attention. Measured on a real account
   * with eight pending platforms it produced a 2800px wall in which four cards
   * repeated the same amber box word for word — the exact clutter the request
   * was about. So the row carries its STATE as badges (linked / not linked /
   * operator app missing) and its one primary ACTION in the header, and only
   * the procedure folds.
   */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // A mutation must discard what we hold; the plain call is a no-op once loaded.
  const load = useCallback(() => loadConnectors(true), []);

  // Belt and braces: the dialog normally has this in flight before the tab is
  // even picked, but the tab must also work if it is ever rendered on its own.
  useEffect(() => {
    void loadConnectors();
  }, []);

  /** The store reports WHAT failed; the sentence is built here, in the member's language. */
  const readError = useMemo(() => {
    if (!fetchError) return null;
    if (fetchError.kind === 'timeout') return t('connectorsSettings.timedOut');
    if (fetchError.kind === 'http') {
      return t('connectorsSettings.loadFailed', { status: fetchError.status });
    }
    return fetchError.message;
  }, [fetchError, t]);

  /**
   * A ROW IS NOT A CONNECTION. An OAuth platform is added first and linked
   * afterwards, and a key row can survive its key being cleared — so `configured`
   * (the server's answer to "is there actually a credential or a grant") is what
   * splits the page: connected platforms below, everything else still in the
   * grid above, whether or not a half-finished row exists behind the tile.
   */
  const rowById = useMemo(() => new Map(connectors.map((c) => [c.id, c])), [connectors]);
  const rowsByService = useMemo(() => {
    const grouped = new Map<string, Connector[]>();
    for (const connector of connectors) {
      grouped.set(connector.service, [...(grouped.get(connector.service) ?? []), connector]);
    }
    return grouped;
  }, [connectors]);
  const configuredRows = useMemo(() => connectors.filter((c) => c.configured), [connectors]);

  /**
   * THREE LISTS, EACH ONE UNIFORM INSIDE ITSELF.
   *
   * A platform is in exactly one of three states, and each state has a shape
   * that suits it: an untouched platform is a one-line tile in a grid, an
   * unfinished attempt is a row wide enough to say what is missing, and a
   * connected one is a card that folds open. Mixing the first two in one grid is
   * what produced the ragged columns the owner reported (2026-08-07): the two
   * tiles carrying a state line grew a second row, their grid partners did not,
   * and the rhythm broke in the middle of the list.
   */
  const available = useMemo(
    () => catalog.filter((e) => !rowsByService.has(e.service)),
    [catalog, rowsByService],
  );
  const readyPlatforms = useMemo(
    () => available.filter((entry) => entry.authMode !== 'oauth' || entry.oauthAvailability === 'ready'),
    [available],
  );
  const ownerActionRequired = useMemo(
    () => available.filter((entry) => entry.authMode === 'oauth' && entry.oauthAvailability !== 'ready'),
    [available],
  );
  const setupProviderGroups = useMemo(() => {
    const groups = new Map<string, CatalogEntry[]>();
    for (const entry of ownerActionRequired) {
      // The public DTO intentionally exposes no provider/application profile.
      // Google's three services still share one operator app, so group that
      // well-known family visually without widening the server contract.
      const group = ['gmail', 'google-drive', 'google-calendar'].includes(entry.service)
        ? 'google'
        : entry.service;
      groups.set(group, [...(groups.get(group) ?? []), entry]);
    }
    return [...groups.entries()];
  }, [ownerActionRequired]);
  const pending = useMemo(
    () =>
      connectors
        .filter((row) => !row.configured)
        .map((row) => ({
          row,
          entry: catalog.find((entry) => entry.service === row.service) ?? {
            service: row.service,
            displayName: row.displayName,
            summary: '',
            allowsSharing: row.allowsSharing,
            official: true,
            authMode: row.authMode,
          },
        })),
    [catalog, connectors],
  );

  /** The row behind the open form, when the platform already has one. */
  const formRow = useMemo(
    () => (picking?.rowId ? (rowById.get(picking.rowId) ?? null) : null),
    [picking, rowById],
  );

  /**
   * The one form's subject. The fallback matters — a row can outlive its catalog
   * entry (a platform dropped from a later release), and a member holding that
   * key still deserves a way to replace it.
   */
  const formEntry = useMemo<CatalogEntry | null>(() => {
    if (!picking) return null;
    const entry = catalog.find((c) => c.service === picking.service);
    if (entry) return entry;
    if (!formRow) return null;
    return {
      service: formRow.service,
      displayName: formRow.displayName,
      summary: '',
      allowsSharing: formRow.allowsSharing,
      official: true,
      authMode: formRow.authMode,
    };
  }, [picking, catalog, formRow]);

  const { perMember, shared } = useMemo(
    () => ({
      perMember: targets.filter((t) => t.writesPerUserConfig).map((t) => t.provider),
      shared: targets.filter((t) => !t.writesPerUserConfig).map((t) => t.provider),
    }),
    [targets],
  );

  const submit = async (path: string, method: string, body?: unknown) => {
    const res = await authenticatedFetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error ?? t('connectorsSettings.requestFailed', { status: res.status }));
    }
    return res.json();
  };

  /** Points the one form at a platform, whether or not it has a row yet. */
  const openKeyForm = (service: string, row: Connector | null, anchorId?: string) => {
    setPicking({ service, rowId: row?.id ?? null, anchorId });
    // New writes are personal until the cross-body isolation gateway exists.
    // Legacy shared rows remain visible below, but never enter this editing form.
    setMode('per_member');
    setAccountLabel(row?.accountLabel ?? '');
    setApiKey('');
    setExtras({});
    setArmedDelete(null);
    // A frame later: the node does not exist until this render commits.
    requestAnimationFrame(() => {
      formRef.current?.focus({ preventScroll: true });
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  /**
   * WHAT A TILE DOES: it opens the platform's panel, and nothing reaches the
   * server until the member acts inside it.
   *
   * A key platform worked this way already. An OAuth platform did NOT — one tap
   * created the row and left for the consent screen, so a member who tapped out
   * of curiosity, or who changed their mind on the platform's own page, came
   * back to a row nassaj had already filed. Measured on the owner's account:
   * three such rows from three taps, and they are exactly the clutter every
   * round of this page has been about.
   *
   * THE COST IS ONE TAP, deliberately spent (this narrows "adding is one click",
   * owner request 2026-08-07). What the extra tap buys is a panel that says who
   * publishes the server, how the credential is isolated, and — when the
   * operator has not registered the app — why the platform cannot be linked at
   * all, which is a better answer than a redirect that fails on the other side.
   */
  const choosePlatform = (entry: CatalogEntry) => {
    if (entry.authMode === 'oauth') {
      if (entry.oauthAvailability !== 'ready' || busyId !== null || oauthStartInFlight.current) return;
      void startFirstOAuth(entry);
      return;
    }
    openKeyForm(entry.service, null);
  };

  /** First OAuth account is one action: no placeholder row and no intermediate form. */
  const startFirstOAuth = async (entry: CatalogEntry) => {
    if (entry.oauthAvailability !== 'ready' || busyId !== null || oauthStartInFlight.current) return;
    oauthStartInFlight.current = true;
    setBusyId(`new:${entry.service}`);
    setError(null);
    try {
      const { authorizeUrl } = await submit('/api/connectors/oauth/start', 'POST', {
        service: entry.service,
        accountLabel: '',
      });
      window.location.assign(authorizeUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusyId(null);
      oauthStartInFlight.current = false;
    }
  };

  /** Additional account uses the same atomic OAuth start; an existing retry keeps its row endpoint. */
  const linkPlatform = async (entry: CatalogEntry) => {
    if (entry.oauthAvailability !== 'ready' || busyId !== null || oauthStartInFlight.current) return;
    oauthStartInFlight.current = true;
    setBusyId(formRow?.id ?? `new:${entry.service}`);
    setError(null);
    try {
      if (formRow) {
        const { authorizeUrl } = await submit(
          `/api/connectors/${encodeURIComponent(formRow.id)}/oauth/start`,
          'POST',
        );
        window.location.assign(authorizeUrl);
        return;
      }
      const { authorizeUrl } = await submit('/api/connectors/oauth/start', 'POST', {
        service: entry.service,
        accountLabel: accountLabel.trim(),
      });
      window.location.assign(authorizeUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusyId(null);
      oauthStartInFlight.current = false;
    }
  };

  // A server that needs a second value refuses to boot without it, so the save
  // button waits for every declared extra rather than letting the member paste a
  // key and discover the failure later, in an engine, with no message.
  const extrasComplete = (formEntry?.additionalFields ?? []).every((f) => extras[f.id]?.trim());

  // The form only ever opens for a key platform now — an OAuth row is linked
  // from its own card — but the guard stays so a future caller cannot quietly
  // put a password box in front of a platform that has no password.
  const needsKey = formEntry?.authMode !== 'oauth';

  /** Shared creation stays closed until bodies have a real isolation boundary. */
  const canShare = false;
  const additionalAccountNeedsLabel = Boolean(
    formEntry && !formRow && (rowsByService.get(formEntry.service)?.length ?? 0) > 0,
  );

  /**
   * The one line under the scope control.
   *
   * It answers whichever question is live: when a member cannot share, WHY the
   * other half is dim (the platform's own policy, or the role they hold); and
   * otherwise what the current choice means. One line, changing, instead of two
   * permanent descriptions plus a warning box that said the shared case twice.
   */
  /**
   * The one form's save. It carries THREE things because they are one decision:
   * who the credential serves, what the platform needs beside the key, and the
   * key.
   *
   * A platform with no row yet sends all three in the CREATE call, so the row is
   * born connected — there is no moment in between where the page could list a
   * platform it cannot actually use. Rotating an existing key still takes three
   * calls, and the mode goes first: a key distributed under the old audience
   * would have to be swept a moment later.
   */
  const saveKey = async (entry: CatalogEntry, row: Connector | null) => {
    const next = apiKey.trim();
    if (!next) return;
    setBusyId(row?.id ?? '__new__');
    setError(null);
    try {
      if (row) {
        const id = encodeURIComponent(row.id);
        if (Object.keys(extras).length > 0) {
          await submit(
            `/api/connectors/${id}`,
            'PATCH',
            connectorAdditionalFieldsPayload(entry, extras, catalogSchemaVersion),
          );
        }
        await submit(`/api/connectors/${id}/key`, 'PUT', { apiKey: next });
      } else {
        await submit('/api/connectors', 'POST', {
          service: entry.service,
          accountLabel: accountLabel.trim(),
          credentialMode: 'per_member',
          ...connectorAdditionalFieldsPayload(entry, extras, catalogSchemaVersion),
          apiKey: next,
        });
      }
      setApiKey('');
      setPicking(null);
      setAnnouncement(
        t('connectorsSettings.announceConnected', {
          name: platformText(entry, 'displayName'),
        }),
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };


  /**
   * Sends the member to the platform's consent screen.
   *
   * Same tab, not a popup: on iOS a window opened after an await is blocked, and
   * the member would be left staring at a page that did nothing. The return leg
   * lands on nassaj's own callback route, which links back here.
   */
  const startOAuth = async (id: string) => {
    if (oauthStartInFlight.current) return;
    oauthStartInFlight.current = true;
    setBusyId(id);
    setError(null);
    try {
      const { authorizeUrl } = await submit(
        `/api/connectors/${encodeURIComponent(id)}/oauth/start`,
        'POST',
      );
      window.location.href = authorizeUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusyId(null);
      oauthStartInFlight.current = false;
    }
  };

  const removeConnector = async (connector: Connector) => {
    const id = connector.id;
    setBusyId(id);
    setError(null);
    try {
      await submit(`/api/connectors/${encodeURIComponent(id)}`, 'DELETE');
      // The form's subject just stopped existing; leaving it open would offer a
      // key box for a platform that is back in the grid untouched.
      if (picking?.rowId === connector.id || picking?.anchorId === connector.id) setPicking(null);
      setArmedDelete(null);
      setAnnouncement(
        t('connectorsSettings.announceRemoved', {
          name: platformText(connector, 'displayName'),
        }),
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  /** Manual placement repair is offered only when the server explicitly allows it. */
  const retryPlacement = async (connector: Connector) => {
    if (connector.retryAvailable !== true) return;
    setBusyId(connector.id);
    setError(null);
    try {
      await submit(`/api/connectors/${encodeURIComponent(connector.id)}/reconcile`, 'POST');
      setAnnouncement(t('connectorsSettings.reconcileRequested', {
        name: platformText(connector, 'displayName'),
      }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * The delete control: one press arms it, the second one carries it out.
   *
   * Rendered as WORDS when armed, not as a second icon — "what happens if I
   * press this again" is the whole question at that moment, and for a shared
   * credential the answer is "every member loses it and nobody can put it back".
   */
  const deleteControl = (connector: Connector) => {
    const name = platformText(connector, 'displayName');
    const armed = armedDelete === connector.id;
    const shared =
      connector.credentialMode === 'org_shared' || connector.credentialSource === 'operator_env';
    if (!armed) {
      return (
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('connectorsSettings.remove', { name })}
          disabled={busyId === connector.id}
          onClick={() => setArmedDelete(connector.id)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      );
    }
    return (
      <span className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-[13px] leading-relaxed text-warning">
          {shared
            ? t('connectorsSettings.removeConfirmShared', { name })
            : t('connectorsSettings.removeConfirm', { name })}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={busyId === connector.id}
          onClick={() => void removeConnector(connector)}
        >
          {busyId === connector.id ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
          <span className="ms-1">{t('connectorsSettings.removeConfirmAction')}</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setArmedDelete(null)}>
          {t('connectorsSettings.cancel')}
        </Button>
      </span>
    );
  };

  /**
   * THE ONE FORM — built here, mounted wherever its platform lives.
   *
   * Everything a member needs at the moment of choosing is in it: what the
   * platform does, how its credential is isolated, whether the server is
   * third-party, where the key comes from. It renders inside the grid tile
   * while the platform is not connected yet, and inside the connected card
   * when a stored key is being rotated — one component, one set of state, and
   * never two doorways to it (owner report, 2026-08-07: a standalone key box
   * sitting beside a card whose button led to the same box).
   */
  const keyFieldId = `connector-key-${formEntry?.service ?? 'none'}`;
  const keyForm = formEntry ? (
    <div
      ref={formRef}
      // A named group with a focus stop of its own: focus lands here when the
      // form opens, so the member who pressed the tile is inside what they
      // opened rather than back at the top of the page behind the modal.
      tabIndex={-1}
      role="group"
      aria-label={platformText(formEntry, 'displayName')}
      className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* WHO THIS FORM IS ABOUT — but only where the question is open. Mounted
          in the grid it replaces the tile, so the mark and the name are the only
          thing saying which platform this is. Mounted inside a connected card,
          the card's own header says it one line above, and repeating it there
          printed the platform's name twice within one border (measured). */}
      {!formRow?.configured && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <PlatformLogo entry={formEntry} />
            <span dir="auto" className="font-medium">
              {platformText(formEntry, 'displayName')}
            </span>
          </div>
        </>
      )}
      {/*
        THE SCOPE, AS A SEGMENTED PAIR — and its consequence on ONE line.

        Answering "whose key is this?" used to cost about 150px: a policy
        sentence, a question, two cards each with a title and two lines of
        explanation, then an amber box repeating the shared case a third time.
        The question is two words wide; it now fits a 36px control, and the line
        under it changes with the answer — so the consequence is read at the
        moment it becomes true instead of standing on the page permanently.

        `aria-disabled`, never `disabled`, on the half a member may not choose:
        `disabled` drops it out of the focus order and takes its REASON with it,
        and the reason is the only thing that explains a dimmed control.
      */}
      {canShare && <div className="space-y-1.5">
        <div
          role="radiogroup"
          aria-label={t('connectorsSettings.scopeGroupLabel')}
          aria-describedby={`${keyFieldId}-scope-note`}
          className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1"
          onKeyDown={(e) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
            e.preventDefault();
            // Two options, so any arrow flips. Deliberately direction-free: in
            // Arabic "next" is to the LEFT, and a hard-coded side inverts the
            // group for half the readers of this page.
            if (canShare) setMode(mode === 'per_member' ? 'org_shared' : 'per_member');
          }}
        >
          <ScopeChoice
            active={mode === 'per_member'}
            label={t('connectorsSettings.modePersonal')}
            onSelect={() => setMode('per_member')}
          />
          <ScopeChoice
            active={mode === 'org_shared'}
            label={t('connectorsSettings.modeShared')}
            blocked={!canShare}
            onSelect={() => setMode('org_shared')}
          />
        </div>
        <p
          id={`${keyFieldId}-scope-note`}
          aria-live="polite"
          className="text-[13px] leading-relaxed text-muted-foreground"
        >
          {t('connectorsSettings.sharedUnavailableIsolation')}
        </p>
      </div>}

      {needsKey && !formEntry.official && (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-[13px] leading-relaxed">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span>
            {t('connectorsSettings.unofficialNote')}
            {/* "A third party will hold your key" is a warning nobody
                can act on without a name. The link is the difference
                between a caution and a decision the member can make
                after looking (owner request, 2026-08-07). */}
            {formEntry.vendorUrl && (
              <a
                href={formEntry.vendorUrl}
                target="_blank"
                rel="noreferrer"
                className="ms-1 inline-flex items-center gap-1 text-primary hover:underline"
              >
                {/* Directional glyph: its arrow points away-and-up, so it mirrors with
              the text direction (surface language §6.3). No base `scale-x` class
              beside it — the pair collides (B-373). */}
          <ExternalLink className="h-3.5 w-3.5 rtl:-scale-x-100" />
                <span>{t('connectorsSettings.whoPublishes')}</span>
              </a>
            )}
          </span>
        </div>
      )}

      {!formRow && (
        <div className="space-y-1 text-sm">
          <label htmlFor={`${keyFieldId}-account`} className="block font-medium">
            {t('connectorsSettings.accountLabel')}
          </label>
          <Input
            id={`${keyFieldId}-account`}
            type="text"
            dir="auto"
            value={accountLabel}
            required={additionalAccountNeedsLabel}
            aria-describedby={`${keyFieldId}-account-note`}
            onChange={(event) => setAccountLabel(event.target.value)}
          />
          <p
            id={`${keyFieldId}-account-note`}
            className="text-[13px] leading-relaxed text-muted-foreground"
          >
            {additionalAccountNeedsLabel
              ? t('connectorsSettings.accountLabelRequired')
              : t('connectorsSettings.accountLabelHint')}
          </p>
        </div>
      )}

      {needsKey && (
      <div className="space-y-1 text-sm">
        {/* Label and "where do I get it?" share a line: they are the same
            question asked twice, and stacking them cost a whole row. */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <label htmlFor={keyFieldId} className="font-medium">
            {platformText(formEntry, 'keyLabel') || t('connectorsSettings.keyLabel')}
          </label>
          {formEntry.keyHelpUrl && (
            <a
              href={formEntry.keyHelpUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[13px] font-normal text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5 rtl:-scale-x-100" />
              <span>{t('connectorsSettings.whereToGetKey')}</span>
            </a>
          )}
        </div>
        {/*
          THE FIELD IS THE SHARED PRIMITIVE, not a hand-written class string.
          The hand-written one had no focus ring and a border at 1.23:1 against
          white — invisible as a control (WCAG 1.4.11) — while `Input` already
          carries `h-10` and `ring-2 ring-ring`.

          `dir="ltr"` plus bidi isolation because a credential is a technical
          string: left to inherit the page's Arabic base it is REORDERED on
          screen — digits, dots and dashes migrate to the wrong end and the
          caret starts on the wrong side, so what the member reads back is not
          what they pasted. Monospace for the same reason a key is read
          character by character.
        */}
        <Input
          id={keyFieldId}
          type="password"
          autoComplete="new-password"
          dir="ltr"
          style={{ unicodeBidi: 'isolate' }}
          className="font-mono"
          aria-describedby={`${keyFieldId}-note`}
          aria-invalid={error ? true : undefined}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        {/* Outside the label on purpose: inside it, "stored encrypted and never
            shown again" became part of the field's ACCESSIBLE NAME and was read
            out on every focus. */}
        <p id={`${keyFieldId}-note`} className="text-[13px] leading-relaxed text-muted-foreground">
          {t('connectorsSettings.keyStoredNote')}
        </p>
      </div>
      )}

      {needsKey && (formEntry.additionalFields ?? []).map((field) => (
        <div key={field.id} className="space-y-1 text-sm">
          <label htmlFor={`${keyFieldId}-${field.id}`} className="block font-medium">
            {field.label}
          </label>
          <Input
            id={`${keyFieldId}-${field.id}`}
            type="text"
            dir="ltr"
            style={{ unicodeBidi: 'isolate' }}
            className="font-mono"
            value={extras[field.id] ?? ''}
            placeholder={field.hint}
            aria-describedby={field.hint ? `${keyFieldId}-${field.id}-hint` : undefined}
            onChange={(e) =>
              setExtras((prev) => ({ ...prev, [field.id]: e.target.value }))
            }
          />
          {/* A placeholder disappears at the first keystroke, so it cannot be
              the only place the requirement is written (WCAG 3.3.2). */}
          {field.hint && (
            <p
              id={`${keyFieldId}-${field.id}-hint`}
              className="text-[13px] leading-relaxed text-muted-foreground"
            >
              {field.hint}
            </p>
          )}
        </div>
      ))}

      {/* flex-wrap because the labels cannot: every other button row in this
          file wraps, and at 320px with the text-spacing override of WCAG 1.4.12
          three no-wrap labels exceed the line. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* ONE primary action, and which one follows the platform: a
            key platform stores what was typed, an OAuth platform
            leaves for its consent screen. They are never both on
            screen, so neither has to be qualified in words. */}
        {needsKey ? (
          <Button
            size="sm"
            aria-busy={busyId !== null}
            disabled={
              busyId !== null ||
              !apiKey.trim() ||
              !extrasComplete ||
              (additionalAccountNeedsLabel && !accountLabel.trim())
            }
            onClick={() => void saveKey(formEntry, formRow)}
          >
            {busyId !== null && <Loader2 className="h-4 w-4 animate-spin" />}
            <span className="ms-1">
              {formRow?.configured
                ? t('connectorsSettings.rotate')
                : t('connectorsSettings.connect')}
            </span>
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={
              busyId !== null ||
              formEntry.oauthAvailability !== 'ready' ||
              (additionalAccountNeedsLabel && !accountLabel.trim())
            }
            onClick={() => void linkPlatform(formEntry)}
          >
            {busyId !== null ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Link2 className="h-4 w-4" />
            )}
            <span className="ms-1">
              {formRow
                ? t('connectorsSettings.oauthLink')
                : t('connectorsSettings.continue', { defaultValue: 'Continue' })}
            </span>
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setPicking(null)}>
          {t('connectorsSettings.cancel')}
        </Button>
        {/* An unfinished row's ONLY way out. Its card left the list
            below when it stopped counting as connected, and the trash
            icon went with it — so a member who added a platform by
            mistake would have no way to drop it. */}
        {formRow && !formRow.configured && (
          <span className="ms-auto">{deleteControl(formRow)}</span>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div className="min-w-0 max-w-full space-y-8 overflow-x-hidden">
      {/*
        Page-level section header, the same shape every other settings tab uses
        (`level="page"` + toned icon). The first revision put the title inside a
        card instead, which is why this tab read as a different product from the
        one beside it.
      */}
      <SettingsSection
        level="page"
        icon={Link2}
        tone="info"
        title={t('connectorsSettings.title')}
        description={t('connectorsSettings.description')}
      >

        {/* Two tabs hold keys, and the difference is not obvious from either one:
            this page is about platforms the MODELS use, while Vendors &
            credentials holds the keys that run the models themselves. One line
            here is cheaper than a member pasting an Anthropic key into Notion. */}
        <p className="mb-4 text-[13px] leading-relaxed text-muted-foreground">
          {t('connectorsSettings.notVendorsHint')}
        </p>

        {/*
          THE ONE THING THE MEMBER MUST BE TOLD, told properly. This box used to
          be a silent div: no `role`, so a failed save or delete reached a screen
          reader as nothing at all; no icon, so the fact that it was an error
          rested on colour alone (WCAG 1.4.1); and `text-destructive` on a tinted
          surface measures 3.54:1 in light and 1.97:1 in dark — unreadable by AA
          in both themes at once. `--danger` is the token for error TEXT (6.48
          and 7.28); `--destructive` is a surface colour and says so.
        */}
        {(error || readError) && (
          <div
            role="alert"
            className="mb-4 flex flex-wrap items-start justify-between gap-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm"
          >
            <span className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              <span className="text-foreground">{error || readError}</span>
            </span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t('connectorsSettings.retry')}
            </Button>
          </div>
        )}

        {/*
          Permanent, empty, and only its TEXT changes — a live region created at
          the same moment as its message is a message nobody hears. It carries
          what the layout says visually and assistive technology otherwise
          missed: the key was stored, the connector was removed.
        */}
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>

        {/*
          The spinner is for the FIRST load only. Once the lists are real they
          stay on screen through every refresh — replacing a working page with
          "Loading…" after each add or delete is a flicker that says the page is
          slow when it is not. `ready` is the store's word for "these lists are
          real", and it survives the tab unmounting.
        */}
        {!ready ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{t('connectorsSettings.loading')}</span>
          </div>
        ) : (
          <div className="space-y-8">
            <div className="space-y-3">
              <h3 className="text-sm font-medium">{t('connectorsSettings.addPlatform')}</h3>
              {/* The grid alone is a serviceable empty state; one sentence turns
                  it from an unexplained list into a starting point. */}
              {configuredRows.length === 0 && (
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  {t('connectorsSettings.emptyHint')}
                </p>
              )}

              {/*
                TWO COLUMNS AT MOST, and the third one is gone for a measured
                reason. `lg:` asks the WINDOW, and this grid does not live in the
                window: the settings panel is capped at `max-w-4xl` and the
                sidebar takes `w-56` from it, so the content box stops growing at
                672px however wide the screen gets. Measured across eleven
                widths: at 744px the content is 742px and nothing truncates, and
                at 1512px the content is 670px in three columns and FIVE of
                twenty names truncate — the widest screen produced the narrowest
                tile. Until the surface answers its container instead of the
                window (B-558), the honest column count in a 672px box is two.
              */}
              <div className="grid gap-2 sm:grid-cols-2">
                {/*
                  CONNECTED PLATFORMS LEAVE THIS GRID (owner report, 2026-08-06:
                  "the duplicated cards"). Showing them here greyed out put every
                  connected platform on the page twice — once as a live row above
                  and once as a dead tile below — and the dead one still cost a
                  full card of scanning. Deleting a row puts it back.

                  A platform with a row that is NOT connected stays here on
                  purpose (owner request, 2026-08-07): a keyless row is an
                  unfinished attempt, and its place is where the member picks up
                  the attempt, not in the list of what works.
                */}
                {readyPlatforms.map((entry) => {
                  const summary = platformText(entry, 'summary');

                  /*
                    THE FORM OPENS IN THE TILE'S PLACE, spanning the grid. It used
                    to sit in a box of its own between the grid and the list
                    below, so a member met a key box AND a card with an "Add key"
                    button — one form, two doorways, which read as two (owner
                    report, 2026-08-07). Rendered here, the platform a member
                    tapped is the platform whose form they are looking at.
                  */
                  if (picking?.service === entry.service && picking.rowId === null) {
                    return (
                      <div key={entry.service} className="sm:col-span-2">
                        {keyForm}
                      </div>
                    );
                  }

                  return (
                    /*
                      THE SUMMARY LEFT THE CARD (owner request, 2026-08-06). Twenty
                      cards each carrying two sentences is a wall to scan, and the
                      sentence is what a member wants on ONE card, once. It now
                      lives behind the info mark — and behind the mark rather than
                      only in `title=` because a touch screen has no hover: the
                      tooltip is tap-to-toggle, and the native title is the
                      pointer bonus, not the mechanism.

                      The mark sits OUTSIDE the button on purpose. Nested buttons
                      are invalid, and a tap that both opened the tooltip and
                      selected the platform would answer a question nobody asked.
                    */
                    <div key={entry.service} className="relative h-full">
                    <button
                      type="button"
                      aria-disabled={busyId === `new:${entry.service}` || undefined}
                      aria-busy={busyId === `new:${entry.service}` || undefined}
                      onClick={() => choosePlatform(entry)}
                      title={summary || undefined}
                      className={cn(
                        // `h-full`: a grid row is as tall as its tallest cell, so
                        // without it the shorter card floats with a gap under it
                        // and the row reads as broken rather than as two cards.
                        'min-h-11 h-full w-full rounded-lg border px-3 py-1.5 text-start transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        // Deliberately NOT highlighted while picked: the form
                        // that opens below is the answer, and painting the tile
                        // primary too put two primary-tinted objects on screen
                        // for one platform — which is what read as duplication.
                        'border-border hover:border-primary/40',
                      )}
                    >
                      {/*
                        ONE LINE, EVERY TILE, NO EXCEPTIONS (owner report,
                        2026-08-07: "the mess is still there"). A state line under
                        the name added a second row to two tiles out of nineteen,
                        and a grid row is as tall as its tallest cell — so two rows
                        in the middle of the list grew, their partners kept their
                        old height, and the column rhythm broke twice. The state
                        did not move into a corner; the PLATFORM moved, into the
                        unfinished group below, where a second line costs nothing.
                      */}
                      <div className="flex min-h-9 min-w-0 items-center gap-2 pe-12">
                        <PlatformLogo entry={entry} />
                        <span
                          dir="auto"
                          className="min-w-0 truncate font-medium"
                          title={platformText(entry, 'displayName')}
                        >
                          {platformText(entry, 'displayName')}
                        </span>
                        {/* Muted, not primary: nineteen accent-coloured marks in
                            one grid compete with the names they annotate, and the
                            whole tile is the button anyway. */}
                        <span className="ms-auto shrink-0 text-muted-foreground">
                          {busyId === `new:${entry.service}` ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <Plus className="h-4 w-4" aria-hidden="true" />
                          )}
                        </span>
                      </div>
                    </button>
                    {summary && (
                      <span className="absolute end-1 top-1">
                        {/*
                          THE TARGET IS THE WRAPPER, not the glyph. The mark drawn
                          at 14×14 was a 14px target sitting inside a card whose
                          entire face is a button — so a miss of ten pixels did
                          not do nothing, it opened a key form for a platform the
                          member only wanted to read about. WCAG 2.5.8 gives a
                          small target a pass only when a 24px circle around it
                          touches no other target, and here it is INSIDE one, so
                          no exemption applies. A real button also gives the tap
                          stop a role and a name; the div it used to be carried
                          `aria-expanded` on a `generic` role, which is invalid.
                        */}
                        <Tooltip content={summary} position="bottom" multiline tapToToggle>
                          <button
                            type="button"
                            aria-label={t('connectorsSettings.platformInfo', {
                              name: platformText(entry, 'displayName'),
                            })}
                            className="grid h-11 w-11 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Info className="h-4 w-4" />
                          </button>
                        </Tooltip>
                      </span>
                    )}
                    </div>
                  );
                })}
              </div>

              {setupProviderGroups.length > 0 && (
                <div className="rounded-lg border border-border bg-muted p-3 text-sm">
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {canManageConnectorApps
                          ? t('connectorsSettings.setupNeededOwnerTitle', {
                              count: setupProviderGroups.length,
                            })
                          : t('connectorsSettings.setupNeededMemberTitle', {
                              count: setupProviderGroups.length,
                            })}
                      </p>
                      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                        {canManageConnectorApps
                          ? t('connectorsSettings.setupNeededOwnerHint')
                          : t('connectorsSettings.setupNeededMemberHint')}
                      </p>
                    </div>
                    {canManageConnectorApps && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-expanded={setupNeededOpen}
                        aria-controls="connector-apps-setup-needed"
                        onClick={() => setSetupNeededOpen((open) => !open)}
                      >
                        <ChevronDown
                          aria-hidden="true"
                          className={cn('h-4 w-4 transition-transform', setupNeededOpen && 'rotate-180')}
                        />
                        <span className="ms-1">{t('connectorsSettings.reviewSetupNeeded')}</span>
                      </Button>
                    )}
                  </div>
                  {(setupNeededOpen || !canManageConnectorApps) && (
                    <div
                      id="connector-apps-setup-needed"
                      className="mt-3 border-t border-border pt-3"
                    >
                      <p className="mb-2 font-medium">{t('connectorsSettings.setupNeededSection')}</p>
                      <ul className="space-y-2">
                        {setupProviderGroups.map(([provider, entries]) => (
                          <li key={provider} className="rounded-md bg-background px-3 py-2">
                            <span dir="auto" className="font-medium">
                              {provider === 'google'
                                ? t('connectorsSettings.googleProvider')
                                : platformText(entries[0], 'displayName')}
                            </span>
                            {provider === 'google' && (
                              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
                                {entries.map((entry) => (
                                  <li key={entry.service} dir="auto">
                                    {platformText(entry, 'displayName')}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/*
              UNFINISHED ATTEMPTS, in a place of their own.

              These are platforms this member started and did not complete: a key
              row with no key, or an OAuth row whose consent never came back. They
              are NOT connected, so they must not appear in the list below (owner
              request, 2026-08-07) — and they are not untouched either, so putting
              them in the grid above forced that grid to carry a second line on
              some tiles and broke its rhythm. A full-width row can say what is
              missing and what to press without disturbing anything.

              Nothing renders when there are none, which is the normal case now:
              a key platform no longer creates a row before its key exists.
            */}
            {pending.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium">{t('connectorsSettings.unfinished')}</h3>
                {pending.map(({ entry, row }) =>
                  picking?.rowId === row.id ? (
                    <div key={row.id}>{keyForm}</div>
                  ) : (
                    <div
                      key={row.id}
                      className="flex min-h-9 flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-1.5"
                    >
                      <PlatformLogo entry={entry} fallbackName={platformText(entry, 'displayName')} />
                      <span dir="auto" className="min-w-0 truncate font-medium">
                        {platformText(entry, 'displayName')}
                      </span>
                      <span
                        dir="auto"
                        className="min-w-0 truncate text-[13px] text-muted-foreground"
                      >
                        {row.accountLabel || t('connectorsSettings.defaultAccount')}
                      </span>
                      {/*
                        THE ACTION IS THE STATE. A row under "unfinished" that
                        also carried the words "no key" beside a button reading
                        "Add key" said the same thing twice — and at 390px the
                        pair did not fit, so the row wrapped to a second line and
                        measured 114px against its neighbours' 70 (measured). The
                        button's own label distinguishes the two cases: a key row
                        asks for a key, a grant row asks for a sign-in.
                      */}
                      {(entry.authMode !== 'oauth' || entry.oauthAvailability === 'ready') && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="ms-auto"
                          onClick={() => openKeyForm(entry.service, row)}
                        >
                          {row.authMode === 'oauth' ? (
                            <Link2 className="h-4 w-4" />
                          ) : (
                            <RotateCw className="h-4 w-4" />
                          )}
                          <span className="ms-1">
                            {row.authMode === 'oauth'
                              ? t('connectorsSettings.oauthLink')
                              : t('connectorsSettings.addKey')}
                          </span>
                        </Button>
                      )}
                      {deleteControl(row)}
                    </div>
                  ),
                )}
              </div>
            )}

            {/* CONNECTED, not merely added: every row down here has a credential
                the engines can actually use, so the heading is the honest one
                (owner request, 2026-08-07). */}
            {configuredRows.length > 0 && (
              <div className="space-y-3">
                <h3 className="flex items-center gap-2 text-sm font-medium">
                  {t('connectorsSettings.connected')}
                  {/* A refresh after an add or a delete says so here instead of
                      blanking the list — the page stays readable and still
                      admits it is working. */}
                  {fetching && (
                    <Loader2
                      aria-label={t('connectorsSettings.loading')}
                      className="h-3.5 w-3.5 animate-spin text-muted-foreground"
                    />
                  )}
                </h3>
                {configuredRows.map((connector) => {
                  const isOpen = expanded[connector.id] ?? false;
                  const catalogEntry = catalog.find((entry) => entry.service === connector.service);
                  const connectorOAuthUnavailable = connector.authMode === 'oauth' &&
                    catalogEntry?.oauthAvailability !== 'ready';
                  const placement = placementPresentation(
                    connector.placementStatus ?? 'untracked',
                    connector.availableNextSession === true,
                  );
                  return (
                  <div key={connector.id} className="min-w-0 max-w-full space-y-3 overflow-hidden rounded-lg border border-border px-3 py-1.5">
                    <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
                      {/*
                        The whole header is the toggle, not a lone chevron: on a
                        tablet a 16px arrow is a miss waiting to happen, and the
                        row's name is the thing a thumb aims at anyway. The badges
                        stay INSIDE it so the state a member came to check —
                        linked, no key, shared — is readable while collapsed.
                      */}
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() =>
                          setExpanded((prev) => ({ ...prev, [connector.id]: !isOpen }))
                        }
                        className="flex flex-1 flex-wrap items-center gap-2 rounded-sm text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {/* State rides on the NAME's line (owner request,
                            2026-08-06). Every badge carries `shrink-0` so a long
                            platform name pushes them to the next line rather than
                            crushing one into a circle — the failure this layout
                            produced before. */}
                        <ChevronDown
                          aria-hidden="true"
                          className={cn(
                            'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
                            isOpen && 'rotate-180',
                          )}
                        />
                        <PlatformLogo
                          entry={catalogEntry}
                          fallbackName={platformText(connector, 'displayName')}
                        />
                        {/* dir=auto on the NAME only. A Latin platform name in
                            an RTL row truncated from its START ("…uence)"),
                            because the ellipsis lands at the line's logical end
                            and the paragraph's base direction is Arabic. Letting
                            this one span take its direction from its own first
                            strong character puts the ellipsis back where the
                            reader expects it — for "Atlassian (Jira & …" and for
                            "سلة (Salla)" alike. Scoped to a short standalone name:
                            the B-207 lesson forbids dir=auto on message BODIES,
                            not on a label. */}
                        <span
                          dir="auto"
                          className="min-w-0 truncate font-medium"
                          title={platformText(connector, 'displayName')}
                        >
                          {platformText(connector, 'displayName')}
                        </span>
                        <span
                          dir="auto"
                          className="min-w-0 truncate text-[13px] text-muted-foreground"
                          title={connector.accountLabel || t('connectorsSettings.defaultAccount')}
                        >
                          {connector.accountLabel || t('connectorsSettings.defaultAccount')}
                        </span>
                        {/*
                          STATE AS TEXT, not as three filled pills (owner request,
                          2026-08-06): the pills were wider than the name they
                          annotated. Colour still carries the tone, and a leading
                          dot keeps the distinction off colour alone (WCAG 1.4.1).
                          The operator-key case outranks the row's own mode: a key
                          from the install's environment reaches every member
                          however the row was created, so "Mine only" would lie.
                        */}
                        <span className="shrink-0 text-[13px] leading-relaxed text-muted-foreground">
                          <StateText
                            tone="success"
                            label={t('connectorsSettings.accountLinked')}
                          />
                        </span>
                        <span className="shrink-0 text-[13px] leading-relaxed text-muted-foreground">
                          <StateText
                            tone={placement.tone}
                            label={t(`connectorsSettings.placement.${placement.key}`, {
                              defaultValue: PLACEMENT_LABELS[placement.key],
                            })}
                          />
                        </span>
                        {/* No "no key" / "not linked" badge here any more: a row
                            in this list HAS its credential, or it would still be
                            a tile in the grid above. */}
                      </button>

                      {/* gap-3, not gap-1: two controls a few pixels apart is a
                          mis-tap away from losing a stored credential, and this
                          page is read by thumb as often as by pointer. */}
                      <div className="flex items-center gap-3">
                        {configuredRows.find((row) => row.service === connector.service)?.id ===
                          connector.id &&
                          catalogEntry && !connectorOAuthUnavailable && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openKeyForm(connector.service, null, connector.id)}
                          >
                            <Plus className="h-4 w-4" />
                            <span className="ms-1">
                              {t('connectorsSettings.addAccount')}
                            </span>
                          </Button>
                        )}
                        {deleteControl(connector)}
                      </div>
                    </div>

                    {/*
                      SAID OUT LOUD, NOT IMPLIED BY A BADGE. A shared key is spent
                      by everyone and every action taken with it is attributed to
                      whoever owns the account at the platform. A member deserves
                      that sentence on the card, not an inference from an icon
                      (owner request, 2026-08-05).
                    */}
                    {/* Deliberately OUTSIDE the collapsible: the settings surface
                        language forbids folding a warning that reports a live
                        state. "Everyone on this install spends this key" is not
                        an explanation a member reads once — it is true right now,
                        collapsed or not. */}
                    {(connector.credentialSource === 'operator_env' ||
                      connector.credentialMode === 'org_shared') && (
                      <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-[13px] leading-relaxed text-warning">
                        <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                          {connector.credentialSource === 'operator_env'
                            ? t('connectorsSettings.operatorKeyWarning')
                            : t('connectorsSettings.sharedKeyWarning')}
                        </span>
                      </p>
                    )}

                    {connector.availableNextSession !== true && <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-md bg-muted p-2 text-[13px] leading-relaxed">
                      <span className="font-medium text-foreground">
                        {t('connectorsSettings.toolsByEngine')}
                      </span>
                      {(connector.targets ?? []).map((target) => {
                        const targetState = targetPresentation(target);
                        return (
                          <span key={target.provider} className="inline-flex items-center gap-1.5">
                            <span>{t(`connectorsSettings.target.${target.provider}`, {
                              defaultValue: target.provider === 'claude' ? 'Claude' : 'Codex',
                            })}</span>
                            <StateText
                              tone={targetState.tone}
                              label={t(`connectorsSettings.targetState.${targetState.key}`, {
                                defaultValue: TARGET_STATE_LABELS[targetState.key],
                              })}
                            />
                          </span>
                        );
                      })}
                      {connector.retryAvailable === true && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="ms-auto"
                          aria-busy={busyId === connector.id}
                          disabled={busyId === connector.id}
                          onClick={() => void retryPlacement(connector)}
                        >
                          {busyId === connector.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RotateCw className="h-4 w-4" />
                          )}
                          <span className="ms-1">{t('connectorsSettings.retryPlacement')}</span>
                        </Button>
                      )}
                    </div>}

                    <p className={cn(
                      'flex items-start gap-2 rounded-md p-2 text-[13px] leading-relaxed',
                      connector.availableNextSession === true
                        ? 'bg-muted text-muted-foreground'
                        : 'border border-warning/30 bg-warning/10 text-warning',
                    )}>
                      {connector.availableNextSession === true ? (
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                      ) : (
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      )}
                      <span>
                        {connector.availableNextSession === true
                          ? t('connectorsSettings.availableNextSessionNote')
                          : t(`connectorsSettings.placementNote.${placement.key}`, {
                            defaultValue: PLACEMENT_NOTES[placement.key],
                          })}
                      </span>
                    </p>

                    {picking?.rowId === null && picking.anchorId === connector.id ? (
                      keyForm
                    ) : isOpen && connector.credentialMode === 'org_shared' ? (
                      <p className="text-[13px] leading-relaxed text-muted-foreground">
                        {t('connectorsSettings.legacySharedReadOnly')}
                      </p>
                    ) : isOpen && (connector.authMode === 'oauth' ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <p className="text-[13px] leading-relaxed text-muted-foreground">
                          {t('connectorsSettings.oauthLinked')}
                        </p>
                        {/* Re-linking is all a connected OAuth row can offer: the
                            FIRST link happened in the grid, which is where a
                            platform waits until its grant comes back. */}
                        <Button
                          size="sm"
                          variant="outline"
                          aria-disabled={connectorOAuthUnavailable || busyId === connector.id || undefined}
                          aria-describedby={connectorOAuthUnavailable ? `connector-${connector.id}-oauth-unavailable` : undefined}
                          onClick={() => {
                            if (connectorOAuthUnavailable || busyId === connector.id) return;
                            void startOAuth(connector.id);
                          }}
                        >
                          {busyId === connector.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Link2 className="h-4 w-4" />
                          )}
                          <span className="ms-1">{t('connectorsSettings.oauthRelink')}</span>
                        </Button>
                      </div>
                    ) : picking?.rowId === connector.id ? (
                      /* THE SAME FORM, mounted in the card that owns it (owner
                         request, 2026-08-07). Rotating used to send the member to
                         a box elsewhere on the page; now the button opens the
                         form where the button is. */
                      keyForm
                    ) : (
                      <div className="flex flex-wrap items-center gap-3">
                        <p className="text-[13px] leading-relaxed text-muted-foreground">
                          {t('connectorsSettings.keyStoredNote')}
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openKeyForm(connector.service, connector)}
                        >
                          <RotateCw className="h-4 w-4" />
                          <span className="ms-1">{t('connectorsSettings.rotate')}</span>
                        </Button>
                      </div>
                    ))}
                  </div>
                  );
                })}
              </div>
            )}

            {targets.length > 0 && (
              <div className="border-t border-border pt-4 text-sm">
                {/* Folded, not deleted: which engines a key reaches is worth
                    reading once and never again (owner request, 2026-08-06). */}
                <SettingsCollapsible summary={t('connectorsSettings.whereTheyWork')}>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  {t('connectorsSettings.personalWorksWith', { list: formatList(perMember) })}
                </p>
                {shared.length > 0 && (
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    {t('connectorsSettings.sharedOnlyWorksWith', { list: formatList(shared) })}
                  </p>
                )}
                <div className="flex items-start gap-2 pt-1">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    {t('connectorsSettings.unsupportedNote')}
                  </p>
                </div>
                </SettingsCollapsible>
              </div>
            )}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

/**
 * M1 is selected when the server advertises the portable auth contract, even
 * when every exact provider/service/operation is currently unavailable. The
 * previous readiness-based switch created a circular gate: the owner needed
 * the M1 installation wizard to import trust/certification data, but the
 * wizard disappeared precisely while no certification was active. Missing
 * `authMetadata` still identifies a legacy/mixed-version server and preserves
 * its original surface without touching M1 routes.
 */
export default function ConnectorsSettingsTab() {
  const { catalog } = useConnectorsSnapshot();
  const m1Enabled = catalog.some(entry => Boolean(entry.authMetadata));
  return m1Enabled ? <ConnectorsSettingsTabM1 /> : <LegacyConnectorsSettingsTab />;
}

/**
 * A platform's mark, or its initial when none is bundled. The letter fallback is
 * deliberate rather than an empty slot: a row with no mark at all reads as a
 * failed image, while an initial reads as "this one has no logo".
 */
function PlatformLogo({
  entry,
  fallbackName,
}: {
  entry?: { logo?: string; logoExt?: 'svg' | 'png'; displayName: string };
  fallbackName?: string;
}) {
  const name = entry?.displayName ?? fallbackName ?? '?';

  /**
   * ONE RULE FOR EVERY MARK (owner request, 2026-08-06: "use one theme for the
   * logos… why the randomness? unify them, and colour is preferred").
   *
   * Every logo is a full-colour image on a fixed white chip. No theme-following
   * variant, no per-platform flag — the flag was the randomness: whichever file
   * happened to ship as a monochrome path followed the text colour while its
   * neighbour kept its brand colours, so Drive was colourful beside a white
   * Gmail. White because every brand identity is designed against white, which
   * makes the chip correct in both themes at once; a mark that is black by
   * nature (GitHub, Notion) simply reads black on white, and that is a decision
   * rather than an accident.
   *
   * Adding a platform later needs a colour SVG and a `logo` line. Nothing else.
   */
  const CHIP = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg';

  if (entry?.logo) {
    return (
      <span className={cn(CHIP, 'bg-white ring-1 ring-black/5 dark:ring-white/10')}>
        <img
          src={staticAssetUrl(`/connector-logos/${entry.logo}.${entry.logoExt ?? 'svg'}`)}
          alt=""
          aria-hidden="true"
          className="h-5 w-5 object-contain"
          loading="lazy"
        />
      </span>
    );
  }

  // No mark at all: a FILLED neutral chip at the same size, so "this one has no
  // logo yet" is legible as a state rather than read as a broken image.
  return (
    <span
      aria-hidden="true"
      className={cn(CHIP, 'bg-muted text-sm font-semibold text-muted-foreground')}
    >
      {name.trim().charAt(0).toLocaleUpperCase()}
    </span>
  );
}

/** State as a coloured word with a leading dot — no surface, no box. */
function StateText({ tone, label }: { tone: 'success' | 'warning' | 'danger'; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1',
        tone === 'success' && 'text-success',
        tone === 'warning' && 'text-warning',
        tone === 'danger' && 'text-danger',
      )}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {label}
    </span>
  );
}

/**
 * One half of the scope control.
 *
 * A tick, not a hue, marks the answer: a border that changes colour is the
 * whole distinction gone for a reader who cannot separate those colours
 * (WCAG 1.4.1). Height 28 inside a 4px-padded track makes the pair 36 — the
 * same as every button on this page.
 */
function ScopeChoice({
  active,
  label,
  blocked,
  onSelect,
}: {
  active: boolean;
  label: string;
  blocked?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-disabled={blocked || undefined}
      tabIndex={active ? 0 : -1}
      onClick={() => {
        if (!blocked) onSelect();
      }}
      className={cn(
        'flex h-7 items-center justify-center gap-1 rounded-sm px-2 text-[13px] font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
        blocked ? 'cursor-not-allowed opacity-60' : 'hover:text-foreground',
      )}
    >
      {active && <Check className="h-3.5 w-3.5 shrink-0" />}
      <span className="truncate">{label}</span>
    </button>
  );
}
