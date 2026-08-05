import { useNavigate } from '@tanstack/react-router';
import { BellIcon, GearIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { SidebarBarButton } from '@vibe/ui/components/SidebarBarButton';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { useNotifications } from '@/shared/hooks/useNotifications';

/**
 * Bottom sidebar bar content (ADR-010): Notifications + Settings buttons,
 * composed from the shared SidebarBarButton and rendered inside the Sidebar's
 * bottom SidebarBar. Lives in web-core because both buttons need app services
 * (notifications hook, settings dialog).
 */
export function SidebarBottomActions() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { unseenCount } = useNotifications();

  return (
    <>
      <SidebarBarButton
        label={t('sidebar.notifications')}
        icon={BellIcon}
        badgeCount={unseenCount}
        badgeClass="bg-brand-secondary text-white"
        onClick={() => navigate({ to: '/notifications' })}
      />
      <SidebarBarButton
        label={t('sidebar.settings')}
        icon={GearIcon}
        onClick={() => SettingsDialog.show()}
      />
    </>
  );
}
