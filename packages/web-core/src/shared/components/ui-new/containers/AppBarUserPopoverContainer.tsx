import { useState } from 'react';
import type { OrganizationWithRole } from 'shared/types';
import { AppBarUserPopover } from '@vibe/ui/components/AppBarUserPopover';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';

interface AppBarUserPopoverContainerProps {
  organizations: OrganizationWithRole[];
  selectedOrgId: string;
}

export function AppBarUserPopoverContainer({
  organizations,
  selectedOrgId,
}: AppBarUserPopoverContainerProps) {
  const [open, setOpen] = useState(false);
  const [avatarError, setAvatarError] = useState(false);

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
      onAvatarError={() => setAvatarError(true)}
      onSettings={handleSettings}
    />
  );
}
