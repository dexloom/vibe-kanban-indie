import { useState } from 'react';
import { AppBarUserPopover } from '@vibe/ui/components/AppBarUserPopover';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';

export function AppBarUserPopoverContainer() {
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
      organizations={[]}
      selectedOrgId=""
      open={open}
      onOpenChange={setOpen}
      onAvatarError={() => setAvatarError(true)}
      onSettings={handleSettings}
    />
  );
}
