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

  // ADR-018 — no org switcher, no `organizations` / `selectedOrgId` props.
  return (
    <AppBarUserPopover
      avatarUrl={null}
      avatarError={avatarError}
      open={open}
      onOpenChange={setOpen}
      onAvatarError={() => setAvatarError(true)}
      onSettings={handleSettings}
    />
  );
}
