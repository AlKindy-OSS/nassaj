import { useEffect, useState } from 'react';
import { Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';
import { useOptionalAuth } from '../auth/context/AuthContext';

import SessionShareDialog from './SessionShareDialog';
import { getShareEligibility, type ShareEligibility } from './sessionShareApi';

type Props = { sessionId: string };

/**
 * Header button opening the read-only share flow. Offered only when the server
 * says the viewer may share (canShare) or manage existing links (canManage:
 * session owner, platform owner or admin only; session write access is not
 * enough). Manage-only covers e.g. a session owner whose project is
 * unregistered. The answer is fetched once per session for the component's lifetime.
 */
export default function SessionShareButton({ sessionId }: Props) {
  const { t } = useTranslation('chat');
  const hasBearer = Boolean(useOptionalAuth()?.token);
  const [eligibility, setEligibility] = useState<ShareEligibility | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setEligibility(null);
    if (!hasBearer) return undefined;
    let cancelled = false;
    getShareEligibility(sessionId)
      .then((result) => { if (!cancelled) setEligibility(result); })
      .catch(() => { if (!cancelled) setEligibility(null); });
    return () => { cancelled = true; };
  }, [sessionId, hasBearer]);

  if (!hasBearer || !eligibility || !(eligibility.canShare || eligibility.canManage)) return null;
  const label = t('sessionShare.button');
  return (
    <>
      <Button
        type="button" variant="ghost" size="sm" aria-label={label} title={label}
        aria-haspopup="dialog" onClick={() => setOpen(true)}
        className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
      >
        <Share2 aria-hidden />
      </Button>
      {open && <SessionShareDialog sessionId={sessionId} canShare={eligibility.canShare} open onOpenChange={setOpen} />}
    </>
  );
}
