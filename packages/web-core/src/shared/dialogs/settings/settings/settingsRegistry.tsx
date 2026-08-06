import {
  GearIcon,
  GitBranchIcon,
  CpuIcon,
  PlugIcon,
  TelegramLogoIcon,
  FlowArrowIcon,
  ClockCountdownIcon,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { GeneralSettingsSection } from './GeneralSettingsSection';
import { PipelineSettingsSection } from './PipelineSettingsSection';
import { RecurrentSettingsSection } from './RecurrentSettingsSection';
import { ReposSettingsSection } from './ReposSettingsSection';
import { AgentsSettingsSection } from './AgentsSettingsSection';
import { McpSettingsSection } from './McpSettingsSection';
import { TelegramSettingsSection } from './TelegramSettingsSection';

// ADR-018 — `organizations` and `remote-projects` sections are gone.
// Only host-scoped sections remain; the `universal` group is empty.
export type SettingsSectionType =
  | 'general'
  | 'pipeline'
  | 'recurrent'
  | 'repos'
  | 'agents'
  | 'mcp'
  | 'telegram';

export type SettingsSectionGroup = 'host';

export type SettingsSectionInitialState = {
  general: undefined;
  pipeline: undefined;
  recurrent: undefined;
  repos: { repoId?: string } | undefined;
  agents: { executor?: string; variant?: string } | undefined;
  mcp: undefined;
  telegram: undefined;
};

export interface SettingsSectionDefinition {
  id: SettingsSectionType;
  icon: Icon;
  group: SettingsSectionGroup;
}

export const SETTINGS_SECTION_DEFINITIONS: SettingsSectionDefinition[] = [
  { id: 'general', icon: GearIcon, group: 'host' },
  { id: 'pipeline', icon: FlowArrowIcon, group: 'host' },
  { id: 'recurrent', icon: ClockCountdownIcon, group: 'host' },
  { id: 'repos', icon: GitBranchIcon, group: 'host' },
  { id: 'agents', icon: CpuIcon, group: 'host' },
  { id: 'mcp', icon: PlugIcon, group: 'host' },
  { id: 'telegram', icon: TelegramLogoIcon, group: 'host' },
];

export function isHostSpecificSettingsSection(
  type: SettingsSectionType
): boolean {
  return (
    SETTINGS_SECTION_DEFINITIONS.find((section) => section.id === type)
      ?.group === 'host'
  );
}

export function renderSettingsSection(
  type: SettingsSectionType,
  initialState?: SettingsSectionInitialState[SettingsSectionType],
  onClose?: () => void
) {
  switch (type) {
    case 'general':
      return <GeneralSettingsSection />;
    case 'pipeline':
      return <PipelineSettingsSection />;
    case 'recurrent':
      return <RecurrentSettingsSection onClose={onClose} />;
    case 'repos':
      return (
        <ReposSettingsSection
          initialState={initialState as SettingsSectionInitialState['repos']}
        />
      );
    case 'agents':
      return <AgentsSettingsSection />;
    case 'mcp':
      return <McpSettingsSection />;
    case 'telegram':
      return <TelegramSettingsSection />;
    default:
      return <GeneralSettingsSection />;
  }
}
