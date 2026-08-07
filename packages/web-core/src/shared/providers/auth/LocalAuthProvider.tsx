import { useMemo, type ReactNode } from 'react';
import {
  AuthContext,
  type AuthContextValue,
} from '@/shared/hooks/auth/useAuth';

interface LocalAuthProviderProps {
  children: ReactNode;
}

/// Local-only auth gate. Always signed in (single-developer fork). The
/// `useAuth` consumer checks `isSignedIn` to gate app mount and provider
/// ordering; this trivial provider keeps that contract intact now that the
/// User entity has been excised (ADR-019).
export function LocalAuthProvider({ children }: LocalAuthProviderProps) {
  const value = useMemo<AuthContextValue>(
    () => ({ isSignedIn: true, isLoaded: true }),
    []
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
