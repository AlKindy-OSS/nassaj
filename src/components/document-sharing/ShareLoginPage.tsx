import { Navigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/context/AuthContext';
import LoginForm from '../auth/view/LoginForm';
import SetupForm from '../auth/view/SetupForm';
import ForceChangePasswordForm from '../auth/view/ForceChangePasswordForm';
import AuthLoadingScreen from '../auth/view/AuthLoadingScreen';

import { safeShareReturn } from './share-navigation';

/** Existing sign-in UI, followed by a validated internal destination exactly once. */
export default function ShareLoginPage() {
  const { user, isLoading, mustChangePassword, needsSetup } = useAuth();
  const [params] = useSearchParams();
  if (isLoading) return <AuthLoadingScreen />;
  if (needsSetup) return <SetupForm />;
  // A device (cookie) session has no bearer token; the user alone proves sign-in.
  if (!user) return <LoginForm />;
  if (mustChangePassword) return <ForceChangePasswordForm />;
  return <Navigate replace to={safeShareReturn(params.get('returnTo')) ?? '/'} />;
}
