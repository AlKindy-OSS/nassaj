import { Check, ChevronDown, ChevronUp, CircleAlert, Loader2, LogOut, Plus, Settings, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { TFunction } from 'i18next';

import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import {
  beginIdentityTransition,
  cancelIdentityTransition,
  lockIdentityBarrier,
} from '../../../auth/accountIdentityBarrier';
import { hasPendingAccountWork } from '../../../auth/accountIdentityIsolation';
import {
  AccountWalletError,
  finishWalletIdentityTransition,
  isAccountWallet,
  type AccountWallet,
  type DeviceAccount,
  mutateAccountWallet,
  readAccountWallet,
} from '../../../auth/accountWalletClient';

import { staticAssetUrl } from '@/lib/static-asset-url';

type CurrentAccount = { displayName: string; avatarUrl?: string; secondary: string };
type WalletMutationResult = { generation: number; activeSlotId: string | null };
type AccountSwitcherProps = {
  current: CurrentAccount;
  t: TFunction;
  onShowSettings: () => void;
  onLegacyLogout: () => void;
};

const initialsFor = (name: string) => Array.from(name.trim()).slice(0, 2).join('').toLocaleUpperCase();

function Avatar({ account, size = 'h-8 w-8' }: { account: Pick<DeviceAccount, 'displayName' | 'avatarUrl'>; size?: string }) {
  const [failed, setFailed] = useState(false);
  if (account.avatarUrl && !failed) {
    return <img className={cn(size, 'shrink-0 rounded-full object-cover')} src={staticAssetUrl(account.avatarUrl)} alt="" onError={() => setFailed(true)} />;
  }
  return <span className={cn(size, 'flex shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-foreground')} aria-hidden>{initialsFor(account.displayName)}</span>;
}

const walletError = (error: unknown) => error instanceof AccountWalletError ? error.code : 'account_wallet_unavailable';
const isConflict = (error: unknown) => error instanceof AccountWalletError && error.status === 409;

/** Cookie-backed, keyboard-operable device account switcher. */
export default function AccountSwitcher({ current, t, onShowSettings, onLegacyLogout }: AccountSwitcherProps) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [wallet, setWallet] = useState<AccountWallet | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [pendingSwitch, setPendingSwitch] = useState<DeviceAccount | null>(null);
  const [removeTarget, setRemoveTarget] = useState<DeviceAccount | null>(null);
  const [manageOpen, setManageOpen] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true); setError(null);
    try {
      setWallet(await readAccountWallet(controller.signal));
    } catch (caught) {
      if (!controller.signal.aborted) setError(walletError(caught));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => { if (open) void load(); }, [load, open]);
  useEffect(() => {
    if (!open || loading) return;
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[data-account-control]:not([disabled])')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [loading, open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) close();
    };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [close, open]);

  const accounts = wallet?.accounts ?? [];
  const active = accounts.find((account) => account.slotId === wallet?.activeSlotId) ?? accounts.find((account) => account.isActive);
  const display = active ? { displayName: active.displayName, avatarUrl: active.avatarUrl, secondary: t('account.active') } : current;

  const recover = async (caught: unknown, transitionVersion: string, previousActiveSlotId: string | null) => {
    if (isConflict(caught) || (caught instanceof AccountWalletError && caught.outcomeUnknown)) {
      const errorWallet = caught instanceof AccountWalletError ? caught.wallet : undefined;
      try {
        const refreshed = isAccountWallet(errorWallet) ? errorWallet : await readAccountWallet(undefined, true);
        setWallet(refreshed);
        finishWalletIdentityTransition(
          transitionVersion,
          previousActiveSlotId,
          refreshed.activeSlotId,
          'active_identity_conflict',
        );
      } catch {
        lockIdentityBarrier(transitionVersion, 'identity_reconciliation_failed');
        setError('account_wallet_unavailable');
        return;
      }
      setAnnouncement(t('account.conflictRecovered'));
    } else {
      cancelIdentityTransition(transitionVersion);
    }
    setError(walletError(caught));
  };

  const switchTo = async (account: DeviceAccount) => {
    if (!wallet || account.slotId === wallet.activeSlotId || busy) return;
    const transitionVersion = beginIdentityTransition('switch');
    setBusy(account.slotId); setError(null);
    try {
      const next = await mutateAccountWallet<WalletMutationResult>('/api/auth/accounts/switch', 'POST', 'switch', {
        slotId: account.slotId, expectedGeneration: wallet.generation,
      }, { identityBypass: true });
      setAnnouncement(t('account.switched', { name: account.displayName }));
      finishWalletIdentityTransition(transitionVersion, wallet.activeSlotId, next.activeSlotId, 'switch');
    } catch (caught) { await recover(caught, transitionVersion, wallet.activeSlotId); }
    finally { setBusy(null); }
  };

  const requestSwitch = (account: DeviceAccount) => {
    if (account.slotId === wallet?.activeSlotId || busy) return;
    if (hasPendingAccountWork()) {
      setPendingSwitch(account);
      return;
    }
    void switchTo(account);
  };

  const addAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (!wallet || busy || !addEmail.trim() || !addPassword) return;
    const transitionVersion = beginIdentityTransition('add');
    setBusy('add'); setError(null);
    try {
      const next = await mutateAccountWallet<AccountWallet>('/api/auth/accounts/add', 'POST', 'add', {
        email: addEmail.trim(), password: addPassword, expectedGeneration: wallet.generation,
      }, { identityBypass: true });
      if (!isAccountWallet(next)) {
        throw new AccountWalletError('wallet_mutation_outcome_unknown', 0, undefined, true);
      }
      setWallet(next);
      setAddOpen(false); setAddEmail(''); setAddPassword('');
      setAnnouncement(t('account.added'));
      finishWalletIdentityTransition(transitionVersion, wallet.activeSlotId, next.activeSlotId, 'add');
    } catch (caught) { await recover(caught, transitionVersion, wallet.activeSlotId); }
    finally { setAddPassword(''); setBusy(null); }
  };

  const remove = async () => {
    if (!wallet || !removeTarget || busy) return;
    const transitionVersion = beginIdentityTransition('remove');
    setBusy(removeTarget.slotId); setError(null);
    try {
      const next = await mutateAccountWallet<AccountWallet>(`/api/auth/accounts/${encodeURIComponent(removeTarget.slotId)}`, 'DELETE', 'remove', {
        expectedGeneration: wallet.generation,
      }, { slotId: removeTarget.slotId, identityBypass: true });
      if (!isAccountWallet(next)) {
        throw new AccountWalletError('wallet_mutation_outcome_unknown', 0, undefined, true);
      }
      setWallet(next); setRemoveTarget(null); setAnnouncement(t('account.removed'));
      finishWalletIdentityTransition(transitionVersion, wallet.activeSlotId, next.activeSlotId, 'remove');
    } catch (caught) { await recover(caught, transitionVersion, wallet.activeSlotId); }
    finally { setBusy(null); }
  };

  const signOut = async () => {
    if (!wallet || busy) return;
    const transitionVersion = beginIdentityTransition('logout');
    setBusy('logout'); setError(null);
    try {
      const next = await mutateAccountWallet<WalletMutationResult>('/api/auth/logout', 'POST', 'logout', { expectedGeneration: wallet.generation }, { identityBypass: true });
      finishWalletIdentityTransition(transitionVersion, wallet.activeSlotId, next.activeSlotId, 'logout');
    } catch (caught) { await recover(caught, transitionVersion, wallet.activeSlotId); }
    finally { setBusy(null); }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const controls = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-account-control]:not([disabled])') ?? []);
    const index = controls.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (!controls.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
    controls[next]?.focus();
  };

  return <>
    <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    <div className="relative">
      <button ref={triggerRef} type="button" onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault(); setOpen(true);
        }}
        className="flex min-h-[var(--control-height-touch)] w-full items-center gap-3 rounded-xl bg-muted/40 px-3 text-start transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={t('account.switcherLabel', { name: display.displayName })} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}>
        <Avatar account={display} />
        <span className="min-w-0 flex-1"><bdi className="block truncate text-sm font-medium text-foreground">{display.displayName}</bdi><span className="block truncate text-xs text-muted-foreground">{display.secondary}</span></span>
        {open ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronUp className="h-4 w-4 shrink-0" aria-hidden />}
      </button>
      {open && <div ref={menuRef} id={menuId} role="menu" aria-label={t('account.deviceAccounts')} onKeyDown={onMenuKeyDown}
        className="absolute bottom-[calc(100%+0.5rem)] start-0 z-50 w-[min(22.5rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl max-md:fixed max-md:inset-x-4 max-md:bottom-4 max-md:max-h-[calc(100dvh-2rem)] max-md:w-auto">
        <div className="px-3 py-2 text-sm font-semibold">{t('account.deviceAccounts')}</div>
        {error && <p role="alert" className="mx-2 mb-1 flex items-center gap-2 rounded-md bg-destructive/10 px-2 py-2 text-xs text-danger"><CircleAlert className="h-4 w-4 shrink-0" aria-hidden />{t(`account.errors.${error}`, { defaultValue: t('account.errors.unavailable') })}</p>}
        {loading ? <div className="flex min-h-[var(--control-height-touch)] items-center gap-2 px-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />{t('account.loading')}</div>
          : accounts.length === 0 ? <p className="px-3 py-2 text-sm text-muted-foreground">{t('account.unavailable')}</p>
          : <div className="max-h-72 overflow-y-auto">{accounts.map((account) => <button key={account.slotId} data-account-control type="button" role="menuitem" disabled={Boolean(busy)} onClick={() => requestSwitch(account)}
            className={cn('flex min-h-[var(--control-height-touch)] w-full items-center gap-3 rounded-lg px-2 py-2 text-start hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1', account.slotId === wallet?.activeSlotId && 'bg-muted')}
            aria-label={`${account.displayName}, ${account.slotId === wallet?.activeSlotId ? t('account.active') : t('account.available')}`}>
            <Avatar account={account} size="h-7 w-7" /><span className="min-w-0 flex-1"><bdi className="block truncate text-sm font-medium">{account.displayName}</bdi><span className="block text-xs text-muted-foreground">{account.slotId === wallet?.activeSlotId ? t('account.active') : t('account.available')}</span></span>
            {busy === account.slotId ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-label={t('account.switching')} /> : account.slotId === wallet?.activeSlotId ? <Check className="h-4 w-4 shrink-0" aria-label={t('account.active')} /> : null}
          </button>)}</div>}
        <div className="my-1 h-px bg-border" />
        <button data-account-control type="button" role="menuitem" disabled={!wallet || Boolean(busy) || accounts.length >= 5} onClick={() => { close(); setAddOpen(true); }} className="flex min-h-[var(--control-height-touch)] w-full items-center gap-3 rounded-md px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"><Plus className="h-4 w-4" aria-hidden />{t('account.add')}</button>
        <button data-account-control type="button" role="menuitem" disabled={!wallet || Boolean(busy)} onClick={() => { close(); setManageOpen(true); }} className="flex min-h-[var(--control-height-touch)] w-full items-center gap-3 rounded-md px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">{t('account.manage')}</button>
        <button data-account-control type="button" role="menuitem" onClick={() => { close(); onShowSettings(); }} className="flex min-h-[var(--control-height-touch)] w-full items-center gap-3 rounded-md px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"><Settings className="h-4 w-4" aria-hidden />{t('actions.settings')}</button>
        <button data-account-control type="button" role="menuitem" disabled={Boolean(busy)} onClick={() => wallet ? void signOut() : onLegacyLogout()} className="flex min-h-[var(--control-height-touch)] w-full items-center gap-3 rounded-md px-3 text-sm font-medium text-danger hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"><LogOut className="h-4 w-4" aria-hidden />{t('actions.logout')}</button>
      </div>}
    </div>

    <Dialog open={addOpen} onOpenChange={(next) => { setAddOpen(next); if (!next) { setAddEmail(''); setAddPassword(''); } }}><DialogContent className="w-[calc(100vw-2rem)] max-w-sm p-0"><DialogTitle className="sr-only">{t('account.add')}</DialogTitle><form className="space-y-4 p-5" onSubmit={(event) => void addAccount(event)}><div><h2 className="text-lg font-semibold">{t('account.add')}</h2><p className="text-sm text-muted-foreground">{t('account.addDescription')}</p></div>{error && <p role="alert" className="text-sm text-danger">{t(`account.errors.${error}`, { defaultValue: t('account.errors.add_account_failed') })}</p>}<label className="block space-y-1.5 text-sm font-medium"><span>{t('account.email')}</span><Input type="email" value={addEmail} onChange={(event) => setAddEmail(event.target.value)} autoComplete="username" inputMode="email" required autoFocus /></label><label className="block space-y-1.5 text-sm font-medium"><span>{t('account.password')}</span><Input type="password" value={addPassword} onChange={(event) => setAddPassword(event.target.value)} autoComplete="current-password" required /></label><div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setAddOpen(false)}>{t('account.cancel')}</Button><Button type="submit" disabled={busy === 'add' || !addEmail.trim() || !addPassword}>{busy === 'add' ? t('account.adding') : t('account.add')}</Button></div></form></DialogContent></Dialog>

    <Dialog open={Boolean(pendingSwitch)} onOpenChange={(next) => { if (!next) setPendingSwitch(null); }}><DialogContent className="w-[calc(100vw-2rem)] max-w-sm p-0"><DialogTitle className="sr-only">{t('account.switchConfirmTitle')}</DialogTitle><div className="space-y-4 p-5"><div><h2 className="text-lg font-semibold">{t('account.switchConfirmTitle')}</h2><p className="text-sm text-muted-foreground">{t('account.switchConfirmDescription')}</p></div><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setPendingSwitch(null)}>{t('account.cancel')}</Button><Button onClick={() => { const target = pendingSwitch; setPendingSwitch(null); if (target) void switchTo(target); }}>{t('account.switchConfirm')}</Button></div></div></DialogContent></Dialog>

    <Dialog open={manageOpen} onOpenChange={setManageOpen}><DialogContent className="w-[calc(100vw-2rem)] max-w-md p-0"><DialogTitle className="sr-only">{t('account.manage')}</DialogTitle><div className="space-y-4 p-5"><div><h2 className="text-lg font-semibold">{t('account.manage')}</h2><p className="text-sm text-muted-foreground">{t('account.manageDescription')}</p></div><div className="space-y-2">{accounts.map((account) => <div key={account.slotId} className="flex min-h-[var(--control-height-touch)] items-center gap-3 rounded-lg border border-border px-3"><Avatar account={account} size="h-7 w-7" /><bdi className="min-w-0 flex-1 truncate text-sm font-medium">{account.displayName}</bdi>{account.slotId === wallet?.activeSlotId ? <span className="text-xs text-muted-foreground">{t('account.active')}</span> : <Button variant="ghost" size="sm" onClick={() => setRemoveTarget(account)}><Trash2 aria-hidden />{t('account.remove')}</Button>}</div>)}</div><div className="flex justify-end"><Button variant="outline" onClick={() => setManageOpen(false)}>{t('account.cancel')}</Button></div></div></DialogContent></Dialog>
    <Dialog open={Boolean(removeTarget)} onOpenChange={(next) => { if (!next) setRemoveTarget(null); }}><DialogContent className="w-[calc(100vw-2rem)] max-w-sm p-0"><DialogTitle className="sr-only">{t('account.remove')}</DialogTitle><div className="space-y-4 p-5"><div><h2 className="text-lg font-semibold">{t('account.remove')}</h2><p className="text-sm text-muted-foreground">{t('account.removeDescription', { name: removeTarget?.displayName })}</p></div><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setRemoveTarget(null)}>{t('account.cancel')}</Button><Button variant="destructive" disabled={Boolean(busy)} onClick={() => void remove()}>{t('account.remove')}</Button></div></div></DialogContent></Dialog>
  </>;
}
