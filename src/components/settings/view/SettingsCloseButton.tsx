import { X } from 'lucide-react';

import { Button } from '../../../shared/view/ui';

/** Icon-only close control with a required visible-to-AT name. */
export default function SettingsCloseButton({
  onClose,
  label,
}: {
  onClose: () => void;
  label: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      onClick={onClose}
      className="w-10 touch-manipulation p-0 text-muted-foreground hover:text-foreground active:bg-accent/50"
    >
      <X className="h-5 w-5" aria-hidden="true" />
    </Button>
  );
}
