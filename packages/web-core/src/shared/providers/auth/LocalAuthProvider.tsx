import { useMemo, type ReactNode } from 'react';
import {
  AuthContext,
  type AuthContextValue,
} from '@/shared/hooks/auth/useAuth';
import { useUserSystem } from '@/shared/hooks/useUserSystem';

interface LocalAuthProviderProps {
  children: ReactNode;
}

/// Fixed id of the predefined local user. Must match the backend
/// `LOCAL_USER_ID` (`Uuid::from_u128(0xA002)`) so issue creator/assignee
/// references line up with `/v1/fallback/users`.
export const LOCAL_USER_ID = '00000000-0000-0000-0000-00000000a002';

export function LocalAuthProvider({ children }: LocalAuthProviderProps) {
  const { loginStatus } = useUserSystem();

  // The local build runs the kanban without any cloud account. Present a
  // predefined local user so the auth-gated shell (sign-in checks, providers)
  // works without login.
  const value = useMemo<AuthContextValue>(() => {
    if (loginStatus?.status === 'loggedin') {
      return {
        isSignedIn: true,
        isLoaded: true,
        userId: loginStatus.user_id ?? LOCAL_USER_ID,
      };
    }
    return { isSignedIn: true, isLoaded: true, userId: LOCAL_USER_ID };
  }, [loginStatus]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
