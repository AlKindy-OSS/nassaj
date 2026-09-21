import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { MIN_PASSWORD_LENGTH } from '../constants';
import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type FormState = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

const initialState: FormState = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
};

/**
 * Forced password-change gate (F-2).
 *
 * Rendered by ProtectedRoute when the server flagged the account for a forced
 * rotation after an admin reset. The screen cannot be dismissed; the only way
 * forward is a successful password change, which clears `mustChangePassword`
 * and persists the fresh token so the session continues without a logout.
 */
export default function ForceChangePasswordForm() {
  const { t } = useTranslation('auth');
  const { changePassword } = useAuth();

  const [formState, setFormState] = useState<FormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = useCallback((field: keyof FormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      if (!formState.currentPassword || !formState.newPassword || !formState.confirmPassword) {
        setErrorMessage(t('forceChangePassword.errors.requiredFields'));
        return;
      }
      if (formState.newPassword.length < MIN_PASSWORD_LENGTH) {
        setErrorMessage(t('forceChangePassword.errors.shortPassword', { min: MIN_PASSWORD_LENGTH }));
        return;
      }
      if (formState.newPassword !== formState.confirmPassword) {
        setErrorMessage(t('forceChangePassword.errors.passwordMismatch'));
        return;
      }

      setIsSubmitting(true);
      const result = await changePassword(formState.currentPassword, formState.newPassword);
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [changePassword, formState.confirmPassword, formState.currentPassword, formState.newPassword, t],
  );

  return (
    <AuthScreenLayout
      title={t('forceChangePassword.title')}
      description={t('forceChangePassword.description')}
      footerText={t('forceChangePassword.footer')}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="current-password"
          label={t('forceChangePassword.currentPassword')}
          value={formState.currentPassword}
          onChange={(value) => updateField('currentPassword', value)}
          placeholder={t('forceChangePassword.placeholders.currentPassword')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="current-password"
        />

        <AuthInputField
          id="new-password"
          label={t('forceChangePassword.newPassword')}
          value={formState.newPassword}
          onChange={(value) => updateField('newPassword', value)}
          placeholder={t('forceChangePassword.placeholders.newPassword')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
        />

        <AuthInputField
          id="confirm-password"
          label={t('forceChangePassword.confirmPassword')}
          value={formState.confirmPassword}
          onChange={(value) => updateField('confirmPassword', value)}
          placeholder={t('forceChangePassword.placeholders.confirmPassword')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
        />

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-md bg-blue-600 px-4 py-2 font-medium text-white transition-colors duration-200 hover:bg-blue-700 disabled:bg-blue-400"
        >
          {isSubmitting ? t('forceChangePassword.loading') : t('forceChangePassword.submit')}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
