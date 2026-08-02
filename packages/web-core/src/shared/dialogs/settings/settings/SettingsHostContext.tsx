import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useAppRuntime, type AppRuntime } from '@/shared/hooks/useAppRuntime';
import {
  createMachineClient,
  type MachineClient,
  type MachineTarget,
} from '@/shared/lib/machineClient';

export type SettingsHostTargetId = 'local' | string;

export type SettingsHostTarget = MachineTarget & {
  description?: string;
  status?: 'online' | 'offline';
};

interface SettingsHostContextValue {
  availableHosts: SettingsHostTarget[];
  hostsResolved: boolean;
  selectedHostId: SettingsHostTargetId | null;
  selectedHost: SettingsHostTarget | null;
  setSelectedHostId: (hostId: SettingsHostTargetId) => void;
}

const SettingsHostContext = createContext<SettingsHostContextValue | null>(
  null
);

function getLocalHostTarget(
  getLabel: (key: string, defaultValue: string) => string
): SettingsHostTarget {
  return {
    id: 'local',
    apiHostId: null,
    label: getLabel('settings.hostPicker.thisMachine', 'This machine'),
    description: getLabel('settings.hostPicker.localHost', 'Local host'),
    kind: 'local',
  };
}

function toLocalRuntimeTargets(
  getLabel: (key: string, defaultValue: string) => string
): SettingsHostTarget[] {
  return [getLocalHostTarget(getLabel)];
}

function getInitialHostId(
  hosts: SettingsHostTarget[],
  _runtime: AppRuntime,
  routeHostId: string | null,
  initialHostId?: SettingsHostTargetId
): SettingsHostTargetId | null {
  if (initialHostId && hosts.some((host) => host.id === initialHostId)) {
    return initialHostId;
  }

  if (routeHostId && hosts.some((host) => host.id === routeHostId)) {
    return routeHostId;
  }

  return hosts.find((host) => host.id === 'local')?.id ?? hosts[0]?.id ?? null;
}

export function SettingsHostProvider({
  initialHostId,
  children,
}: {
  initialHostId?: SettingsHostTargetId;
  children: ReactNode;
}) {
  const { t } = useTranslation('settings');
  const runtime = useAppRuntime();

  const availableHosts = useMemo<SettingsHostTarget[]>(
    () => toLocalRuntimeTargets(t),
    [t]
  );

  const [selectedHostId, setSelectedHostId] =
    useState<SettingsHostTargetId | null>(null);

  const resolvedHostId = useMemo(() => {
    if (
      selectedHostId &&
      availableHosts.some((host) => host.id === selectedHostId)
    ) {
      return selectedHostId;
    }

    return getInitialHostId(availableHosts, runtime, null, initialHostId);
  }, [availableHosts, initialHostId, runtime, selectedHostId]);

  const selectedHost = useMemo(
    () => availableHosts.find((host) => host.id === resolvedHostId) ?? null,
    [availableHosts, resolvedHostId]
  );

  const value = useMemo<SettingsHostContextValue>(
    () => ({
      availableHosts,
      hostsResolved: true,
      selectedHostId: resolvedHostId,
      selectedHost,
      setSelectedHostId,
    }),
    [availableHosts, resolvedHostId, selectedHost]
  );

  return (
    <SettingsHostContext.Provider value={value}>
      {children}
    </SettingsHostContext.Provider>
  );
}

export function useSettingsHost() {
  const context = useContext(SettingsHostContext);
  if (!context) {
    throw new Error(
      'useSettingsHost must be used within a SettingsHostProvider'
    );
  }
  return context;
}

export function useSettingsMachineClient(): MachineClient | null {
  const { selectedHost } = useSettingsHost();

  return useMemo(() => {
    if (!selectedHost) {
      return null;
    }

    return createMachineClient(selectedHost);
  }, [selectedHost]);
}
