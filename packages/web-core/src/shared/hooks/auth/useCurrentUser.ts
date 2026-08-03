import { LOCAL_USER_ID } from '@/shared/providers/auth/LocalAuthProvider';

export function useCurrentUser() {
  return {
    data: { user_id: LOCAL_USER_ID },
    isLoading: false,
  };
}
