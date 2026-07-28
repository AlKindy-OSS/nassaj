import { CheckCircle2 } from 'lucide-react';

export type FeedbackKind = 'success' | 'error';
export type Feedback = { kind: FeedbackKind; message: string } | null;

/**
 * Inline success/error banner shared by the profile-settings sections
 * (avatar/username/password forms and the passkeys list).
 */
export default function FeedbackBanner({ feedback }: { feedback: Feedback }) {
  if (!feedback) {
    return null;
  }
  if (feedback.kind === 'success') {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-md border border-green-300 bg-green-100 p-3 dark:border-green-800 dark:bg-green-900/20"
      >
        <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-green-700 dark:text-green-400" />
        <p className="text-sm text-green-700 dark:text-green-400">{feedback.message}</p>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="rounded-md border border-red-300 bg-red-100 p-3 dark:border-red-800 dark:bg-red-900/20"
    >
      <p className="text-sm text-red-700 dark:text-red-400">{feedback.message}</p>
    </div>
  );
}
