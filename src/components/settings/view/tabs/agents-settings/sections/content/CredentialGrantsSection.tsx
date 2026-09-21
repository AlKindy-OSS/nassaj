import { AlertTriangle, Loader2, Share2, UserRound, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../../../../../auth';
import SettingsCard from '../../../../SettingsCard';
import SettingsGroup from '../../../../SettingsGroup';
import SettingsSection from '../../../../SettingsSection';
import {
  agentToGrantProvider,
  useCredentialGrants,
  type GrantMember,
  type GrantProvider,
} from '../../../../../hooks/useCredentialGrants';
import type { AgentProvider } from '../../../../../types/types';

type CredentialGrantsSectionProps = {
  agent: AgentProvider;
};

/**
 * Credential sharing for ONE provider, on that provider's own Account tab
 * (T-1675 / ADR-152). Isolation is the base; every member decides for THEIR OWN
 * credential.
 *
 *   • "Shared with you" (only when someone offered me theirs): a radio between
 *     my own credential and each offered one, plus a one-line note while an
 *     offered one is in use.
 *   • "Your credential": a combobox field — click or type to list the other
 *     members, pick one to add — with the members it is shared with as
 *     removable chips beneath it. Adding and removing apply at once (owner
 *     decision 2026-09-10: no extra step).
 *
 * Saves on change; the server answers with the fresh picture.
 */
export default function CredentialGrantsSection({ agent }: CredentialGrantsSectionProps) {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const provider = agentToGrantProvider(agent);
  const { overview, loading, saving, error, setGrantees, selectGrant } =
    useCredentialGrants(provider !== null && Boolean(user));
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // Close the list on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!provider || !user) {
    return null;
  }

  const given = overview.given.filter((g) => g.provider === provider);
  const received = overview.received.filter((g) => g.provider === provider);
  const grantedIds = new Set(given.map((g) => g.userId));
  const inUse = received.find((g) => g.inUse) ?? null;
  const busy = loading || saving;
  const pairedNote = provider === 'gemini';

  const candidates = overview.members.filter(
    (m) => !grantedIds.has(m.id) && m.username.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const applyGrantees = (next: Set<number>) => {
    void setGrantees(provider as GrantProvider, [...next]);
  };
  const remove = (userId: number) => {
    const next = new Set(grantedIds);
    next.delete(userId);
    applyGrantees(next);
  };
  const pick = (member: GrantMember) => {
    setOpen(false);
    setQuery('');
    const next = new Set(grantedIds);
    next.add(member.id);
    applyGrantees(next);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(candidates.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter' && open && candidates[active]) {
      event.preventDefault();
      pick(candidates[active]);
    } else if (event.key === 'Escape') {
      // preventDefault propagates to the native event so Settings' document handler
      // sees defaultPrevented=true and does not close the whole Settings panel.
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <SettingsSection title={t('credentialGrants.heading')} icon={Share2} level="section">
      {/* `space-y-4` بين كتلتَي القسم — نفس الإيقاع الذي تفصل به بطاقةُ الاتصال
          كتلَها (‏T-1700)، بدل `space-y-5` التي كانت تفرد هذا القسم وحده. */}
      <div className="space-y-4" aria-busy={saving}>
        {received.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-[15px] font-medium leading-relaxed text-foreground">
              {t('credentialGrants.received.title')}
            </legend>
            {inUse && (
              <SettingsCard tone="warning">
                <div className="flex items-start gap-2 text-[13px] leading-relaxed text-warning">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  <p>{t('credentialGrants.received.inUse', { owner: inUse.ownerUsername })}</p>
                </div>
              </SettingsCard>
            )}
            <SettingsGroup as="ul">
              <li>
                <label className="flex min-h-10 cursor-pointer items-center gap-3 py-2 text-sm text-foreground">
                  <input
                    type="radio"
                    name={`credential-grant-use-${provider}`}
                    className="h-4 w-4"
                    checked={inUse === null}
                    disabled={busy}
                    onChange={() => { void selectGrant(provider as GrantProvider, null); }}
                  />
                  <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span>{t('credentialGrants.received.ownOption')}</span>
                </label>
              </li>
              {received.map((grant) => (
                <li key={grant.ownerUserId}>
                  <label className="flex min-h-10 cursor-pointer items-center gap-3 py-2 text-sm text-foreground">
                    <input
                      type="radio"
                      name={`credential-grant-use-${provider}`}
                      className="h-4 w-4"
                      checked={grant.inUse}
                      disabled={busy}
                      onChange={() => { void selectGrant(provider as GrantProvider, grant.ownerUserId); }}
                    />
                    <Share2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span>{t('credentialGrants.received.grantOption', { owner: grant.ownerUsername })}</span>
                  </label>
                </li>
              ))}
            </SettingsGroup>
          </fieldset>
        )}

        <div className="space-y-2" ref={rootRef}>
          <div className="flex items-center gap-2">
            <p id={`${listId}-label`} className="text-[15px] font-medium leading-relaxed text-foreground">
              {t('credentialGrants.given.title')}
            </p>
            {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
          </div>
          {pairedNote && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">{t('credentialGrants.given.pairedNote')}</p>
          )}

          <div className="relative">
            <input
              type="text"
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-labelledby={`${listId}-label`}
              aria-autocomplete="list"
              aria-activedescendant={open && candidates[active] ? `${listId}-${candidates[active].id}` : undefined}
              placeholder={overview.members.length === 0 && !loading
                ? t('credentialGrants.given.noMembers')
                : t('credentialGrants.given.placeholder')}
              value={query}
              disabled={busy || overview.members.length === 0}
              onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); }}
              onFocus={() => setOpen(true)}
              onClick={() => setOpen(true)}
              onKeyDown={onKeyDown}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            />
            {open && (
              <ul
                id={listId}
                role="listbox"
                className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md"
              >
                {candidates.length === 0 ? (
                  <li className="px-2 py-1.5 text-sm text-muted-foreground">{t('credentialGrants.given.noMatch')}</li>
                ) : candidates.map((member, index) => (
                  <li
                    key={member.id}
                    id={`${listId}-${member.id}`}
                    role="option"
                    aria-selected={index === active}
                    className={`cursor-pointer rounded px-2 py-1.5 text-sm text-foreground ${index === active ? 'bg-accent' : 'hover:bg-accent'}`}
                    onMouseDown={(event) => { event.preventDefault(); pick(member); }}
                    onMouseEnter={() => setActive(index)}
                  >
                    {member.username}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {given.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label={t('credentialGrants.given.title')}>
              {given.map((grant) => (
                <li
                  key={grant.userId}
                  className="flex items-center gap-1 rounded border border-border bg-muted py-0.5 pe-0.5 ps-2 text-[13px] leading-5 text-foreground"
                >
                  <span>{grant.username}</span>
                  {grant.declined && (
                    <span className="text-[11px] text-muted-foreground">{t('credentialGrants.given.declined')}</span>
                  )}
                  <button
                    type="button"
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                    aria-label={t('credentialGrants.given.remove', { member: grant.username })}
                    disabled={busy}
                    onClick={() => remove(grant.userId)}
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}

        </div>

        {error && (
          <p role="alert" className="text-[13px] leading-relaxed text-danger">{error}</p>
        )}
      </div>
    </SettingsSection>
  );
}
