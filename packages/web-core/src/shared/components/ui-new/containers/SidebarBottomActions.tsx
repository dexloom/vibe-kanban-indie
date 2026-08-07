import { GearIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { SidebarBarButton } from '@vibe/ui/components/SidebarBarButton';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';

/**
 * Bottom sidebar bar content (ADR-010). ADR-019: the kanban notifications
 * bell/badge was removed (the User entity it surfaced has been excised).
 * Only Settings remains here.
 */
export function SidebarBottomActions() {
  const { t } = useTranslation('common');

  return (
    <>
      <SidebarBarButton
        label={t('sidebar.settings')}
        icon={GearIcon}
        onClick={() => SettingsDialog.show()}
      />
    </>
  );
}
