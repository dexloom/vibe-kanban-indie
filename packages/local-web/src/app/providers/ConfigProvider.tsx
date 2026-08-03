import { ReactNode, useCallback, useEffect } from 'react';
import { configApi } from '@/shared/lib/api';
import { updateLanguageFromConfig } from '@/i18n/config';
import { useUserSystemController } from '@/shared/hooks/useUserSystemController';
import { UserSystemContext } from '@/shared/hooks/useUserSystem';

interface UserSystemProviderProps {
  children: ReactNode;
}

export function UserSystemProvider({ children }: UserSystemProviderProps) {
  const loadConfig = useCallback(() => configApi.getConfig(null), []);
  const saveConfig = useCallback(
    (config: Parameters<typeof configApi.saveConfig>[0]) =>
      configApi.saveConfig(config, null),
    []
  );

  const { value } = useUserSystemController({
    queryKey: ['user-system', 'local'],
    load: loadConfig,
    save: saveConfig,
  });

  // Sync language with i18n when config changes
  useEffect(() => {
    if (value.config?.language) {
      updateLanguageFromConfig(value.config.language);
    }
  }, [value.config?.language]);

  return (
    <UserSystemContext.Provider value={value}>
      {children}
    </UserSystemContext.Provider>
  );
}
