import { useMemo } from 'react';
import type { UserWithProfile } from 'shared/types';
import { useUsers } from '@/shared/hooks/useUsers';

/**
 * ADR-018 — tenant-less user roster for notification members.
 *
 * Notifications no longer carry an `organization_id`, so we no longer
 * fan out per-org member queries. A single `useUsers` call covers all
 * notifications in the list.
 */
export function useNotificationMembers(_notifications: unknown[]) {
  const usersQuery = useUsers();
  const membersByUserId = useMemo(() => {
    const map = new Map<string, UserWithProfile>();
    for (const user of usersQuery.data ?? []) {
      map.set(user.user_id, user);
    }
    return map;
  }, [usersQuery.data]);

  return {
    membersByUserId,
    isLoading: usersQuery.isLoading,
    isFetching: usersQuery.isFetching,
    isError: usersQuery.isError,
  };
}
