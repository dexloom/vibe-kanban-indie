import { useEffect } from 'react';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { getFirstProjectDestination } from '@/shared/lib/firstProjectDestination';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';

export function RootRedirectPage() {
  const { config, loading } = useUserSystem();
  const appNavigation = useAppNavigation();

  useEffect(() => {
    if (loading || !config) {
      return;
    }

    let isActive = true;
    void (async () => {
      if (!config.remote_onboarding_acknowledged) {
        appNavigation.goToOnboarding({ replace: true });
        return;
      }

      // Read saved selections imperatively to avoid re-triggering this effect
      // when the scratch store initializes from the server
      const { selectedProjectId } = useUiPreferencesStore.getState();

      // ADR-018 — projects are tenant-less, so the `savedOrgId` arg is
      // dropped. Only the saved project id is consulted.
      const destination = await getFirstProjectDestination(
        undefined,
        selectedProjectId
      );
      if (!isActive) {
        return;
      }

      if (destination?.kind === 'project') {
        appNavigation.goToProject(destination.projectId, { replace: true });
        return;
      }

      appNavigation.goToWorkspacesCreate({ replace: true });
    })();

    return () => {
      isActive = false;
    };
  }, [appNavigation, config, loading]);

  return (
    <div className="h-screen bg-primary flex items-center justify-center">
      <p className="text-low">Loading...</p>
    </div>
  );
}
