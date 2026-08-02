import { useState } from 'react';
import type { OrganizationWithRole } from 'shared/types';
import { AppBarUserPopover } from '@vibe/ui/components/AppBarUserPopover';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { useOrganizationStore } from '@/shared/stores/useOrganizationStore';

interface AppBarUserPopoverContainerProps {
  organizations: OrganizationWithRole[];
  selectedOrgId: string;
  onOrgSelect: (orgId: string) => void;
}

export function AppBarUserPopoverContainer({
  organizations,
  selectedOrgId,
  onOrgSelect,
}: AppBarUserPopoverContainerProps) {
  const setSelectedOrgId = useOrganizationStore((s) => s.setSelectedOrgId);
  const [open, setOpen] = useState(false);
  const [avatarError, setAvatarError] = useState(false);

  const handleOrgSettings = async (orgId: string) => {
    setSelectedOrgId(orgId);
    await SettingsDialog.show({ initialSection: 'organizations' });
  };

  const handleSettings = async () => {
    setOpen(false);
    await SettingsDialog.show();
  };

  return (
    <AppBarUserPopover
      avatarUrl={null}
      avatarError={avatarError}
      organizations={organizations}
      selectedOrgId={selectedOrgId}
      open={open}
      onOpenChange={setOpen}
      onOrgSelect={onOrgSelect}
      onOrgSettings={handleOrgSettings}
      onAvatarError={() => setAvatarError(true)}
      onSettings={handleSettings}
    />
  );
}
