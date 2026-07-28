import { useCallback, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

const MIN_USERNAME_LENGTH = 3;
const MIN_PASSWORD_LENGTH = 8;

type JoinFormState = {
  username: string;
  password: string;
  confirmPassword: string;
};

const initialState: JoinFormState = {
  username: '',
  password: '',
  confirmPassword: '',
};

/**
 * Invite acceptance page (`/join?token=...`).
 *
 * Public route (renders outside the auth gate). Collects a username and
 * password for the invited account, accepts the invite, and — on success —
 * signs the user in and routes to the app. The invite role is fixed server-side
 * by the invite itself, so it is never chosen here.
 */
export default function JoinPage() {
  const { t } = useTranslation('auth');
  const { acceptInvite } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const token = useMemo(() => searchParams.get('token') ?? '', [searchParams]);

  const [formState, setFormState] = useState<JoinFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = useCallback((field: keyof JoinFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      const username = formState.username.trim();

      if (username.length < MIN_USERNAME_LENGTH) {
        setErrorMessage(t('join.errors.shortUsername', { min: MIN_USERNAME_LENGTH }));
        return;
      }
      if (formState.password.length < MIN_PASSWORD_LENGTH) {
        setErrorMessage(t('join.errors.shortPassword', { min: MIN_PASSWORD_LENGTH }));
        return;
      }
      if (formState.password !== formState.confirmPassword) {
        setErrorMessage(t('join.errors.passwordMismatch'));
        return;
      }

      setIsSubmitting(true);
      const result = await acceptInvite(token, username, formState.password);
      if (!result.success) {
        setErrorMessage(result.error);
        setIsSubmitting(false);
        return;
      }
      // Authenticated in-context; route into the app shell.
      navigate('/', { replace: true });
    },
    [acceptInvite, formState.confirmPassword, formState.password, formState.username, navigate, t, token],
  );

  // Guard: a missing token means the link is malformed — show a clear message
  // instead of letting the user fill a form that can never succeed.
  if (!token) {
    return (
      <AuthScreenLayout
        title={t('join.title')}
        description={t('join.invalidLink')}
        footerText={t('join.footer')}
      >
        <AuthErrorAlert errorMessage={t('join.errors.missingToken')} />
      </AuthScreenLayout>
    );
  }

  return (
    <AuthScreenLayout
      title={t('join.title')}
      description={t('join.description')}
      footerText={t('join.footer')}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="join-username"
          label={t('join.username')}
          value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('join.placeholders.username')}
          isDisabled={isSubmitting}
          autoComplete="username"
        />

        <AuthInputField
          id="join-password"
          label={t('join.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('join.placeholders.password')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
        />

        <AuthInputField
          id="join-confirm-password"
          label={t('join.confirmPassword')}
          value={formState.confirmPassword}
          onChange={(value) => updateField('confirmPassword', value)}
          placeholder={t('join.placeholders.confirmPassword')}
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
          {isSubmitting ? t('join.loading') : t('join.submit')}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
