import { useState } from 'react';
import type { TFunction } from 'i18next';

import { isClaudeSubscriptionToken } from '../../../../../../shared/claudeSubscriptionToken';
import type { ApiFailure } from '../../../../provider-auth/hooks/vendorKeyApi';
import type {
  CompanySlotResult,
  useCompanyKey,
} from '../../../../provider-auth/hooks/useCompanyKey';

type CompanyKey = ReturnType<typeof useCompanyKey>;

export type CardDialog = 'delete' | 'replace' | null;

/** The inline message for a refused request; the server's own text is the last resort. */
export function describeFailure(failure: ApiFailure, tokenDraft: boolean, t: TFunction<'settings'>): string {
  if (failure.code === 'VENDOR_DELETE_IS_VENDOR_WIDE') return t('vendors.link.error.vendorWide');
  if (failure.code === 'VENDOR_KEY_RATE_LIMITED' || failure.status === 429) {
    return t('vendors.link.error.rateLimited');
  }
  if (failure.code === 'VENDOR_MIGRATION_SOURCE_NOT_FOUND') return t('vendors.link.error.sourceNotFound');
  if (failure.status === 400 && tokenDraft) return t('vendors.link.error.subscriptionToken');
  return failure.message;
}

/**
 * Local interaction state of one vendor card: the draft, the last Save and
 * Delete results, the open dialog. Server state stays in `useCompanyKey`.
 * The draft is kept after a Save that met a foreign key, so the confirmed
 * replacement can re-send the same value without a second paste.
 */
export function useVendorCardActions(companyKey: CompanyKey, needsConsent: boolean) {
  const [draftKey, setDraftKey] = useState('');
  const [saveResults, setSaveResults] = useState<CompanySlotResult[] | null>(null);
  const [deleteResults, setDeleteResults] = useState<CompanySlotResult[] | null>(null);
  const [tokenDraft, setTokenDraft] = useState(false);
  const [consent, setConsent] = useState(false);
  const [dialog, setDialog] = useState<CardDialog>(null);

  const save = async (replaceForeignKey: boolean) => {
    setSaveResults(null);
    setDeleteResults(null);
    setTokenDraft(isClaudeSubscriptionToken(draftKey));
    const result = await companyKey.saveKey(draftKey, {
      ...(needsConsent ? { consent } : {}),
      ...(replaceForeignKey ? { replaceForeignKey: true } : {}),
    });
    setDialog(null);
    if (!result.success) return;
    setSaveResults(result.slots);
    if (!result.slots.some((slot) => slot.outcome === 'foreign_credential')) setDraftKey('');
    setConsent(false);
  };

  const remove = async (removeForeignKey: boolean) => {
    setSaveResults(null);
    setDeleteResults(null);
    const result = await companyKey.deleteKey(removeForeignKey);
    setDialog(null);
    if (result.success) setDeleteResults(result.slots);
  };

  return {
    draftKey, setDraftKey, saveResults, deleteResults, tokenDraft, consent, setConsent,
    dialog, setDialog, save, remove,
  };
}
