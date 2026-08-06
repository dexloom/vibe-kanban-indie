import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { usersApi } from '@/shared/lib/api';
import { userKeys } from '@/shared/hooks/userKeys';
import type { ListUsersResponse, UserWithProfile } from 'shared/types';

/**
 * Tenant-less replacement for `useOrganizationMembers`.
 *
 * ADR-018 — the local-only fork has no org concept, so the assignee
 * dropdown reads all local users from the new `/v1/users` endpoint
 * (mirrors the `fb_users` shape and the `UserWithProfile` wire type).
 *
 * Returns a flat array of `UserWithProfile`. Single global fetch, cached
 * for 5 min via react-query.
 */
export function useUsers() {
  const { isSignedIn } = useAuth();
  return useQuery<ListUsersResponse, unknown, UserWithProfile[]>({
    queryKey: userKeys.list(),
    queryFn: () => usersApi.getUsers(),
    enabled: isSignedIn,
    staleTime: 5 * 60 * 1000,
    select: (data) => data.users,
  });
}
